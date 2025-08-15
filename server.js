const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
const PORT = 3000;

// Cấu hình API và các hằng số
const API_URL = 'https://api.wsktnus8.net/v2/history/getLastResult?gameId=ktrng_3979&size=100&tableId=39791215743193&curPage=1';
const UPDATE_INTERVAL = 5000; // 5 giây
const HISTORY_FILE = path.join(__dirname, 'prediction_history.json');

let historyData = [];
let lastPrediction = {
    phien: null,
    du_doan: null,
    doan_vi: [],
    do_tin_cay: 0,
    reason: ""
};
let modelPredictions = {};

// --- HÀM HỖ TRỢ ---

function loadPredictionHistory() {
    try {
        if (fs.existsSync(HISTORY_FILE)) {
            const raw = fs.readFileSync(HISTORY_FILE, 'utf8');
            return JSON.parse(raw);
        }
    } catch (e) {
        console.error('Lỗi đọc lịch sử dự đoán:', e.message);
    }
    return [];
}

function savePredictionHistory(data) {
    try {
        fs.writeFileSync(HISTORY_FILE, JSON.stringify(data, null, 2));
    } catch (e) {
        console.error('Lỗi lưu lịch sử dự đoán:', e.message);
    }
}

function appendPredictionHistory(record) {
    const all = loadPredictionHistory();
    all.push(record);
    savePredictionHistory(all);
}

async function updateHistory() {
    try {
        const res = await axios.get(API_URL);
        if (res?.data?.data?.resultList) {
            historyData = res.data.data.resultList;
            // Chuyển đổi dữ liệu API về định dạng mới
            historyData = historyData.map(item => ({
                session: item.gameNum,
                result: getResultType(item),
                totalScore: item.score
            }));
        }
    } catch (e) {
        console.error('Lỗi cập nhật:', e.message);
    }
}

function getResultType(session) {
    if (!session || !session.facesList) return "";
    const [a, b, c] = session.facesList;
    if (a === b && b === c) return "Bão";
    return session.score >= 11 ? "Tài" : "Xỉu";
}

function generatePattern(history, len = 10) {
    if (!history.length) return "";
    return history.slice(0, len).map(s => s.result.charAt(0)).reverse().join('');
}

// --- CÁC THUẬT TOÁN DỰ ĐOÁN NÂNG CAO MỚI ---
function detectStreakAndBreak(history) {
    if (!history || history.length === 0) return { streak: 0, currentResult: null, breakProb: 0.0 };
    let streak = 1;
    const currentResult = history[0].result;
    for (let i = 1; i < history.length; i++) {
        if (history[i].result === currentResult) {
            streak++;
        } else {
            break;
        }
    }
    const last15 = history.slice(0, 15);
    if (!last15.length) return { streak, currentResult, breakProb: 0.0 };
    const switches = last15.slice(1).reduce((count, curr, idx) => count + (curr.result !== last15[idx].result ? 1 : 0), 0);
    const taiCount = last15.filter(r => r.result === 'Tài').length;
    const xiuCount = last15.filter(r => r.result === 'Xỉu').length;
    const imbalance = Math.abs(taiCount - xiuCount) / last15.length;
    let breakProb = 0.0;

    if (streak >= 6) {
        breakProb = Math.min(0.8 + (switches / 15) + imbalance * 0.3, 0.95);
    } else if (streak >= 4) {
        breakProb = Math.min(0.5 + (switches / 12) + imbalance * 0.25, 0.9);
    } else if (streak >= 2 && switches >= 5) {
        breakProb = 0.45;
    } else if (streak === 1 && switches >= 6) {
        breakProb = 0.3;
    }

    return { streak, currentResult, breakProb };
}

