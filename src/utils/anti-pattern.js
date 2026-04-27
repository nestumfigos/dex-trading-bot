'use strict';

const crypto = require('crypto');
const config = require('../../config');
const logger = require('./logger');

function randomInt(min, max) {
  const low = Math.ceil(Number(min));
  const high = Math.floor(Number(max));
  if (!Number.isFinite(low) || !Number.isFinite(high) || high < low) return 0;
  const range = high - low + 1;
  const randomBytes = crypto.randomBytes(4);
  const randomValue = randomBytes.readUInt32BE(0) % range;
  return low + randomValue;
}

function applyPositionJitter(sizeUsd, jitterPct = null) {
  const baseSize = Number(sizeUsd || 0);
  if (!Number.isFinite(baseSize) || baseSize <= 0) return 0;
  if (config.antiPattern?.enablePositionJitter === false) return baseSize;

  const actualJitterPct = Math.max(0, Number(jitterPct ?? config.antiPattern?.positionSizeJitterPct ?? 15));
  const jitterMultiplier = 1 + ((Math.random() - 0.5) * 2 * (actualJitterPct / 100));
  const minSize = Math.max(1, baseSize * (1 - actualJitterPct / 100));
  const maxSize = baseSize * (1 + actualJitterPct / 100);
  const jitteredSize = Math.max(minSize, Math.min(maxSize, baseSize * jitterMultiplier));
  const jitterPctApplied = ((jitteredSize - baseSize) / baseSize) * 100;

  logger.debug(`Position size jitter applied: $${baseSize.toFixed(2)} -> $${jitteredSize.toFixed(2)} (${jitterPctApplied >= 0 ? '+' : ''}${jitterPctApplied.toFixed(1)}%)`);
  return jitteredSize;
}

function getRandomEntryDelay(maxMs = null) {
  if (config.antiPattern?.enableEntryDelay === false) return 0;
  const actualMaxMs = Math.max(0, Number(maxMs ?? config.antiPattern?.maxEntryDelayMs ?? 3000));
  if (actualMaxMs <= 0) return 0;
  return randomInt(0, actualMaxMs);
}

function shouldSplitSolanaTrade(usdcAmount, splitThresholdUsd = null) {
  if (config.antiPattern?.enableSolanaSplits === false) return false;
  const amount = Number(usdcAmount || 0);
  const actualThreshold = Math.max(0, Number(splitThresholdUsd ?? config.antiPattern?.solanaSplitThresholdUsd ?? 2000));
  return Number.isFinite(amount) && amount > actualThreshold;
}

function generateSplitTradeSchedule(totalUsdcAmount, numSplits = null) {
  const total = Number(totalUsdcAmount || 0);
  if (!Number.isFinite(total) || total <= 0) return [];

  const splitCount = Math.max(2, Math.min(3, Number(numSplits || randomInt(2, 3))));
  const weights = [];
  let weightSum = 0;
  for (let index = 0; index < splitCount; index += 1) {
    const weight = randomInt(25, 45);
    weights.push(weight);
    weightSum += weight;
  }

  let allocated = 0;
  const schedule = weights.map((weight, index) => {
    const isLast = index === splitCount - 1;
    const usdcAmount = isLast
      ? Math.max(0, total - allocated)
      : Number(((total * weight) / weightSum).toFixed(2));
    allocated += usdcAmount;
    return {
      usdcAmount,
      delayBeforeMs: index === 0 ? randomInt(50, 300) : randomInt(1000, 5000),
      splitIndex: index + 1,
      splitTotal: splitCount,
      splitPct: Number(((usdcAmount / total) * 100).toFixed(2)),
    };
  });

  logger.info(`Generated Solana split schedule for $${total.toFixed(2)}`, {
    splitCount,
    schedule: schedule.map((entry) => ({
      usdcAmount: entry.usdcAmount,
      delayBeforeMs: entry.delayBeforeMs,
      splitPct: entry.splitPct,
    })),
  });

  return schedule;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms || 0))));
}

module.exports = {
  applyPositionJitter,
  getRandomEntryDelay,
  shouldSplitSolanaTrade,
  generateSplitTradeSchedule,
  sleep,
  randomInt,
};
