'use strict';

/**
 * Memory — context insights (pure functions).
 *
 * Extracts getRegimeContext / getChainContext / getSymbolContext /
 * getTokenAgeContext from AgentMemory. Read-only over `data`; safe to call
 * concurrently; never mutates.
 *
 * Week 16.2 extraction (2026-05-23). Behavior identical to prior inline impl.
 */

function getRegimeContext(data, { regime = 'unknown', strategy = 'momentum' } = {}) {
  const key = `${regime}:${strategy}`;
  const all = data.regimeWinRates || {};
  const r = all[key] || { wins: 0, losses: 0 };
  const total = r.wins + r.losses;
  const winRate = total > 0 ? Math.round((r.wins / total) * 100) : null;
  const insights = [];
  if (total >= 5) {
    if (winRate >= 60) insights.push(`✅ ${regime}: ${winRate}% win rate (${total} ${strategy} trades)`);
    else if (winRate <= 35) insights.push(`⚠️ ${regime}: only ${winRate}% win rate (${total} ${strategy} trades) — require higher confidence`);
    else insights.push(`➡️ ${regime}: ${winRate}% win rate (${total} ${strategy} trades)`);
  }
  return { key, winRate, totalTrades: total, insights };
}

function getChainContext(data, { chain = 'unknown', strategy = 'momentum' } = {}) {
  const key = `${chain}:${strategy}`;
  const all = data.chainPatterns || {};
  const p = all[key] || { wins: 0, losses: 0, totalHoldMinutes: 0, tradeCount: 0 };
  const total = p.wins + p.losses;
  const winRate = total > 0 ? Math.round((p.wins / total) * 100) : null;
  const avgHold = p.tradeCount > 0 ? Math.round(p.totalHoldMinutes / p.tradeCount) : null;
  const insights = [];
  if (total >= 3) {
    if (winRate !== null) insights.push(`${chain} ${strategy}: ${winRate}% win rate (${total} trades)`);
    if (avgHold !== null) insights.push(`${chain} avg hold: ${avgHold}min`);
  }
  return { key, winRate, totalTrades: total, avgHoldMinutes: avgHold, insights };
}

function getSymbolContext(data, { symbol = '', strategy = 'momentum', windowDays = 14 } = {}) {
  const all = data.symbolWinRates || {};
  const key = `${String(symbol || '').toUpperCase()}:${strategy}`;
  const r = all[key];
  if (!r) return { key, recentLosses: 0, recentWins: 0, totalPnlUsd: 0, penaltyPct: 0, insights: [] };
  const ageMs = Date.now() - Number(r.lastTradeTs || 0);
  const stale = ageMs > windowDays * 24 * 3600 * 1000;
  if (stale) return { key, recentLosses: 0, recentWins: 0, totalPnlUsd: 0, penaltyPct: 0, insights: [] };
  const recentLosses = Number(r.losses || 0);
  const recentWins = Number(r.wins || 0);
  const totalPnlUsd = Number(r.totalPnlUsd || 0);
  const penaltyPct = Math.max(0, Math.min(20, recentLosses * 5 - recentWins * 3));
  const insights = [];
  if (recentLosses >= 3 && recentWins === 0) {
    insights.push(`⚠️ ${symbol} has lost ${recentLosses}× in last ${windowDays}d (cumulative $${totalPnlUsd.toFixed(2)})`);
  } else if (recentLosses >= 2) {
    insights.push(`${symbol} recent record: ${recentWins}W/${recentLosses}L`);
  }
  return { key, recentLosses, recentWins, totalPnlUsd, penaltyPct, insights };
}

function getTokenAgeContext(data, { tokenAgeBucket = 'unknown', strategy = 'momentum' } = {}) {
  const key = `${tokenAgeBucket}:${strategy}`;
  const all = data.tokenAgePatterns || {};
  const p = all[key] || { wins: 0, losses: 0, tradeCount: 0 };
  const total = p.wins + p.losses;
  const winRate = total > 0 ? Math.round((p.wins / total) * 100) : null;
  const insights = [];
  if (total >= 3 && winRate !== null) {
    if (winRate < 35) insights.push(`⚠️ ${tokenAgeBucket} tokens (${strategy}): ${winRate}% win rate — require higher confidence`);
    else insights.push(`${tokenAgeBucket} tokens (${strategy}): ${winRate}% win rate (${total} trades)`);
  }
  return { key, winRate, totalTrades: total, insights };
}

module.exports = {
  getRegimeContext,
  getChainContext,
  getSymbolContext,
  getTokenAgeContext,
};