function evaluateModelPerformance(history, modelName, lookback = 10) {
    if (!modelPredictions[modelName] || history.length < 2) return 1.0;
    lookback = Math.min(lookback, history.length - 1);
    let correctCount = 0;
    for (let i = 0; i < lookback; i++) {
        const actual = history[i].result;
        const pred = modelPredictions[modelName][history[i+1].session] || null;
        if (pred && ((pred === 'Tài' && actual === 'Tài') || (pred === 'Xỉu' && actual === 'Xỉu'))) {
            correctCount++;
        }
    }
    const performanceScore = lookback > 0 ? 1.0 + (correctCount - lookback / 2) / (lookback / 2) : 1.0;
    return Math.max(0.0, Math.min(2.0, performanceScore));
}

function smartBridgeBreak(history) {
    if (!history || history.length < 5) return { prediction: 'Tài', breakProb: 0.0, reason: 'Không đủ dữ liệu để theo/bẻ cầu' };

    const { streak, currentResult, breakProb } = detectStreakAndBreak(history);
    const last20 = history.slice(0, 20);
    const lastScores = last20.map(h => h.totalScore || 0);
    let breakProbability = breakProb;
    let reason = '';

    const avgScore = lastScores.reduce((sum, score) => sum + score, 0) / (lastScores.length || 1);
    const scoreDeviation = lastScores.reduce((sum, score) => sum + Math.abs(score - avgScore), 0) / (lastScores.length || 1);

    const last5 = last20.slice(0, 5);
    const patternCounts = {};
    for (let i = 0; i <= last20.length - 2; i++) {
        const pattern = last20.slice(i, i + 2).map(h => h.result).join(',');
        patternCounts[pattern] = (patternCounts[pattern] || 0) + 1;
    }
    const mostCommonPattern = Object.entries(patternCounts).sort((a, b) => b[1] - a[1])[0];
    const isStablePattern = mostCommonPattern && mostCommonPattern[1] >= 3;

    if (streak >= 3 && scoreDeviation < 2.0 && !isStablePattern) {
        breakProbability = Math.max(breakProbability - 0.25, 0.1);
        reason = `[Theo Cầu Thông Minh] Chuỗi ${streak} ${currentResult} ổn định, tiếp tục theo cầu`;
    } else if (streak >= 6) {
        breakProbability = Math.min(breakProbability + 0.3, 0.95);
        reason = `[Bẻ Cầu Thông Minh] Chuỗi ${streak} ${currentResult} quá dài, khả năng bẻ cầu cao`;
    } else if (streak >= 3 && scoreDeviation > 3.5) {
        breakProbability = Math.min(breakProbability + 0.25, 0.9);
        reason = `[Bẻ Cầu Thông Minh] Biến động điểm số lớn (${scoreDeviation.toFixed(1)}), khả năng bẻ cầu tăng`;
    } else if (isStablePattern && last5.every(r => r.result === currentResult)) {
        breakProbability = Math.min(breakProbability + 0.2, 0.85);
        reason = `[Bẻ Cầu Thông Minh] Phát hiện mẫu lặp ${mostCommonPattern[0]}, có khả năng bẻ cầu`;
    } else {
        breakProbability = Math.max(breakProbability - 0.2, 0.1);
        reason = `[Theo Cầu Thông Minh] Không phát hiện mẫu bẻ mạnh, tiếp tục theo cầu`;
    }

    let prediction = breakProbability > 0.5 ? (currentResult === 'Tài' ? 'Xỉu' : 'Tài') : (currentResult === 'Tài' ? 'Tài' : 'Xỉu');
    return { prediction, breakProb: breakProbability, reason };
}

