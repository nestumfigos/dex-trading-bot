// nvidia-ai.js
// Central NVIDIA AI utility for your bot (sentiment, explanation, chat, summary)
const axios = require('axios');
const config = require('../../config');

function getNvidiaConfig() {
  return {
    apiKey: config.nvidia?.apiKey || process.env.NVIDIA_API_KEY,
    model: config.nvidia?.model || 'deepseek-ai/deepseek-v4-pro',
    apiUrl: config.nvidia?.apiUrl || 'https://integrate.api.nvidia.com/v1/chat/completions',
  };
}

async function nvidiaAnalyzeBatch(texts, prompt) {
  const { apiKey, model, apiUrl } = getNvidiaConfig();
  if (!apiKey) throw new Error('NVIDIA_API_KEY not set');
  const messages = texts.map(text => ({
    role: 'user',
    content: prompt ? `${prompt}: ${text}` : text,
  }));
  const res = await axios.post(apiUrl, {
    model,
    messages,
  }, {
    headers: { Authorization: `Bearer ${apiKey}` },
    timeout: 15000,
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
