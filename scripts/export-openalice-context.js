'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const config = require('../config');

function getProfile() {
  return String(process.env.BOT_PROFILE || (process.env.PAPER_TRADING === 'true' ? 'paper' : 'live')).toLowerCase();
}

function loadJson(filePath, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function toTrackedRows(tracked) {
  if (Array.isArray(tracked)) return tracked;
  if (tracked && typeof tracked === 'object') return Object.values(tracked);
  return [];
}

function buildGuards() {
  return [
    { type: 'maxPositionSizePct', value: Number(config.risk?.maxPositionSizePct || 0) },
    { type: 'dailyDrawdownLimitPct', value: Number(config.risk?.dailyDrawdownLimitPct || 0) },
    { type: 'maxConcurrentPositions', value: Number(config.risk?.maxConcurrentPositions || 0) },
    { type: 'signalCascadeMinConfirmations', value: Number(config.risk?.signalCascadeMinConfirmations || 0) },
    { type: 'aiConfidenceFloor', value: Number(config.risk?.aiConfidenceFloor || 0) },
    { type: 'maxPortfolioHeatPct', value: Number(config.risk?.maxPortfolioHeatPct || 0) },
  ];
}

async function main() {
  const profile = getProfile();
  const statePath = profile === 'paper'
    ? path.resolve(process.cwd(), 'data/paper/state.json')
    : path.resolve(process.cwd(), 'data/state.json');
  const marketStatePath = profile === 'paper'
    ? path.resolve(process.cwd(), 'data/paper/marketState.json')
    : path.resolve(process.cwd(), 'data/marketState.json');
  const agentMemoryPath = profile === 'paper'
    ? path.resolve(process.cwd(), 'data/paper/agent-memory.json')
    : path.resolve(process.cwd(), 'data/agent-memory.json');
  const outPath = path.resolve(process.cwd(), process.argv[2] || `artifacts/agent/openalice-context-${profile}.json`);

  const state = loadJson(statePath, {});
  const marketState = loadJson(marketStatePath, {});
  const agentMemory = loadJson(agentMemoryPath, {});
  const trackedTokens = toTrackedRows(marketState.trackedTokens || marketState.market?.trackedTokens);
  const recentSignals = Array.isArray(marketState.recentSignals) ? marketState.recentSignals : [];
  const trades = Array.isArray(state.completedTrades) ? state.completedTrades : [];
  const openPositions = Array.isArray(state.openPositions) ? state.openPositions : [];

  const payload = {
    generatedAt: new Date().toISOString(),
    profile,
    architecture: 'openalice_style_context_export',
    account: {
      cashBalanceUsd: Number(state.cashBalance || state.walletBalance || 0),
      walletBalanceUsd: Number(state.walletBalance || 0),
      deployedCapitalUsd: Number(state.deployedCapital || 0),
      openPositionCount: openPositions.length,
      chainBalancesUsd: state.chainBalancesUsd || {},
    },
    guards: buildGuards(),
    positions: openPositions.slice(0, 25).map((position) => ({
      symbol: position.symbol,
      chain: position.chain,
      strategy: position.strategy,
      entryPrice: position.entryPrice,
      currentPrice: position.currentPrice,
      unrealizedPnlPct: position.unrealizedPnlPct,
      stopLoss: position.stopLoss,
      takeProfit: position.takeProfit,
      openedAt: position.openedAt,
      triggerTimeframe: position.triggerTimeframe,
    })),
    recentTrades: trades.slice(-50).map((trade) => ({
      symbol: trade.symbol,
      chain: trade.chain,
      side: trade.type || trade.side,
      strategy: trade.strategy,
      price: trade.price,
      valueUsd: trade.valueUsd,
      pnl: trade.pnl,
      timestamp: trade.timestamp,
      reason: trade.reason,
    })),
    watchlist: trackedTokens
      .filter((token) => ['BUY', 'SCANNING', 'HOLD'].includes(String(token.finalSignal || '').toUpperCase()))
      .sort((left, right) => Number(right.indicators?.volumeSpike || 0) - Number(left.indicators?.volumeSpike || 0))
      .slice(0, 40)
      .map((token) => ({
        symbol: token.symbol,
        address: token.address,
        chainKey: token.chainKey,
        strategy: token.strategy,
        finalSignal: token.finalSignal,
        technicalSignal: token.technicalSignal,
        notBoughtReason: token.notBoughtReason || '',
        rsi: token.indicators?.rsi,
        volumeSpike: token.indicators?.volumeSpike,
        priceChange24h: token.priceChange24h,
      })),
    recentSignals: recentSignals.slice(0, 25),
    memory: {
      lessons: Array.isArray(agentMemory.lessons) ? agentMemory.lessons.length : 0,
      discoveries: Array.isArray(agentMemory.discoveries) ? agentMemory.discoveries.length : 0,
      blacklist: Array.isArray(agentMemory.blacklist) ? agentMemory.blacklist.length : 0,
    },
  };

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
  console.log(JSON.stringify({ outPath, profile, openPositions: openPositions.length, tracked: trackedTokens.length }));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