function trendAndProb(history) {
    const { streak, currentResult, breakProb } = detectStreakAndBreak(history);
    if (streak >= 3) {
        if (breakProb > 0.6) {
            return currentResult === 'Tài' ? 'Xỉu' : 'Tài';
        }
        return currentResult === 'Tài' ? 'Tài' : 'Xỉu';
    }
    const last15 = history.slice(0, 15);
    if (!last15.length) return 'Tài';
    const weights = last15.map((_, i) => Math.pow(1.3, last15.length - 1 - i));
    const taiWeighted = weights.reduce((sum, w, i) => sum + (last15[i].result === 'Tài' ? w : 0), 0);
    const xiuWeighted = weights.reduce((sum, w, i) => sum + (last15[i].result === 'Xỉu' ? w : 0), 0);
    const totalWeight = taiWeighted + xiuWeighted;
    const last10 = last15.slice(0, 10);
    const patterns = [];
    if (last10.length >= 4) {
        for (let i = 0; i <= last10.length - 4; i++) {
            patterns.push(last10.slice(i, i + 4).map(h => h.result).join(','));
        }
    }
    const patternCounts = patterns.reduce((acc, p) => { acc[p] = (acc[p] || 0) + 1; return acc; }, {});
    const mostCommon = Object.entries(patternCounts).sort((a, b) => b[1] - a[1])[0];
    if (mostCommon && mostCommon[1] >= 3) {
        const pattern = mostCommon[0].split(',');
        return pattern[pattern.length - 1] !== last10[0].result ? 'Tài' : 'Xỉu';
    } else if (totalWeight > 0 && Math.abs(taiWeighted - xiuWeighted) / totalWeight >= 0.25) {
        return taiWeighted > xiuWeighted ? 'Tài' : 'Xỉu';
    }
    return last15[0].result === 'Xỉu' ? 'Tài' : 'Xỉu';
}

function shortPattern(history) {
    const { streak, currentResult, breakProb } = detectStreakAndBreak(history);
    if (streak >= 2) {
        if (breakProb > 0.6) {
            return currentResult === 'Tài' ? 'Xỉu' : 'Tài';
        }
        return currentResult === 'Tài' ? 'Tài' : 'Xỉu';
    }
    const last8 = history.slice(0, 8);
    if (!last8.length) return 'Tài';
    const patterns = [];
    if (last8.length >= 2) {
        for (let i = 0; i <= last8.length - 2; i++) {
            patterns.push(last8.slice(i, i + 2).map(h => h.result).join(','));
        }
    }
    const patternCounts = patterns.reduce((acc, p) => { acc[p] = (acc[p] || 0) + 1; return acc; }, {});
    const mostCommon = Object.entries(patternCounts).sort((a, b) => b[1] - a[1])[0];
    if (mostCommon && mostCommon[1] >= 2) {
        const pattern = mostCommon[0].split(',');
        return pattern[pattern.length - 1] !== last8[0].result ? 'Tài' : 'Xỉu';
    }
    return last8[0].result === 'Xỉu' ? 'Tài' : 'Xỉu';
}

function meanDeviation(history) {
    const { streak, currentResult, breakProb } = detectStreakAndBreak(history);
    if (streak >= 2) {
        if (breakProb > 0.6) {
            return currentResult === 'Tài' ? 'Xỉu' : 'Tài';
        }
        return currentResult === 'Tài' ? 'Tài' : 'Xỉu';
    }
    const last12 = history.slice(0, 12);
    if (!last12.length) return 'Tài';
    const taiCount = last12.filter(r => r.result === 'Tài').length;
    const xiuCount = last12.length - taiCount;
    const deviation = Math.abs(taiCount - xiuCount) / last12.length;
    if (deviation < 0.2) {
        return last12[0].result === 'Xỉu' ? 'Tài' : 'Xỉu';
    }
    return xiuCount > taiCount ? 'Tài' : 'Xỉu';
}

function recentSwitch(history) {
    const { streak, currentResult, breakProb } = detectStreakAndBreak(history);
    if (streak >= 2) {
        if (breakProb > 0.6) {
            return currentResult === 'Tài' ? 'Xỉu' : 'Tài';
        }
        return currentResult === 'Tài' ? 'Tài' : 'Xỉu';
    }
    const last10 = history.slice(0, 10);
    if (!last10.length) return 'Tài';
    const switches = last10.slice(1).reduce((count, curr, idx) => count + (curr.result !== last10[idx].result ? 1 : 0), 0);
    return switches >= 4 ? (last10[0].result === 'Xỉu' ? 'Tài' : 'Xỉu') : (last10[0].result === 'Xỉu' ? 'Tài' : 'Xỉu');
}

