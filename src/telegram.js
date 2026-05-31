'use strict';
const axios = require('axios');
const config = require('../config');
const logger = require('./utils/logger');
const { nvidiaExplainTrade, nvidiaChat } = require('./utils/nvidia-ai');

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function createTelegramSender({
  token,
  chatId,
  httpPost = axios.post,
  log = logger,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  paperTrading = config.paperTrading,
} = {}) {
  const configured = Boolean(token && chatId);
  // Paper mode: telegram alerts intentionally silenced (paper bot is observation-only,
  // operator does not need pager-style notifications on simulated trades). Return a
  // no-op sender that does not log either — keeps logs clean.
  if (paperTrading) {
    return async function sendMessageNoopPaper() { /* paper: silent */ };
  }

  return async function sendMessage(message, retries = 3) {
    if (!configured) {
      log.warn('Telegram not configured - skipping alert');
      return;
    }

    const attempts = Math.max(1, Number(retries || 1));
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const response = await httpPost(url, {
          chat_id: chatId,
          text: message,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        }, {
          timeout: 10000,
        });
        if (response?.data?.ok === false) {
          throw new Error('Telegram API rejected message');
        }
        return;
      } catch (error) {
        log.error(`Telegram alert attempt ${attempt + 1} failed: ${error.message}`);
        if (attempt < attempts - 1) {
          await sleep(2000 * (attempt + 1));
        }
      }
    }
    log.error('Telegram alert failed after all retries');
  };
}

const sendTelegramMessage = createTelegramSender({
  token: config.telegram.token,
  chatId: config.telegram.chatId,
});

async function sendAlert(message, retries = 3) {
  await sendTelegramMessage(message, retries);
}

async function sendHeartbeat(stats = null) {
  const mode = config.paperTrading ? '📝 Paper' : '🔴 Live';
  if (!stats) {
    await sendAlert(`✅ DEX Bot OK | ${mode}`);
    return;
  }

  const {
    cashBalance = 0,
    equity = 0,
    totalPnl = 0,
    unrealizedPnl = 0,
    openPositionCount = 0,
    closedTrades = 0,
    wins = 0,
    winRate = null,
    grossProfit = 0,
    grossLoss = 0,
    profitFactor = 0,
    healthOk = true,
    degradedReasons = [],
    unhealthyReasons = [],
    signalDrought = false,
  } = stats;

  const pnlSign = totalPnl >= 0 ? '+' : '';
  const unrealizedSign = unrealizedPnl >= 0 ? '+' : '';
  const winRateStr = winRate !== null ? `${winRate.toFixed(1)}%` : 'N/A';
  const pfStr = profitFactor ? Number(profitFactor).toFixed(2) : 'N/A';
  const healthIcon = unhealthyReasons.length > 0 ? '🔴' : (degradedReasons.length > 0 ? '🟡' : '✅');
  const droughtNote = signalDrought ? '\n⚠️ Signal drought detected — filters may be too tight' : '';

  let healthNote = '';
  if (unhealthyReasons.length > 0) {
    healthNote = `\n🔴 Unhealthy: ${unhealthyReasons.slice(0, 3).map(escapeHtml).join(', ')}`;
  } else if (degradedReasons.length > 0) {
    healthNote = `\n🟡 Degraded: ${degradedReasons.slice(0, 2).map(escapeHtml).join(', ')}`;
  }

  const message =
    `${healthIcon} DEX Bot Heartbeat | ${mode}\n` +
    `💰 Cash: <b>$${cashBalance.toFixed(2)}</b> | Equity: <b>$${equity.toFixed(2)}</b>\n` +
    `📊 PnL: <b>${pnlSign}$${totalPnl.toFixed(2)}</b> | Unrealized: ${unrealizedSign}$${unrealizedPnl.toFixed(2)}\n` +
    `📈 Trades: ${closedTrades} (${wins}W) | WinRate: ${winRateStr} | PF: ${pfStr}\n` +
    `🏷️ Open Positions: ${openPositionCount}` +
    healthNote +
    droughtNote;

  await sendAlert(message);
}

async function sendTradeAlert(type, tokenData, sizeUsd, pnl = null) {
  const pnlStr = pnl !== null ? ` | P&L: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}` : '';
  const message = `${type === 'BUY' ? '🟢' : '🔴'} ${type} ${escapeHtml(tokenData.symbol)} @ $${tokenData.price} | Size: $${sizeUsd.toFixed(2)}${pnlStr}`;
  await sendAlert(message);
}

async function sendErrorAlert(error) {
  await sendAlert(`❌ Error: ${escapeHtml(error)}`);
}

async function sendHealthAlert(healthStatus) {
  if (!healthStatus) return;
  const { ok, degradedReasons = [], unhealthyReasons = [] } = healthStatus;

  if (unhealthyReasons.length > 0) {
    const reasons = unhealthyReasons.map(escapeHtml).join('\n  • ');
    await sendAlert(`🔴 <b>Bot UNHEALTHY</b>\n  • ${reasons}`);
  } else if (degradedReasons.length > 0) {
    const reasons = degradedReasons.map(escapeHtml).join('\n  • ');
    await sendAlert(`🟡 <b>Bot Degraded</b>\n  • ${reasons}`);
  } else if (ok) {
    await sendAlert('✅ Bot health restored — all systems normal');
  }
}

async function sendSafeModeAlert(reason) {
  await sendAlert(`🛑 <b>SAFE MODE ACTIVATED</b>\n${escapeHtml(reason)}\nAll trading halted. Manual intervention required.`);
}

async function sendNvidiaTradeExplanation(trade) {
  const explanation = await nvidiaExplainTrade(trade);
  await sendAlert(`AI Explanation: ${escapeHtml(explanation.choices?.[0]?.message?.content || 'N/A')}`);
}

async function handleNvidiaChat(userQuestion) {
  const response = await nvidiaChat(userQuestion);
  await sendAlert(`AI: ${escapeHtml(response.choices?.[0]?.message?.content || 'N/A')}`);
}

module.exports = { sendAlert, sendHeartbeat, sendTradeAlert, sendErrorAlert, sendHealthAlert, sendSafeModeAlert };
module.exports.sendNvidiaTradeExplanation = sendNvidiaTradeExplanation;
module.exports.handleNvidiaChat = handleNvidiaChat;
module.exports._testInternals = { createTelegramSender, escapeHtml };
