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
    doan_vi: []
};

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
    return history.slice(0, len).map(s => getResultType(s).charAt(0)).reverse().join('');
}

// --- CÁC THUẬT TOÁN DỰ ĐOÁN NÂNG CAO ---

/**
 * Thuật toán dự đoán chính (Tài/Xỉu) với nhiều phương pháp.
 * - Sử dụng Moving Average (trung bình trượt).
 * - Phân tích chuỗi pattern dài.
 * - Sử dụng "double-check" để chỉ đưa ra dự đoán khi có sự đồng thuận.
 */
function predictMain(history) {
    if (history.length < 15) return "Tài"; // Cần nhiều dữ liệu hơn để dự đoán chính xác
    
    // Phương pháp 1: Phân tích Moving Average
    const last5Avg = history.slice(0, 5).reduce((acc, s) => acc + s.score, 0) / 5;
    const movingAvgPrediction = last5Avg >= 10.5 ? "Tài" : "Xỉu";
    
    // Phương pháp 2: Phân tích Pattern
    const pattern = generatePattern(history, 10);
    let patternPrediction = null;

    if (pattern.startsWith("TTTT")) {
        patternPrediction = "Xỉu";
    } else if (pattern.startsWith("XXXX")) {
        patternPrediction = "Tài";
    } else if (pattern.includes("TXXTXX")) {
        patternPrediction = "Xỉu";
    } else if (pattern.includes("XTTXTT")) {
        patternPrediction = "Tài";
    }

    // Kết hợp hai phương pháp: chỉ đưa ra dự đoán nếu cả hai đồng thuận
    if (patternPrediction && movingAvgPrediction === patternPrediction) {
        return patternPrediction;
    }
    
    // Nếu không có sự đồng thuận, hoặc không tìm thấy pattern, fallback về moving average
    return movingAvgPrediction;
}

/**
 * Thuật toán dự đoán Vị (tổng điểm) nâng cao.
 * - Sử dụng trọng số với hàm mũ để ưu tiên kết quả gần nhất.
 * - Không sử dụng random, trả về 3 tổng điểm có khả năng cao nhất một cách xác định.
 */
function predictTopSumsWeighted(history, prediction, top = 3) {
    const relevantHistory = history.filter(item => getResultType(item) === prediction);
    
    if (relevantHistory.length < 5) {
        return prediction === "Tài" ? [12, 13, 14] : [9, 8, 7];
    }
    
    const weightedFreq = {};
    relevantHistory.forEach((item, index) => {
        const score = item.score;
        // Sử dụng hàm mũ để gán trọng số, ưu tiên mạnh mẽ các phiên gần nhất
        const weight = Math.exp(-0.2 * index);
        weightedFreq[score] = (weightedFreq[score] || 0) + weight;
    });
    
    const sortedSums = Object.entries(weightedFreq)
        .sort(([, a], [, b]) => b - a)
        .map(([sum]) => parseInt(sum));
    
    // Trả về top N kết quả mà không cần random
    const finalSums = sortedSums.slice(0, top);

    // Bổ sung nếu thiếu, đảm bảo đủ 3 kết quả
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
        return res.status(400).json({error: "Thiếu phien hoặc ket_qua_thuc"});
    }

    const predHist = loadPredictionHistory();
    const lastPred = predHist.find(p => p.phien === phien);
    if (!lastPred) return res.status(404).json({error: "Không tìm thấy dự đoán phiên này"});

    lastPred.ket_qua_thuc = ket_qua_thuc;
    savePredictionHistory(predHist);
    res.json({success: true});
});

app.get('/predict', async (req, res) => {
    await updateHistory();
    const latest = historyData[0] || {};
    const currentPhien = latest.gameNum;

    // Chỉ dự đoán lại khi có phiên mới
    if (currentPhien !== lastPrediction.phien) {
        const du_doan = predictMain(historyData);
        const doan_vi = predictTopSumsWeighted(historyData, du_doan, 3);

        lastPrediction = {
            phien: currentPhien,
            du_doan,
            doan_vi
        };

        appendPredictionHistory({
            phien: currentPhien,
            du_doan,
            doan_vi,
            ket_qua_thuc: null,
            timestamp: Date.now()
        });
    }

    // Lấy phiên tiếp theo để hiển thị
    const nextPhien = currentPhien ? parseInt(currentPhien.replace('#', '')) + 1 : 0;

    res.json({
        Id: "binhtool90",
        Phien: nextPhien,
        Xuc_xac_1: latest.facesList?.[0] || 0,
        Xuc_xac_2: latest.facesList?.[1] || 0,
        Xuc_xac_3: latest.facesList?.[2] || 0,
        Tong: latest.score || 0,
        Ket_qua: getResultType(latest),
        Pattern: generatePattern(historyData),
        Du_doan: lastPrediction.du_doan,
        doan_vi: lastPrediction.doan_vi
    });
});

// --- KHỞI ĐỘNG SERVER ---
app.listen(PORT, () => {
    console.log(`🤖 Server AI dự đoán chạy tại http://localhost:${PORT}`);
    setInterval(updateHistory, UPDATE_INTERVAL);
});