function isBadPattern(history) {
    const last15 = history.slice(0, 15);
    if (!last15.length) return false;
    const switches = last15.slice(1).reduce((count, curr, idx) => count + (curr.result !== last15[idx].result ? 1 : 0), 0);
    const { streak } = detectStreakAndBreak(history);
    return switches >= 6 || streak >= 7;
}

function aiHtddLogic(history) {
    const recentHistory = history.slice(0, 5);
    const recentScores = recentHistory.map(h => h.totalScore || 0);
    const taiCount = recentHistory.filter(r => r.result === 'Tài').length;
    const xiuCount = recentHistory.filter(r => r.result === 'Xỉu').length;
    const { streak, currentResult } = detectStreakAndBreak(history);

    if (streak >= 2 && streak <= 4) {
        return { 
            prediction: currentResult, 
            reason: `[Theo Cầu Thông Minh] Chuỗi ngắn ${streak} ${currentResult}, tiếp tục theo cầu`, 
            source: 'AI HTDD' 
        };
    }

    if (history.length >= 3) {
        const last3 = history.slice(0, 3).map(h => h.result);
        if (last3.join(',') === 'Tài,Xỉu,Tài') {
            return { prediction: 'Xỉu', reason: '[Bẻ Cầu Thông Minh] Phát hiện mẫu 1T1X → tiếp theo nên đánh Xỉu', source: 'AI HTDD' };
        } else if (last3.join(',') === 'Xỉu,Tài,Xỉu') {
            return { prediction: 'Tài', reason: '[Bẻ Cầu Thông Minh] Phát hiện mẫu 1X1T → tiếp theo nên đánh Tài', source: 'AI HTDD' };
        }
    }

    if (history.length >= 4) {
        const last4 = history.slice(0, 4).map(h => h.result);
        if (last4.join(',') === 'Tài,Tài,Xỉu,Xỉu') {
            return { prediction: 'Tài', reason: '[Theo Cầu Thông Minh] Phát hiện mẫu 2T2X → tiếp theo nên đánh Tài', source: 'AI HTDD' };
        } else if (last4.join(',') === 'Xỉu,Xỉu,Tài,Tài') {
            return { prediction: 'Xỉu', reason: '[Theo Cầu Thông Minh] Phát hiện mẫu 2X2T → tiếp theo nên đánh Xỉu', source: 'AI HTDD' };
        }
    }

    if (history.length >= 7 && history.slice(0, 7).every(h => h.result === 'Xỉu')) {
        return { prediction: 'Tài', reason: '[Bẻ Cầu Thông Minh] Chuỗi Xỉu quá dài (7 lần) → dự đoán Tài', source: 'AI HTDD' };
    } else if (history.length >= 7 && history.slice(0, 7).every(h => h.result === 'Tài')) {
        return { prediction: 'Xỉu', reason: '[Bẻ Cầu Thông Minh] Chuỗi Tài quá dài (7 lần) → dự đoán Xỉu', source: 'AI HTDD' };
    }

    const avgScore = recentScores.reduce((sum, score) => sum + score, 0) / (recentScores.length || 1);
    if (avgScore > 11) {
        return { prediction: 'Tài', reason: `[Theo Cầu Thông Minh] Điểm trung bình cao (${avgScore.toFixed(1)}) → dự đoán Tài`, source: 'AI HTDD' };
    } else if (avgScore < 7) {
        return { prediction: 'Xỉu', reason: `[Theo Cầu Thông Minh] Điểm trung bình thấp (${avgScore.toFixed(1)}) → dự đoán Xỉu`, source: 'AI HTDD' };
    }

    if (taiCount > xiuCount + 1) {
        return { prediction: 'Xỉu', reason: `[Bẻ Cầu Thông Minh] Tài chiếm đa số (${taiCount}/${recentHistory.length}) → dự đoán Xỉu`, source: 'AI HTDD' };
    } else if (xiuCount > taiCount + 1) {
        return { prediction: 'Tài', reason: `[Bẻ Cầu Thông Minh] Xỉu chiếm đa số (${xiuCount}/${recentHistory.length}) → dự đoán Tài`, source: 'AI HTDD' };
    } else {
        const overallTai = history.filter(h => h.result === 'Tài').length;
        const overallXiu = history.filter(h => h.result === 'Xỉu').length;
        if (overallTai > overallXiu) {
            return { prediction: 'Xỉu', reason: '[Bẻ Cầu Thông Minh] Tổng thể Tài nhiều hơn → dự đoán Xỉu', source: 'AI HTDD' };
        } else {
            return { prediction: 'Tài', reason: '[Theo Cầu Thông Minh] Tổng thể Xỉu nhiều hơn hoặc bằng → dự đoán Tài', source: 'AI HTDD' };
        }
    }
}

