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
    session: item.gameNum.replace('#', ''), // Xóa dấu #
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

// --- CÁC THUẬT TOÁN DỰ ĐOÁN MỚI VÀ ĐÃ TỐI ƯU ---

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
    
    // Adjusted logic based on user's new algorithm description
    if (streak >= 8) {
        breakProb = Math.min(0.6 + (switches / 15) + imbalance * 0.15, 0.9);
    } else if (streak >= 5) {
        breakProb = Math.min(0.35 + (switches / 10) + imbalance * 0.25, 0.85);
    } else if (streak >= 3 && switches >= 7) {
        breakProb = 0.3;
    } else if (streak === 1) {
        breakProb = switches >= 6 ? 0.4 : 0.1;
    }

    return { streak, currentResult, breakProb };
}

function smartBridgeBreak(history) {
    if (!history || history.length < 3) return { prediction: 'Xỉu', breakProb: 0.0, reason: 'Không đủ dữ liệu để bẻ cầu' };

    const { streak, currentResult, breakProb } = detectStreakAndBreak(history);
    const last20 = history.slice(0, 20);
    const lastScores = last20.map(h => h.totalScore || 0);
    let breakProbability = breakProb;
    let reason = '';

    const avgScore = lastScores.reduce((sum, score) => sum + score, 0) / (lastScores.length || 1);
    const scoreDeviation = lastScores.reduce((sum, score) => sum + Math.abs(score - avgScore), 0) / (lastScores.length || 1);

    const patternCounts = {};
    for (let i = 0; i <= last20.length - 3; i++) {
        const pattern = last20.slice(i, i + 3).map(h => h.result).join(',');
        patternCounts[pattern] = (patternCounts[pattern] || 0) + 1;
    }
    const mostCommonPattern = Object.entries(patternCounts).sort((a, b) => b[1] - a[1])[0];
    const isStablePattern = mostCommonPattern && mostCommonPattern[1] >= 3;

    if (streak >= 6) {
        breakProbability = Math.min(breakProbability + 0.15, 0.9);
        reason = `[Bẻ Cầu] Chuỗi ${streak} ${currentResult} dài, khả năng bẻ cầu cao`;
    } else if (streak >= 4 && scoreDeviation > 3) {
        breakProbability = Math.min(breakProbability + 0.1, 0.85);
        reason = `[Bẻ Cầu] Biến động điểm số lớn (${scoreDeviation.toFixed(1)}), khả năng bẻ cầu tăng`;
    } else if (isStablePattern) {
        breakProbability = Math.min(breakProbability + 0.05, 0.8);
        reason = `[Bẻ Cầu] Phát hiện mẫu lặp ${mostCommonPattern[0]}, có khả năng bẻ cầu`;
    } else {
        breakProbability = Math.max(breakProbability - 0.15, 0.15);
        reason = `[Bẻ Cầu] Không phát hiện mẫu bẻ cầu mạnh, tiếp tục theo cầu`;
    }

    let prediction = breakProbability > 0.65 ? (currentResult === 'Tài' ? 'Xỉu' : 'Tài') : (currentResult === 'Tài' ? 'Tài' : 'Xỉu');
    return { prediction, breakProb: breakProbability, reason };
}

function trendAndProb(history) {
    if (!history || history.length < 3) return null;
    const { streak, currentResult, breakProb } = detectStreakAndBreak(history);
    if (streak >= 5) {
        if (breakProb > 0.75) {
            return currentResult === 'Tài' ? 'Xỉu' : 'Tài';
        }
        return currentResult === 'Tài' ? 'Tài' : 'Xỉu';
    }
    const last15 = history.slice(0, 15);
    if (!last15.length) return null;
    const weights = last15.map((_, i) => Math.pow(1.2, 14 - i));
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
        return pattern[pattern.length - 1] === 'Tài' ? 'Xỉu' : 'Tài';
    } else if (totalWeight > 0 && Math.abs(taiWeighted - xiuWeighted) / totalWeight >= 0.25) {
        return taiWeighted > xiuWeighted ? 'Xỉu' : 'Tài';
    }
    return last15[0].result === 'Xỉu' ? 'Tài' : 'Xỉu';
}

