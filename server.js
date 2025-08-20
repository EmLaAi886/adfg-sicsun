const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
const PORT = 8891;

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

// --- THUẬT TOÁN MARKOV BẬC 3 VÀ N-PATTERN BẬC 5 ---

function buildMarkovChain(history, order = 3) {
  const chain = {};
  
  for (let i = 0; i < history.length - order; i++) {
    const pattern = history.slice(i, i + order).map(h => h.result).join('-');
    const next = history[i + order].result;
    
    if (!chain[pattern]) {
      chain[pattern] = { 'Tài': 0, 'Xỉu': 0, 'Bão': 0 };
    }
    
    chain[pattern][next] = (chain[pattern][next] || 0) + 1;
  }
  
  // Tính xác suất
  for (const pattern in chain) {
    const total = chain[pattern]['Tài'] + chain[pattern]['Xỉu'] + chain[pattern]['Bão'];
    chain[pattern]['Tài'] = chain[pattern]['Tài'] / total;
    chain[pattern]['Xỉu'] = chain[pattern]['Xỉu'] / total;
    chain[pattern]['Bão'] = chain[pattern]['Bão'] / total;
  }
  
  return chain;
}

function findNPatterns(history, patternLength = 5, minOccurrences = 2) {
  const patterns = {};
  
  for (let i = 0; i < history.length - patternLength + 1; i++) {
    const pattern = history.slice(i, i + patternLength).map(h => h.result).join('-');
    patterns[pattern] = (patterns[pattern] || 0) + 1;
  }
  
  // Lọc các pattern có số lần xuất hiện >= minOccurrences
  const frequentPatterns = {};
  for (const pattern in patterns) {
    if (patterns[pattern] >= minOccurrences) {
      frequentPatterns[pattern] = patterns[pattern];
    }
  }
  
  return frequentPatterns;
}

function predictWithMarkov(history, markovChain, order = 3) {
  if (history.length < order) return null;
  
  const recentPattern = history.slice(0, order).map(h => h.result).join('-');
  
  if (!markovChain[recentPattern]) return null;
  
  const probabilities = markovChain[recentPattern];
  let prediction = null;
  let maxProb = 0;
  
  for (const outcome in probabilities) {
    if (probabilities[outcome] > maxProb) {
      maxProb = probabilities[outcome];
      prediction = outcome;
    }
  }
  
  return {
    prediction,
    confidence: maxProb * 100,
    reason: `Markov bậc ${order}: Pattern ${recentPattern} -> ${prediction} (${(maxProb * 100).toFixed(2)}%)`
  };
}

function predictWithNPattern(history, nPatterns, patternLength = 5) {
  if (history.length < patternLength - 1) return null;
  
  const recentResults = history.slice(0, patternLength - 1).map(h => h.result);
  let bestMatch = null;
  let bestPattern = null;
  let maxOccurrences = 0;
  
  for (const pattern in nPatterns) {
    const patternParts = pattern.split('-');
    const prefix = patternParts.slice(0, patternLength - 1).join('-');
    const recentPattern = recentResults.join('-');
    
    if (prefix === recentPattern && nPatterns[pattern] > maxOccurrences) {
      maxOccurrences = nPatterns[pattern];
      bestPattern = pattern;
      bestMatch = patternParts[patternLength - 1];
    }
  }
  
  if (!bestMatch) return null;
  
  return {
    prediction: bestMatch,
    confidence: Math.min(90, 50 + (maxOccurrences * 10)),
    reason: `N-Pattern bậc ${patternLength}: Pattern ${bestPattern} xuất hiện ${maxOccurrences} lần`
  };
}

function generatePrediction(history) {
  if (!history || history.length < 10) {
    const randomResult = Math.random() < 0.5 ? 'Tài' : 'Xỉu';
    return { 
      prediction: randomResult, 
      confidence: "50%", 
      reason: "Không đủ dữ liệu lịch sử để phân tích." 
    };
  }
  
  // Xây dựng Markov Chain bậc 3
  const markovChain = buildMarkovChain(history, 3);
  
  // Tìm các N-Pattern bậc 5
  const nPatterns = findNPatterns(history, 5, 2);
  
  // Dự đoán với Markov
  const markovPrediction = predictWithMarkov(history, markovChain, 3);
  
  // Dự đoán với N-Pattern
  const nPatternPrediction = predictWithNPattern(history, nPatterns, 5);
  
  // Kết hợp kết quả
  let finalPrediction = null;
  let finalConfidence = 0;
  let reasons = [];
  
  if (markovPrediction) {
    finalPrediction = markovPrediction.prediction;
    finalConfidence = markovPrediction.confidence;
    reasons.push(markovPrediction.reason);
  }
  
  if (nPatternPrediction) {
    // Ưu tiên N-Pattern nếu confidence cao hơn
    if (nPatternPrediction.confidence > finalConfidence) {
      finalPrediction = nPatternPrediction.prediction;
      finalConfidence = nPatternPrediction.confidence;
    }
    reasons.push(nPatternPrediction.reason);
  }
  
  // Fallback nếu không có dự đoán nào
  if (!finalPrediction) {
    finalPrediction = history[0].result === 'Tài' ? 'Xỉu' : 'Tài';
    finalConfidence = 55;
    reasons.push("Fallback: Đảo ngược kết quả gần nhất");
  }
  
  return {
    prediction: finalPrediction,
    confidence: `${finalConfidence.toFixed(2)}%`,
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
    Phien: currentPhien, // Đã không còn dấu #
    Xuc_xac_1: latestOriginal?.facesList?.[0] || 0,
    Xuc_xac_2: latestOriginal?.facesList?.[1] || 0,
    Xuc_xac_3: latestOriginal?.facesList?.[2] || 0,
    Tong: latestOriginal?.score || 0,
    Ket_qua: getResultType(latestOriginal),
    phien_hien_tai: nextPhien, // Đã không còn dấu #
    du_doan: lastPrediction.du_doan,
    dudoan_vi: lastPrediction.doan_vi.join(", "),
    do_tin_cay: lastPrediction.do_tin_cay,
  });
});

// --- KHỞI ĐỘNG SERVER ---
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🤖 Server AI dự đoán chạy tại port ${PORT}`);
  updateHistory();
  setInterval(updateHistory, UPDATE_INTERVAL);
});
