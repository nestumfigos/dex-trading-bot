'use strict';

// Extracted from src/index.js (Week 12 A.8).
// Adaptive learning state: bad-token memory, sleeve performance, brain profiles.
// Mutates portfolio.learning. Pure JS, deps injected.

function createLearningBrain(deps) {
  const { config, logger, portfolio, normalizeChainKey } = deps;

  function ensureLearningStateShape() {
    if (!portfolio.learning || typeof portfolio.learning !== 'object') {
      portfolio.learning = {
        badTokenMemory: {},
        sleevePerformance: {},
        brainProfiles: {},
      };
    }

    if (!portfolio.learning.badTokenMemory || typeof portfolio.learning.badTokenMemory !== 'object') {
      portfolio.learning.badTokenMemory = {};
    }

    if (!portfolio.learning.sleevePerformance || typeof portfolio.learning.sleevePerformance !== 'object') {
      portfolio.learning.sleevePerformance = {};
    }

    if (!portfolio.learning.brainProfiles || typeof portfolio.learning.brainProfiles !== 'object') {
      portfolio.learning.brainProfiles = {};
    }

    if (!portfolio.intelligence || typeof portfolio.intelligence !== 'object') {
      portfolio.intelligence = { report: null, lastRunAt: 0, runCount: 0 };
    }

    const nowMs = Date.now();
    Object.entries(portfolio.learning.badTokenMemory).forEach(([tokenKey, record]) => {
      if (!record || typeof record !== 'object') {
        delete portfolio.learning.badTokenMemory[tokenKey];
        return;
      }

      const banUntilMs = Date.parse(record.banUntil || '');
      const hardBan = Boolean(record.hardBan);
      if (!hardBan && Number.isFinite(banUntilMs) && banUntilMs > 0 && banUntilMs < nowMs) {
        delete portfolio.learning.badTokenMemory[tokenKey];
      }
    });
  }

  function getLearningBrainProfileKey(chainKey, strategyName = 'momentum', lane = 'unknown', trigger = 'unknown') {
    const normalizedChain = normalizeChainKey(chainKey);
    const normalizedStrategy = String(strategyName || 'momentum').toLowerCase();
    const normalizedLane = String(lane || 'unknown').toLowerCase();
    const normalizedTrigger = String(trigger || 'unknown').toLowerCase();
    return `${normalizedChain}:${normalizedStrategy}:${normalizedLane}:${normalizedTrigger}`;
  }

  function updateBrainProfileFromClosedTrade(position = {}, finalTradePnl = 0) {
    if (config.risk?.learningEnabled === false || config.risk?.brainEnabled === false) return;

    ensureLearningStateShape();
    const lane = String(position.discoveryLane || position.entryLane || 'unknown').toLowerCase();
    const trigger = String(position.triggerTimeframe || position.entryTriggerTimeframe || 'unknown').toLowerCase();
    const brainProfileKey = getLearningBrainProfileKey(
      position.chainKey || position.chain,
      position.strategy || 'momentum',
      lane,
      trigger
    );

    const brainWindowTrades = Math.max(10, Number(config.risk?.brainWindowTrades || 40));
    const profile = portfolio.learning.brainProfiles[brainProfileKey] || {
      chainKey: normalizeChainKey(position.chainKey || position.chain),
      strategy: String(position.strategy || 'momentum').toLowerCase(),
      lane,
      trigger,
      samples: 0,
      wins: 0,
      losses: 0,
      totalPnl: 0,
      recentOutcomes: [],
      recentPnl: [],
      recentWinRatePct: 50,
      avgRecentPnlUsd: 0,
      lastUpdated: null,
    };

    const isWin = Number(finalTradePnl || 0) >= 0;
    profile.samples = Number(profile.samples || 0) + 1;
    if (isWin) profile.wins = Number(profile.wins || 0) + 1;
    else profile.losses = Number(profile.losses || 0) + 1;
    profile.totalPnl = Number(profile.totalPnl || 0) + Number(finalTradePnl || 0);
    profile.recentOutcomes = [...(Array.isArray(profile.recentOutcomes) ? profile.recentOutcomes : []), isWin ? 1 : 0].slice(-brainWindowTrades);
    profile.recentPnl = [...(Array.isArray(profile.recentPnl) ? profile.recentPnl : []), Number(finalTradePnl || 0)].slice(-brainWindowTrades);

    const recentCount = profile.recentOutcomes.length;
    const recentWins = profile.recentOutcomes.reduce((sum, value) => sum + (value ? 1 : 0), 0);
    profile.recentWinRatePct = recentCount > 0 ? (recentWins / recentCount) * 100 : 50;
    profile.avgRecentPnlUsd = profile.recentPnl.length > 0
      ? profile.recentPnl.reduce((sum, value) => sum + Number(value || 0), 0) / profile.recentPnl.length
      : 0;
    profile.lastUpdated = new Date().toISOString();

    portfolio.learning.brainProfiles[brainProfileKey] = profile;
    logger.info(
      `Brain profile update ${brainProfileKey}: samples=${profile.samples} ` +
      `winRate=${profile.recentWinRatePct.toFixed(1)}% avgPnl=${profile.avgRecentPnlUsd.toFixed(3)}`
    );
  }

  function getLearningTokenKey(tokenData = {}) {
    const chainKey = normalizeChainKey(tokenData.chainKey || tokenData.chain);
    const address = String(tokenData.address || '').trim().toLowerCase();
    if (!chainKey || !address) return '';
    return `${chainKey}:${address}`;
  }

  function getLearningSleeveKey(chainKey, strategyName = 'momentum') {
    return `${normalizeChainKey(chainKey)}:${String(strategyName || 'momentum').toLowerCase()}`;
  }

  function markTokenBadPattern(tokenData = {}, reason = '', options = {}) {
    if (config.risk?.learningEnabled === false) return;

    ensureLearningStateShape();
    const tokenKey = getLearningTokenKey(tokenData);
    if (!tokenKey) return;

    const nowIso = new Date().toISOString();
    const nowMs = Date.now();
    const cooldownHours = Math.max(1, Number(config.risk?.learnedPatternCooldownHours || 168));
    const hardBanHours = Math.max(cooldownHours, Number(config.risk?.learnedPatternHardBanHours || 720));
    const strikeThreshold = Math.max(1, Number(config.risk?.learnedPatternStrikeThreshold || 2));
    const hardBan = Boolean(options.hardBan);

    const current = portfolio.learning.badTokenMemory[tokenKey] || {
      chainKey: normalizeChainKey(tokenData.chainKey || tokenData.chain),
      symbol: tokenData.symbol || 'UNKNOWN',
      address: String(tokenData.address || '').trim(),
      strikes: 0,
      hardBan: false,
      firstSeen: nowIso,
      lastSeen: nowIso,
      reasons: [],
      lastReason: '',
      banUntil: nowIso,
    };

    current.symbol = tokenData.symbol || current.symbol;
    current.lastSeen = nowIso;
    current.lastReason = String(reason || '').slice(0, 240);
    current.reasons = [current.lastReason, ...(Array.isArray(current.reasons) ? current.reasons : [])]
      .filter(Boolean)
      .slice(0, 8);

    if (hardBan) {
      current.hardBan = true;
      current.strikes = Math.max(current.strikes, strikeThreshold);
      current.banUntil = new Date(nowMs + (hardBanHours * 3600 * 1000)).toISOString();
    } else {
      current.strikes = Number(current.strikes || 0) + 1;
      if (current.strikes >= strikeThreshold) {
        current.banUntil = new Date(nowMs + (cooldownHours * 3600 * 1000)).toISOString();
      }
    }

    portfolio.learning.badTokenMemory[tokenKey] = current;
    logger.warn(
      `Learned bad pattern: ${current.symbol} (${tokenKey}) strikes=${current.strikes} ` +
      `hardBan=${current.hardBan ? 'yes' : 'no'} until=${current.banUntil} reason=${current.lastReason}`
    );
  }

  function updateAdaptiveSleevePerformance(position = {}, finalTradePnl = 0) {
    if (config.risk?.learningEnabled === false || config.risk?.adaptiveSizingEnabled === false) return;

    ensureLearningStateShape();
    const sleeveKey = getLearningSleeveKey(position.chainKey || position.chain, position.strategy || 'momentum');
    if (!sleeveKey || sleeveKey.startsWith(':')) return;

    const windowTrades = Math.max(5, Number(config.risk?.adaptiveSizingWindowTrades || 20));
    const minTrades = Math.max(3, Number(config.risk?.adaptiveSizingMinTrades || 6));
    const lowWinRatePct = Math.max(0, Number(config.risk?.adaptiveSizingLowWinRatePct || 40));
    const highWinRatePct = Math.max(lowWinRatePct, Number(config.risk?.adaptiveSizingHighWinRatePct || 60));
    const reduceMultiplier = Math.max(0.1, Number(config.risk?.adaptiveSizingReduceMultiplier || 0.7));
    const boostMultiplier = Math.max(0.1, Number(config.risk?.adaptiveSizingBoostMultiplier || 1.05));
    const minMultiplier = Math.max(0.1, Number(config.risk?.adaptiveSizingMinMultiplier || 0.45));
    const maxMultiplier = Math.max(minMultiplier, Number(config.risk?.adaptiveSizingMaxMultiplier || 1.15));

    const sleeve = portfolio.learning.sleevePerformance[sleeveKey] || {
      outcomes: [],
      recentWinRatePct: 50,
      sizeMultiplier: 1,
      totalClosed: 0,
      wins: 0,
      losses: 0,
      lastUpdated: null,
    };

    const win = Number(finalTradePnl || 0) >= 0 ? 1 : 0;
    sleeve.outcomes = [...(Array.isArray(sleeve.outcomes) ? sleeve.outcomes : []), win].slice(-windowTrades);
    sleeve.totalClosed = Number(sleeve.totalClosed || 0) + 1;
    if (win) sleeve.wins = Number(sleeve.wins || 0) + 1;
    else sleeve.losses = Number(sleeve.losses || 0) + 1;

    const outcomeCount = sleeve.outcomes.length;
    const wins = sleeve.outcomes.reduce((sum, value) => sum + (value ? 1 : 0), 0);
    sleeve.recentWinRatePct = outcomeCount > 0 ? (wins / outcomeCount) * 100 : 50;

    let multiplier = 1;
    if (outcomeCount >= minTrades) {
      if (sleeve.recentWinRatePct < lowWinRatePct) multiplier = reduceMultiplier;
      else if (sleeve.recentWinRatePct >= highWinRatePct) multiplier = boostMultiplier;
    }
    sleeve.sizeMultiplier = Math.max(minMultiplier, Math.min(maxMultiplier, multiplier));
    sleeve.lastUpdated = new Date().toISOString();

    portfolio.learning.sleevePerformance[sleeveKey] = sleeve;
    logger.info(
      `Adaptive sleeve update ${sleeveKey}: winRate=${sleeve.recentWinRatePct.toFixed(1)}% ` +
      `window=${outcomeCount} sizeMultiplier=${sleeve.sizeMultiplier.toFixed(2)}`
    );
  }

  return {
    ensureLearningStateShape,
    getLearningBrainProfileKey,
    updateBrainProfileFromClosedTrade,
    getLearningTokenKey,
    getLearningSleeveKey,
    markTokenBadPattern,
    updateAdaptiveSleevePerformance,
  };
}

module.exports = { createLearningBrain };
