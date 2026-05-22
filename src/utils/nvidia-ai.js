// nvidia-ai.js
// Central NVIDIA AI utility for your bot (sentiment, explanation, chat, summary)
const axios = require('axios');

const NVIDIA_API_KEY = process.env.NVIDIA_API_KEY;
const NVIDIA_API_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';
const NVIDIA_MODEL = 'minimaxai/minimax-m2.7'; // You can change to any available model

async function nvidiaAnalyzeBatch(texts, prompt) {
  if (!NVIDIA_API_KEY) throw new Error('NVIDIA_API_KEY not set');
  const messages = texts.map(text => ({
    role: 'user',
    content: `${prompt}: ${text}`
  }));
  try {
    const res = await axios.post(NVIDIA_API_URL, {
      model: NVIDIA_MODEL,
      messages
    }, {
      headers: { Authorization: `Bearer ${NVIDIA_API_KEY}` },
      timeout: 15000,
    });
    return res.data;
  } catch (err) {
    const status = Number(err.response?.status || 0);
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    throw new Error(`NVIDIA API error (${status || 'network'}): ${detail}`);
  }
}

async function nvidiaExplainTrade(trade) {
  try {
    return await nvidiaAnalyzeBatch([
      `Explain this trade in simple terms: ${JSON.stringify(trade)}`
    ], '');
  } catch (err) {
    return null;
  }
}

async function nvidiaChat(userQuestion) {
  try {
    return await nvidiaAnalyzeBatch([userQuestion], '');
  } catch (err) {
    return null;
  }
}

async function nvidiaSummarizeBacktest(backtestResults) {
  try {
    return await nvidiaAnalyzeBatch([
      `Summarize these backtest results and suggest improvements: ${JSON.stringify(backtestResults)}`
    ], '');
  } catch (err) {
    return null;
  }
}

module.exports = {
  nvidiaAnalyzeBatch,
  nvidiaExplainTrade,
  nvidiaChat,
  nvidiaSummarizeBacktest
};
