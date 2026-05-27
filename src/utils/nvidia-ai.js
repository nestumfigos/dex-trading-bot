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

// B4.cso.1: sanitize bearer token from any error string before propagation.
// Bearer tokens otherwise leak via axios error.message / error.stack.
function _redactBearer(text, apiKey) {
  if (!apiKey || !text) return text;
  return String(text)
    .split(apiKey).join('[REDACTED_NVIDIA_KEY]')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer [REDACTED]');
}

async function nvidiaAnalyzeBatch(texts, prompt) {
  const { apiKey, model, apiUrl } = getNvidiaConfig();
  if (!apiKey) throw new Error('NVIDIA_API_KEY not set');
  const messages = texts.map(text => ({
    role: 'user',
    content: prompt ? `${prompt}: ${text}` : text,
  }));
  try {
    const res = await axios.post(apiUrl, {
      model,
      messages,
    }, {
      headers: { Authorization: `Bearer ${apiKey}` },
      timeout: 15000,
    });
    return res.data;
  } catch (error) {
    // Redact key before rethrow so any caller logger only sees [REDACTED_NVIDIA_KEY].
    const sanitized = _redactBearer(error?.message || '', apiKey);
    const next = new Error(sanitized);
    next.code = error?.code || (error?.response?.status ? `HTTP_${error.response.status}` : 'NVIDIA_UNKNOWN');
    throw next;
  }
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
