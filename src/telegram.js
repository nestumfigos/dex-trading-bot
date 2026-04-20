'use strict';
const TelegramBot = require('node-telegram-bot-api');
const config = require('../config');
const logger = require('./utils/logger');

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

module.exports = { sendAlert, sendHeartbeat, sendTradeAlert, sendErrorAlert };