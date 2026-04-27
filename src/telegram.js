'use strict';
const TelegramBot = require('node-telegram-bot-api');
const config = require('../config');
const logger = require('./utils/logger');
const { nvidiaExplainTrade, nvidiaChat } = require('./utils/nvidia-ai');

let bot = null;
if (config.telegram.token && config.telegram.chatId) {
  bot = new TelegramBot(config.telegram.token, { polling: false });
}

async function sendAlert(message, retries = 3) {
  if (!bot) {
    logger.warn('Telegram not configured - skipping alert');
    return;
  }

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      await bot.sendMessage(config.telegram.chatId, message, {
        parse_mode: 'HTML',
        disable_web_page_preview: true
      });
      return;
    } catch (error) {
      logger.error(`Telegram alert attempt ${attempt + 1} failed: ${error.message}`);
      if (attempt < retries - 1) {
        await new Promise(resolve => setTimeout(resolve, 2000 * (attempt + 1)));
      }
    }
  }
  logger.error('Telegram alert failed after all retries');
}

async function sendHeartbeat() {
  await sendAlert('✅ DEX Bot OK');
}

async function sendTradeAlert(type, tokenData, sizeUsd, pnl = null) {
  const pnlStr = pnl !== null ? ` | P&L: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}` : '';
  const message = `${type === 'BUY' ? '🟢' : '🔴'} ${type} ${tokenData.symbol} @ $${tokenData.price} | Size: $${sizeUsd.toFixed(2)}${pnlStr}`;
  await sendAlert(message);
}

async function sendErrorAlert(error) {
  await sendAlert(`❌ Error: ${error}`);
}

async function sendNvidiaTradeExplanation(trade) {
  const explanation = await nvidiaExplainTrade(trade);
  await sendAlert(`AI Explanation: ${explanation.choices?.[0]?.message?.content || 'N/A'}`);
}

async function handleNvidiaChat(userQuestion) {
  const response = await nvidiaChat(userQuestion);
  await sendAlert(`AI: ${response.choices?.[0]?.message?.content || 'N/A'}`);
}

module.exports = { sendAlert, sendHeartbeat, sendTradeAlert, sendErrorAlert };
module.exports.sendNvidiaTradeExplanation = sendNvidiaTradeExplanation;
module.exports.handleNvidiaChat = handleNvidiaChat;