function shortPattern(history) {
    if (!history || history.length < 3) return null;
    const { streak, currentResult, breakProb } = detectStreakAndBreak(history);
    if (streak >= 4) {
        if (breakProb > 0.75) {
            return currentResult === 'Tài' ? 'Xỉu' : 'Tài';
        }
        return currentResult === 'Tài' ? 'Tài' : 'Xỉu';
    }
    const last8 = history.slice(0, 8);
    if (!last8.length) return null;
    const patterns = [];
    if (last8.length >= 3) {
        for (let i = 0; i <= last8.length - 3; i++) {
            patterns.push(last8.slice(i, i + 3).map(h => h.result).join(','));
        }
    }
    const patternCounts = patterns.reduce((acc, p) => { acc[p] = (acc[p] || 0) + 1; return acc; }, {});
    const mostCommon = Object.entries(patternCounts).sort((a, b) => b[1] - a[1])[0];
    if (mostCommon && mostCommon[1] >= 2) {
        const pattern = mostCommon[0].split(',');
        return pattern[pattern.length - 1] === 'Tài' ? 'Xỉu' : 'Tài';
    }
    return last8[0].result === 'Xỉu' ? 'Tài' : 'Xỉu';
}

function meanDeviation(history) {
    if (!history || history.length < 3) return null;
    const { streak, currentResult, breakProb } = detectStreakAndBreak(history);
    if (streak >= 4) {
        if (breakProb > 0.75) {
            return currentResult === 'Tài' ? 'Xỉu' : 'Tài';
        }
        return currentResult === 'Tài' ? 'Tài' : 'Xỉu';
    }
    const last12 = history.slice(0, 12);
    if (!last12.length) return null;
    const taiCount = last12.filter(r => r.result === 'Tài').length;
    const xiuCount = last12.length - taiCount;
    const deviation = Math.abs(taiCount - xiuCount) / last12.length;
    if (deviation < 0.35) {
        return last12[0].result === 'Xỉu' ? 'Tài' : 'Xỉu';
    }
    return xiuCount > taiCount ? 'Tài' : 'Xỉu';
}

function recentSwitch(history) {
    if (!history || history.length < 3) return null;
    const { streak, currentResult, breakProb } = detectStreakAndBreak(history);
    if (streak >= 4) {
        if (breakProb > 0.75) {
            return currentResult === 'Tài' ? 'Xỉu' : 'Tài';
        }
        return currentResult === 'Tài' ? 'Tài' : 'Xỉu';
    }
    const last10 = history.slice(0, 10);
    if (!last10.length) return null;
    const switches = last10.slice(1).reduce((count, curr, idx) => count + (curr.result !== last10[idx].result ? 1 : 0), 0);
    return switches >= 6 ? (last10[0].result === 'Xỉu' ? 'Tài' : 'Xỉu') : (last10[0].result === 'Xỉu' ? 'Tài' : 'Xỉu');
}

function aiHtddLogic(history) {
    if (!history || history.length < 3) {
        return { prediction: Math.random() < 0.5 ? 'Tài' : 'Xỉu', reason: '[AI] Lịch sử ngắn, dự đoán ngẫu nhiên', source: 'AI HTDD' };
    }
    const recentHistory = history.slice(0, 5);
    const recentScores = recentHistory.map(h => h.totalScore || 0);
    const taiCount = recentHistory.filter(r => r.result === 'Tài').length;
    const xiuCount = recentHistory.filter(r => r.result === 'Xỉu').length;
    
    if (history.length >= 3) {
        const last3 = history.slice(0, 3).map(h => h.result);
        if (last3.join(',') === 'Tài,Xỉu,Tài') return { prediction: 'Xỉu', reason: '[AI] Mẫu 1T1X', source: 'AI HTDD' };
        if (last3.join(',') === 'Xỉu,Tài,Xỉu') return { prediction: 'Tài', reason: '[AI] Mẫu 1X1T', source: 'AI HTDD' };
    }
    if (history.length >= 4) {
        const last4 = history.slice(0, 4).map(h => h.result);
        if (last4.join(',') === 'Tài,Tài,Xỉu,Xỉu') return { prediction: 'Tài', reason: '[AI] Mẫu 2T2X', source: 'AI HTDD' };
        if (last4.join(',') === 'Xỉu,Xỉu,Tài,Tài') return { prediction: 'Xỉu', reason: '[AI] Mẫu 2X2T', source: 'AI HTDD' };
    }
    if (history.length >= 9 && history.slice(0, 6).every(h => h.result === 'Tài')) return { prediction: 'Xỉu', reason: '[AI] Chuỗi Tài quá dài (6)', source: 'AI HTDD' };
    if (history.length >= 9 && history.slice(0, 6).every(h => h.result === 'Xỉu')) return { prediction: 'Tài', reason: '[AI] Chuỗi Xỉu quá dài (6)', source: 'AI HTDD' };
    const avgScore = recentScores.reduce((sum, score) => sum + score, 0) / (recentScores.length || 1);
    if (avgScore > 10) return { prediction: 'Tài', reason: `[AI] Điểm trung bình cao (${avgScore.toFixed(1)})`, source: 'AI HTDD' };
    if (avgScore < 8) return { prediction: 'Xỉu', reason: `[AI] Điểm trung bình thấp (${avgScore.toFixed(1)})`, source: 'AI HTDD' };
    const overallTai = history.filter(h => h.result === 'Tài').length;
    const overallXiu = history.filter(h => h.result === 'Xỉu').length;
    if (overallTai > overallXiu + 2) return { prediction: 'Xỉu', reason: '[AI] Tổng thể Tài nhiều hơn', source: 'AI HTDD' };
    if (overallXiu > overallTai + 2) return { prediction: 'Tài', reason: '[AI] Tổng thể Xỉu nhiều hơn', source: 'AI HTDD' };

    return { prediction: Math.random() < 0.5 ? 'Tài' : 'Xỉu', reason: '[AI] Cân bằng', source: 'AI HTDD' };
}

