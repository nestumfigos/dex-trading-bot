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
  const res = await axios.post(NVIDIA_API_URL, {
    model: NVIDIA_MODEL,
    messages
  }, {
    headers: { Authorization: `Bearer ${NVIDIA_API_KEY}` }
  });
  return res.data;
}

async function nvidiaExplainTrade(trade) {
  return nvidiaAnalyzeBatch([
    `Explain this trade in simple terms: ${JSON.stringify(trade)}`
  ], '');
}

async function nvidiaChat(userQuestion) {
  return nvidiaAnalyzeBatch([userQuestion], '');
}

async function nvidiaSummarizeBacktest(backtestResults) {
  return nvidiaAnalyzeBatch([
    `Summarize these backtest results and suggest improvements: ${JSON.stringify(backtestResults)}`
  ], '');
}

module.exports = {
  nvidiaAnalyzeBatch,
  nvidiaExplainTrade,
  nvidiaChat,
  nvidiaSummarizeBacktest
};
