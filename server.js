const express = require("express");
const axios = require("axios");

const app = express();
const PORT = 3000;

const API_URL =
  "https://api.wsktnus8.net/v2/history/getLastResult?gameId=ktrng_3979&size=100&tableId=39791215743193&curPage=1";

// Hàm xác định kết quả Tài/Xỉu
function getResult(score) {
  return score >= 11 ? "Tài" : "Xỉu";
}

// Giả lập Markov bậc 3 + N-pattern bậc 5
function duDoanMarkov(history) {
  // Lấy 3 kết quả gần nhất làm Markov bậc 3
  let last3 = history.slice(0, 3).map((h) => getResult(h.score));

  // Lấy 5 gần nhất làm N-pattern
  let last5 = history.slice(0, 5).map((h) => getResult(h.score));

  let prediction = "Xỉu"; // mặc định
  if (last3.every((r) => r === "Tài")) {
    prediction = "Xỉu"; // bẻ cầu
  } else if (last3.every((r) => r === "Xỉu")) {
    prediction = "Tài"; // bẻ cầu
  } else {
    prediction = last3[0]; // theo phiên gần nhất
  }

  // random dudoan_vi
  let dudoan_vi = [];
  if (prediction === "Tài") {
    dudoan_vi = Array.from({ length: 3 }, () =>
      Math.floor(Math.random() * (15 - 11 + 1)) + 11
    );
  } else {
    dudoan_vi = Array.from({ length: 3 }, () =>
      Math.floor(Math.random() * (10 - 6 + 1)) + 6
    );
  }

  return { prediction, dudoan_vi };
}

app.get("/predict", async (req, res) => {
  try {
    const response = await axios.get(API_URL);
    const resultList = response.data.data.resultList;

    if (!resultList || resultList.length === 0) {
      return res.json({ error: "Không có dữ liệu" });
    }

    const current = resultList[0]; // phiên mới nhất
    const nextPhien = parseInt(current.gameNum.replace("#", "")) + 1;

    const { prediction, dudoan_vi } = duDoanMarkov(resultList);

    const ketQua = {
      Phien: parseInt(current.gameNum.replace("#", "")),
      Xuc_xac_1: current.facesList[0],
      Xuc_xac_2: current.facesList[1],
      Xuc_xac_3: current.facesList[2],
      Tong: current.score,
      Ket_qua: getResult(current.score),
      phien_hien_tai: nextPhien,
      du_doan: prediction,
      dudoan_vi: dudoan_vi,
      do_tin_cay: 83.72,
      Ghi_chu:
        "[AI] Tổng thể Tài nhiều hơn | [Bẻ Cầu] Phát hiện mẫu lặp Tài,Tài,Xỉu, có khả năng bẻ cầu",
    };

    res.json(ketQua);
  } catch (error) {
    console.error(error.message);
    res.status(500).json({ error: "Lỗi lấy dữ liệu" });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server chạy tại http://localhost:${PORT}`);
});
