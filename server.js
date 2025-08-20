const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
const PORT = 3000;

const API_URL = 'https://api.wsktnus8.net/v2/history/getLastResult?gameId=ktrng_3979&size=100&tableId=39791215743193&curPage=1';
const UPDATE_INTERVAL = 5000;
const HISTORY_FILE = path.join(__dirname, 'prediction_history.json');

let historyData = [];
let lastPrediction = {
    phien: null,
    du_doan: null,
    dudoan_vi: []
};

// --- Load lịch sử dự đoán từ file ---
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

// --- Lưu lịch sử dự đoán vào file ---
function savePredictionHistory(data) {
    try {
        fs.writeFileSync(HISTORY_FILE, JSON.stringify(data, null, 2));
    } catch (e) {
        console.error('Lỗi lưu lịch sử dự đoán:', e.message);
    }
}

// --- Cập nhật dữ liệu API ---
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

// --- Phân loại kết quả ---
function getResultType(session) {
    if (!session || !session.facesList) return "";
    const [a, b, c] = session.facesList;
    if (a === b && b === c) return "Bão";
    return session.score >= 11 ? "Tài" : "Xỉu";
}

// --- Markov Chain bậc 3 ---
function predictMarkov3(history) {
    if (history.length < 4) return { du_doan: "Tài", do_tin_cay: "50%", note: "Thiếu dữ liệu" };

    const seq = history.map(s => getResultType(s));
    const last3 = seq.slice(0, 3).join("");
    const transitions = {};

    for (let i = 0; i < seq.length - 3; i++) {
        const key = seq.slice(i, i+3).join("");
        const next = seq[i+3];
        if (!transitions[key]) transitions[key] = {};
        transitions[key][next] = (transitions[key][next] || 0) + 1;
    }

    if (!transitions[last3]) {
        return { du_doan: "Tài", do_tin_cay: "50%", note: "Không có mẫu Markov" };
    }

    const nextCounts = transitions[last3];
    const entries = Object.entries(nextCounts).sort((a,b)=>b[1]-a[1]);
    const [best, count] = entries[0];
    const total = entries.reduce((acc,e)=>acc+e[1],0);

    return {
        du_doan: best,
        do_tin_cay: ((count/total)*100).toFixed(1) + "%",
        note: "Markov bậc 3"
    };
}

// --- N-pattern bậc 5 ---
function predictNPattern5(history) {
    if (history.length < 6) return { du_doan: "Xỉu", do_tin_cay: "50%", note: "Thiếu dữ liệu" };

    const seq = history.map(s => getResultType(s));
    const last5 = seq.slice(0, 5).join("");
    const patterns = {};

    for (let i=0; i<seq.length-5; i++) {
        const key = seq.slice(i, i+5).join("");
        const next = seq[i+5];
        if (!patterns[key]) patterns[key] = {};
        patterns[key][next] = (patterns[key][next]||0)+1;
    }

    if (!patterns[last5]) {
        return { du_doan: "Xỉu", do_tin_cay: "50%", note: "Không có mẫu N-pattern" };
    }

    const nextCounts = patterns[last5];
    const entries = Object.entries(nextCounts).sort((a,b)=>b[1]-a[1]);
    const [best, count] = entries[0];
    const total = entries.reduce((acc,e)=>acc+e[1],0);

    return {
        du_doan: best,
        do_tin_cay: ((count/total)*100).toFixed(1) + "%",
        note: "N-pattern bậc 5"
    };
}

// --- Kết hợp 2 thuật toán ---
function predictMain(history) {
    const markov = predictMarkov3(history);
    const npattern = predictNPattern5(history);

    // Nếu 2 thuật toán trùng kết quả thì tin cậy cao hơn
    if (markov.du_doan === npattern.du_doan) {
        return {
            du_doan: markov.du_doan,
            do_tin_cay: "85%",
            note: `${markov.note} + ${npattern.note}`
        };
    }

    // Nếu khác nhau thì chọn theo độ tin cậy cao hơn
    return (parseFloat(markov.do_tin_cay) > parseFloat(npattern.do_tin_cay)) ? markov : npattern;
}

// --- Endpoint chính ---
app.get('/predict', async (req, res) => {
    await updateHistory();
    const latest = historyData[0] || {};
    const currentPhien = latest.gameNum;

    if (currentPhien !== lastPrediction.phien) {
        const predict = predictMain(historyData);

        lastPrediction = {
            phien: currentPhien,
            du_doan: predict.du_doan,
            dudoan_vi: [0,0,0],
            do_tin_cay: predict.do_tin_cay,
            note: predict.note
        };
    }

    res.json({
        Id: "binhtool90",
        Phien: currentPhien ? parseInt(currentPhien.replace('#',''))+1 : 0,
        Xuc_xac_1: latest.facesList?.[0] || 0,
        Xuc_xac_2: latest.facesList?.[1] || 0,
        Xuc_xac_3: latest.facesList?.[2] || 0,
        Tong: latest.score || 0,
        Ket_qua: getResultType(latest) || "Xỉu",
        phien_hien_tai: currentPhien || "#0",
        du_doan: lastPrediction.du_doan,
        dudoan_vi: lastPrediction.dudoan_vi.join(","),
        do_tin_cay: lastPrediction.do_tin_cay,
        Ghi_chu: lastPrediction.note || ""
    });
});

// --- Khởi động server ---
app.listen(PORT, () => {
    console.log(`🤖 Server AI dự đoán chạy tại http://localhost:${PORT}`);
    setInterval(updateHistory, UPDATE_INTERVAL);
});