function generatePrediction(history) {
    if (!history || history.length < 5) {
        const randomResult = Math.random() < 0.5 ? 'Tài' : 'Xỉu';
        return { prediction: randomResult, reason: "Không đủ dữ liệu.", confidence: 0 };
    }

    const { streak, breakProb } = detectStreakAndBreak(history);

    // Run all models and collect votes
    let taiVotes = 0;
    let xiuVotes = 0;
    let reasons = [];

    const models = {
        trend: trendAndProb(history),
        short: shortPattern(history),
        mean: meanDeviation(history),
        switch: recentSwitch(history),
        bridge: smartBridgeBreak(history),
        ai: aiHtddLogic(history)
    };

    if (models.trend === 'Tài') taiVotes++; else if (models.trend === 'Xỉu') xiuVotes++;
    if (models.short === 'Tài') taiVotes++; else if (models.short === 'Xỉu') xiuVotes++;
    if (models.mean === 'Tài') taiVotes++; else if (models.mean === 'Xỉu') xiuVotes++;
    if (models.switch === 'Tài') taiVotes++; else if (models.switch === 'Xỉu') xiuVotes++;
    if (models.bridge.prediction === 'Tài') taiVotes += 2; else xiuVotes += 2; // Bridge vote is more important
    if (models.ai.prediction === 'Tài') taiVotes += 3; else xiuVotes += 3; // AI HTDD vote is most important

    reasons.push(models.ai.reason);
    reasons.push(models.bridge.reason);

    const finalPrediction = taiVotes > xiuVotes ? 'Tài' : 'Xỉu';

    // Generate random confidence score
    const confidence = (Math.random() * (97 - 61) + 61).toFixed(2);

    return {
        prediction: finalPrediction,
        confidence: confidence + "%",
        reason: reasons.join(' | ')
    };
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
// Sửa thành số nguyên đơn giản, không có dấu #
const nextPhien = currentPhien ? (parseInt(currentPhien) + 1).toString() : '1';

    if (currentPhien !== lastPrediction.phien) {
        const { prediction, confidence, reason } = generatePrediction(historyData);
        const doan_vi = predictTopSums(historyData, prediction, 3);

        lastPrediction = {
            phien: currentPhien,
            du_doan: prediction,
            doan_vi: doan_vi,
            do_tin_cay: confidence,
            reason: reason
        };

        appendPredictionHistory({
            phien: currentPhien,
            du_doan: prediction,
            doan_vi: doan_vi,
            do_tin_cay: confidence,
            reason: reason,
            ket_qua_thuc: null,
            timestamp: Date.now()
        });
    }

    const latestOriginal = (await axios.get(API_URL)).data.data.resultList[0];

        res.json({
    Phien: parseInt(currentPhien), // ép về số nguyên
    Xuc_xac_1: latestOriginal?.facesList?.[0] || 0,
    Xuc_xac_2: latestOriginal?.facesList?.[1] || 0,
    Xuc_xac_3: latestOriginal?.facesList?.[2] || 0,
    Tong: latestOriginal?.score || 0,
    Ket_qua: getResultType(latestOriginal),
    phien_hien_tai: parseInt(nextPhien), // ép về số nguyên
    du_doan: lastPrediction.du_doan,
    dudoan_vi: lastPrediction.doan_vi, // giữ nguyên dạng mảng
    do_tin_cay: parseFloat(lastPrediction.do_tin_cay) // ép thành số thay vì string "%"
});
});   // ✅ thêm dấu đóng cho app.get

// --- KHỞI ĐỘNG SERVER ---
app.listen(PORT, () => {
    console.log(`🤖 Server AI dự đoán chạy tại http://localhost:${PORT}`);
    updateHistory();
    setInterval(updateHistory, UPDATE_INTERVAL);
});
 