function predictTopSums(history, prediction, top = 3) {
    const relevantHistory = history.filter(item => item.result === prediction);

    if (relevantHistory.length < 5) {
        return prediction === "Tài" ? [12, 13, 14] : [9, 8, 7];
    }

    const weightedFreq = {};
    relevantHistory.forEach((item, index) => {
        const score = item.totalScore;
        const weight = Math.exp(-0.2 * index);
        weightedFreq[score] = (weightedFreq[score] || 0) + weight;
    });

    const sortedSums = Object.entries(weightedFreq)
        .sort(([, a], [, b]) => b - a)
        .map(([sum]) => parseInt(sum));

    const finalSums = sortedSums.slice(0, top);
    while (finalSums.length < top) {
        const fallbackRange = prediction === "Tài" ? [11, 12, 13, 14, 15, 16, 17] : [4, 5, 6, 7, 8, 9, 10];
        const randomSum = fallbackRange[Math.floor(Math.random() * fallbackRange.length)];
        if (!finalSums.includes(randomSum)) {
            finalSums.push(randomSum);
        }
    }

    return finalSums;
}

function generatePrediction(history) {
    if (!history || history.length < 5) {
        const randomResult = Math.random() < 0.5 ? 'Tài' : 'Xỉu';
        return { prediction: randomResult, do_tin_cay: 0, reason: "Không đủ dữ liệu." };
    }

    if (!modelPredictions['trend']) {
        modelPredictions['trend'] = {};
        modelPredictions['short'] = {};
        modelPredictions['mean'] = {};
        modelPredictions['switch'] = {};
        modelPredictions['bridge'] = {};
    }

    const currentIndex = history[0].session;

    const trendPred = trendAndProb(history);
    const shortPred = shortPattern(history);
    const meanPred = meanDeviation(history);
    const switchPred = recentSwitch(history);
    const bridgePred = smartBridgeBreak(history);
    const aiPred = aiHtddLogic(history);

    modelPredictions['trend'][currentIndex] = trendPred;
    modelPredictions['short'][currentIndex] = shortPred;
    modelPredictions['mean'][currentIndex] = meanPred;
    modelPredictions['switch'][currentIndex] = switchPred;
    modelPredictions['bridge'][currentIndex] = bridgePred.prediction;

    const modelScores = {
        trend: evaluateModelPerformance(history, 'trend'),
        short: evaluateModelPerformance(history, 'short'),
        mean: evaluateModelPerformance(history, 'mean'),
        switch: evaluateModelPerformance(history, 'switch'),
        bridge: evaluateModelPerformance(history, 'bridge')
    };

    const { streak, breakProb } = detectStreakAndBreak(history);

    const weights = {
        trend: streak >= 3 ? 0.15 * modelScores.trend : 0.2 * modelScores.trend,
        short: streak >= 2 ? 0.2 * modelScores.short : 0.15 * modelScores.short,
        mean: 0.1 * modelScores.mean,
        switch: 0.1 * modelScores.switch,
        bridge: streak >= 3 ? 0.35 * modelScores.bridge : 0.3 * modelScores.bridge,
        aihtdd: streak >= 2 ? 0.3 : 0.25
    };

    let taiScore = 0;
    let xiuScore = 0;

    if (trendPred === 'Tài') taiScore += weights.trend; else if (trendPred === 'Xỉu') xiuScore += weights.trend;
    if (shortPred === 'Tài') taiScore += weights.short; else if (shortPred === 'Xỉu') xiuScore += weights.short;
    if (meanPred === 'Tài') taiScore += weights.mean; else if (meanPred === 'Xỉu') xiuScore += weights.mean;
    if (switchPred === 'Tài') taiScore += weights.switch; else if (switchPred === 'Xỉu') xiuScore += weights.switch;
    if (bridgePred.prediction === 'Tài') taiScore += weights.bridge; else if (bridgePred.prediction === 'Xỉu') xiuScore += weights.bridge;
    if (aiPred.prediction === 'Tài') taiScore += weights.aihtdd; else xiuScore += weights.aihtdd;

    if (isBadPattern(history)) {
        taiScore *= 0.5;
        xiuScore *= 0.5;
    }

    if (breakProb > 0.5) {
        if (bridgePred.prediction === 'Tài') taiScore += 0.4; else xiuScore += 0.4;
    } else if (streak >= 3) {
        if (bridgePred.prediction === 'Tài') taiScore += 0.35; else xiuScore += 0.35;
    }

    const totalScore = taiScore + xiuScore;
    const confidence = totalScore > 0 ? (taiScore > xiuScore ? taiScore / totalScore : xiuScore / totalScore) : 0;
    const finalPrediction = taiScore > xiuScore ? 'Tài' : 'Xỉu';
    const reason = `${aiPred.reason} | ${bridgePred.reason}`;

    return {
        prediction: finalPrediction,
        do_tin_cay: (confidence * 100).toFixed(2) + "%",
        reason
    };
}


// --- CÁC ROUTE CỦA SERVER ---
app.post('/report-result', (req, res) => {
    const { phien, ket_qua_thuc } = req.body;
    if (!phien || !ket_qua_thuc) {
        return res.status(400).json({ error: "Thiếu phien hoặc ket_qua_thuc" });
    }

    const predHist = loadPredictionHistory();
    const lastPred = predHist.find(p => p.phien === phien);
    if (!lastPred) return res.status(404).json({ error: "Không tìm thấy dự đoán phiên này" });

    lastPred.ket_qua_thuc = ket_qua_thuc;
    savePredictionHistory(predHist);
    res.json({ success: true });
});

app.get('/predict', async (req, res) => {
    await updateHistory();
    const latest = historyData[0] || {};
    const currentPhien = latest.session;

    if (currentPhien !== lastPrediction.phien) {
        const { prediction, do_tin_cay, reason } = generatePrediction(historyData);
        const doan_vi = predictTopSums(historyData, prediction, 3);

        lastPrediction = {
            phien: currentPhien,
            du_doan: prediction,
            doan_vi: doan_vi,
            do_tin_cay: do_tin_cay,
            reason: reason
        };

        appendPredictionHistory({
            phien: currentPhien,
            du_doan: prediction,
            doan_vi: doan_vi,
            do_tin_cay: do_tin_cay,
            reason: reason,
            ket_qua_thuc: null,
            timestamp: Date.now()
        });
    }

    const nextPhien = currentPhien ? parseInt(currentPhien.replace('#', '')) + 1 : 0;
    const latestOriginal = (await axios.get(API_URL)).data.data.resultList[0];

    res.json({
        Id: "binhtool90",
        Phien: nextPhien,
        Xuc_xac_1: latestOriginal?.facesList?.[0] || 0,
        Xuc_xac_2: latestOriginal?.facesList?.[1] || 0,
        Xuc_xac_3: latestOriginal?.facesList?.[2] || 0,
        Tong: latestOriginal?.score || 0,
        Ket_qua: getResultType(latestOriginal),
        phien_hien_tai: currentPhien,
        du_doan: lastPrediction.du_doan,
        dudoan_vi: lastPrediction.doan_vi.join(", "),
        do_tin_cay: lastPrediction.do_tin_cay,
        Ghi_chu: lastPrediction.reason
    });
});

// --- KHỞI ĐỘNG SERVER ---
app.listen(PORT, () => {
    console.log(`🤖 Server AI dự đoán chạy tại http://localhost:${PORT}`);
    updateHistory();
    setInterval(updateHistory, UPDATE_INTERVAL);
});

