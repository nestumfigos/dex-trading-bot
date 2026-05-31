'use strict';

const { calculateTimeOpenAnchors } = require('../strategies/perps-anchors');
const { detectHorizontalRange } = require('../strategies/perps-range-detector');
const { evaluateTraderXoEntry, evaluatePositionManagement, rewardRisk } = require('../strategies/traderxo-paper-engine');
const { calculatePaperPosition } = require('../strategies/perps-sizing');
const { evaluatePaperPerpsRisk } = require('../risk/perps-gates');
const { resolveStrategyVariant, evaluateVariantEntry } = require('../strategies/traderxo-research-variants');

const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;
const FIVE_MINUTES_MS = 5 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function classifyMarketRegime(candles) {
  const window = (Array.isArray(candles) ? candles : []).slice(-12);
  if (window.length < 4) return 'unknown';
  const firstClose = Number(window[0].close);
  const lastClose = Number(window[window.length - 1].close);
  if (!Number.isFinite(firstClose) || firstClose <= 0 || !Number.isFinite(lastClose)) return 'unknown';
  const directionPct = (Math.abs(lastClose - firstClose) / firstClose) * 100;
  const averageRangePct = window.reduce((sum, candle) => (
    sum + ((Number(candle.high) - Number(candle.low)) / Number(candle.close)) * 100
  ), 0) / window.length;
  if (averageRangePct >= 2) return 'volatile';
  if (directionPct >= 3) return 'trending';
  return 'ranging';
}

function summarizeGroup(trades) {
  const pnlUsd = trades.reduce((sum, trade) => sum + trade.pnlUsd, 0);
  const grossProfit = trades.reduce((sum, trade) => sum + Math.max(0, trade.pnlUsd), 0);
  const grossLoss = trades.reduce((sum, trade) => sum + Math.min(0, trade.pnlUsd), 0);
  return {
    trades: trades.length,
    pnlUsd,
    expectancyUsd: trades.length ? pnlUsd / trades.length : 0,
    winRatePct: trades.length ? (trades.filter((trade) => trade.pnlUsd > 0).length / trades.length) * 100 : 0,
    profitFactor: grossLoss < 0 ? grossProfit / Math.abs(grossLoss) : null,
  };
}

function summarizeBy(trades, key) {
  const groups = trades.reduce((summary, trade) => {
    const value = String(trade[key] || 'unknown');
    if (!summary[value]) summary[value] = [];
    summary[value].push(trade);
    return summary;
  }, {});
  return Object.fromEntries(
    Object.entries(groups).map(([value, rows]) => [value, summarizeGroup(rows)]),
  );
}

function summarizeCompletedTrades(trades, { startingEquityUsd, totalSignals, rejectReasons, openPosition }) {
  const grossProfit = trades.reduce((sum, trade) => sum + Math.max(0, trade.pnlUsd), 0);
  const grossLoss = trades.reduce((sum, trade) => sum + Math.min(0, trade.pnlUsd), 0);
  const pnlUsd = grossProfit + grossLoss;
  const costsUsd = trades.reduce((sum, trade) => sum + trade.feesUsd + trade.slippageUsd + trade.fundingUsd, 0);
  const stressedPnlUsd = trades.reduce((sum, trade) => (
    sum
    + Number(trade.grossPnlUsd || 0)
    - Number(trade.fundingUsd || 0)
    - Number(trade.feesUsd || 0)
    - (2 * Number(trade.slippageUsd || 0))
  ), 0);
  let peak = startingEquityUsd;
  let equity = startingEquityUsd;
  let maxDrawdownPct = 0;
  trades.forEach((trade) => {
    equity += trade.pnlUsd;
    peak = Math.max(peak, equity);
    maxDrawdownPct = Math.max(maxDrawdownPct, peak > 0 ? ((peak - equity) / peak) * 100 : 0);
  });
  const wins = trades.filter((trade) => trade.pnlUsd > 0).length;
  return {
    completedTrades: trades.length,
    totalSignals,
    wins,
    losses: trades.length - wins,
    winRatePct: trades.length ? (wins / trades.length) * 100 : 0,
    pnlUsd,
    returnPct: startingEquityUsd > 0 ? (pnlUsd / startingEquityUsd) * 100 : 0,
    profitFactor: grossLoss < 0 ? grossProfit / Math.abs(grossLoss) : null,
    expectancyUsd: trades.length ? pnlUsd / trades.length : 0,
    averageR: trades.length ? trades.reduce((sum, trade) => sum + trade.rMultiple, 0) / trades.length : 0,
    maxDrawdownPct,
    feesPaidUsd: trades.reduce((sum, trade) => sum + trade.feesUsd, 0),
    slippagePaidUsd: trades.reduce((sum, trade) => sum + trade.slippageUsd, 0),
    fundingPaidUsd: trades.reduce((sum, trade) => sum + trade.fundingUsd, 0),
    totalCostsUsd: costsUsd,
    stressedPnlUsd,
    stressedExpectancyUsd: trades.length ? stressedPnlUsd / trades.length : 0,
    liquidationNearMisses: trades.filter((trade) => trade.liquidationBufferMultiple < 2).length,
    byRegime: summarizeBy(trades, 'regime'),
    bySetup: summarizeBy(trades, 'setup'),
    byExitReason: summarizeBy(trades, 'exitReason'),
    bySide: summarizeBy(trades, 'side'),
    bySetupGrade: summarizeBy(trades, 'setupGrade'),
    losingTradesReachedOneR: trades.filter((trade) => trade.pnlUsd < 0 && trade.maxFavorableR >= 1).length,
    averageHoldingHours: trades.length
      ? trades.reduce((sum, trade) => sum + trade.heldHours, 0) / trades.length
      : 0,
    openPositionAtEnd: openPosition ? {
      symbol: openPosition.symbol,
      side: openPosition.side,
      entryPrice: openPosition.entryPrice,
      openedAt: openPosition.openedAt,
    } : null,
    rejectReasons,
  };
}

function runHistoricalReplay({
  symbol,
  candles5m = [],
  candles15m = [],
  candles1h = [],
  dailyCandles = [],
  startingEquityUsd = 10000,
  leverage = 3,
  riskPct = 0.5,
  feeBps = 5,
  slippageBps = 2,
  fundingBpsPerEightHours = 1,
  evaluateEntry = evaluateTraderXoEntry,
  detectRange = detectHorizontalRange,
  calculateAnchors = calculateTimeOpenAnchors,
  variantId = 'baseline',
} = {}) {
  const variant = resolveStrategyVariant(variantId);
  const startEquity = Number(startingEquityUsd);
  if (!symbol || !Number.isFinite(startEquity) || startEquity <= 0) throw new Error('symbol and positive startingEquityUsd are required');
  const feeRate = Number(feeBps) / 10000;
  const slippageRate = Number(slippageBps) / 10000;
  const fundingRate = Number(fundingBpsPerEightHours) / 10000;
  if ([feeRate, slippageRate, fundingRate].some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error('cost assumptions must be finite and non-negative');
  }
  let equityUsd = startEquity;
  let position = null;
  let totalSignals = 0;
  const closedTrades = [];
  const rejectReasons = {};

  const reject = (reason) => {
    rejectReasons[reason] = Number(rejectReasons[reason] || 0) + 1;
  };
  const countFundingSettlements = (openedAtMs, closedAtMs) => {
    const openMs = Number(openedAtMs);
    const closeMs = Number(closedAtMs);
    if (!Number.isFinite(openMs) || !Number.isFinite(closeMs) || closeMs <= openMs) return 0;
    const fundingHours = [0, 8, 16];
    const startUtc = new Date(openMs);
    const endUtc = new Date(closeMs);
    const cursor = new Date(Date.UTC(startUtc.getUTCFullYear(), startUtc.getUTCMonth(), startUtc.getUTCDate()));
    const sentinel = new Date(Date.UTC(endUtc.getUTCFullYear(), endUtc.getUTCMonth(), endUtc.getUTCDate() + 1));
    let count = 0;
    while (cursor < sentinel) {
      for (const hour of fundingHours) {
        const boundary = Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth(), cursor.getUTCDate(), hour, 0, 0);
        if (boundary > openMs && boundary <= closeMs) count += 1;
      }
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    return count;
  };
  const rollingRisk = (timestamp) => {
    const rowsIn = (milliseconds) => closedTrades.filter((trade) => timestamp - trade.closedAtMs <= milliseconds);
    const summarize = (rows) => ({
      pnlUsd: rows.reduce((sum, trade) => sum + trade.pnlUsd, 0),
      r: rows.reduce((sum, trade) => sum + trade.rMultiple, 0),
    });
    const daily = summarize(rowsIn(DAY_MS));
    const weekly = summarize(rowsIn(7 * DAY_MS));
    return { dailyPnlUsd: daily.pnlUsd, dailyR: daily.r, weeklyPnlUsd: weekly.pnlUsd, weeklyR: weekly.r };
  };
  const recordExit = (management, timestamp) => {
    const notionalUsd = Number(management.notionalUsd || position.remainingNotionalUsd);
    const movePct = position.side === 'long'
      ? (Number(management.price) - position.entryPrice) / position.entryPrice
      : (position.entryPrice - Number(management.price)) / position.entryPrice;
    const entryAllocation = notionalUsd / position.notionalUsd;
    const grossPnlUsd = notionalUsd * movePct;
    const feesUsd = (notionalUsd * feeRate) + (position.entryFeeUsd * entryAllocation);
    const slippageUsd = (notionalUsd * slippageRate) + (position.entrySlippageUsd * entryAllocation);
    const heldHours = Math.max(0, timestamp - position.openedAtMs) / HOUR_MS;
    const fundingUsd = notionalUsd * fundingRate * countFundingSettlements(position.openedAtMs, timestamp);
    const costsUsd = feesUsd + slippageUsd + fundingUsd;
    const fill = { grossPnlUsd, feesUsd, slippageUsd, fundingUsd, costsUsd, pnlUsd: grossPnlUsd - costsUsd };
    position.fills.push(fill);
    position.remainingNotionalUsd -= notionalUsd;
    if (position.remainingNotionalUsd <= 0.000001) {
      const trade = {
        symbol: position.symbol,
        side: position.side,
        setup: position.setup,
        setupGrade: position.setupGrade,
        regime: position.regime,
        openedAt: position.openedAt,
        closedAt: new Date(timestamp).toISOString(),
        closedAtMs: timestamp,
        exitReason: management.reason,
        plannedRewardRisk: position.plannedRewardRisk,
        heldHours: Math.max(0, timestamp - position.openedAtMs) / HOUR_MS,
        barsHeld: Math.floor(Math.max(0, timestamp - position.openedAtMs) / FIFTEEN_MINUTES_MS),
        maxFavorableR: position.maxFavorableR,
        maxAdverseR: position.maxAdverseR,
        riskUsd: position.riskUsd,
        grossPnlUsd: position.fills.reduce((sum, item) => sum + item.grossPnlUsd, 0),
        feesUsd: position.fills.reduce((sum, item) => sum + item.feesUsd, 0),
        slippageUsd: position.fills.reduce((sum, item) => sum + item.slippageUsd, 0),
        fundingUsd: position.fills.reduce((sum, item) => sum + item.fundingUsd, 0),
        costsUsd: position.fills.reduce((sum, item) => sum + item.costsUsd, 0),
        pnlUsd: position.fills.reduce((sum, item) => sum + item.pnlUsd, 0),
        liquidationBufferMultiple: position.liquidationBufferMultiple,
      };
      trade.rMultiple = trade.riskUsd > 0 ? trade.pnlUsd / trade.riskUsd : 0;
      closedTrades.push(trade);
      equityUsd += trade.pnlUsd;
      position = null;
    } else {
      const nextStopPrice = Number(management.nextStopPrice);
      if (Number.isFinite(nextStopPrice) && nextStopPrice > 0) {
        const currentStop = Number(position.stopPrice);
        if (
          !Number.isFinite(currentStop)
          || (position.side === 'long' && nextStopPrice > currentStop)
          || (position.side === 'short' && nextStopPrice < currentStop)
        ) {
          position.stopPrice = nextStopPrice;
          position.stopMoveReason = management.stopMoveReason || 'TARGET1_STOP_TO_BREAKEVEN';
        }
      }
    }
  };

  const decisions = (Array.isArray(candles15m) ? candles15m : []).slice().sort((a, b) => a.openTime - b.openTime);
  const sorted5m = (Array.isArray(candles5m) ? candles5m : []).slice().sort((a, b) => a.openTime - b.openTime);
  const sorted1h = (Array.isArray(candles1h) ? candles1h : []).slice().sort((a, b) => a.openTime - b.openTime);
  const sortedDaily = (Array.isArray(dailyCandles) ? dailyCandles : []).slice().sort((a, b) => a.openTime - b.openTime);
  let visible5mEnd = 0;
  let visible1hEnd = 0;
  let visibleDailyEnd = 0;
  const advanceVisibleEnd = (rows, end, timestamp, intervalMs, includeOpen = false) => {
    let nextEnd = end;
    while (
      nextEnd < rows.length
      && Number(rows[nextEnd].openTime) + (includeOpen ? 0 : intervalMs) <= timestamp
    ) nextEnd += 1;
    return nextEnd;
  };
  for (let decisionIndex = 0; decisionIndex < decisions.length; decisionIndex += 1) {
    const candle = decisions[decisionIndex];
    const timestamp = Number(candle.openTime) + FIFTEEN_MINUTES_MS;
    if (position) {
      const riskMove = Math.abs(Number(position.entryPrice) - Number(position.stopPrice));
      const favorableMove = position.side === 'long'
        ? Number(candle.high) - Number(position.entryPrice)
        : Number(position.entryPrice) - Number(candle.low);
      const adverseMove = position.side === 'long'
        ? Number(position.entryPrice) - Number(candle.low)
        : Number(candle.high) - Number(position.entryPrice);
      if (riskMove > 0) {
        position.maxFavorableR = Math.max(position.maxFavorableR, favorableMove / riskMove);
        position.maxAdverseR = Math.max(position.maxAdverseR, adverseMove / riskMove);
      }
      const barsSinceEntry = Math.floor((timestamp - position.openedAtMs) / FIFTEEN_MINUTES_MS);
      const management = evaluatePositionManagement({ position, candle, barsSinceEntry, policy: variant.management });
      if (management.action !== 'HOLD') recordExit(management, timestamp);
      continue;
    }
    visible5mEnd = advanceVisibleEnd(sorted5m, visible5mEnd, timestamp, FIVE_MINUTES_MS);
    visible1hEnd = advanceVisibleEnd(sorted1h, visible1hEnd, timestamp, HOUR_MS);
    visibleDailyEnd = advanceVisibleEnd(sortedDaily, visibleDailyEnd, timestamp, DAY_MS, true);
    const visible15m = decisions.slice(Math.max(0, decisionIndex - 23), decisionIndex + 1);
    const visible5m = sorted5m.slice(Math.max(0, visible5mEnd - 24), visible5mEnd);
    const visible1h = sorted1h.slice(0, visible1hEnd);
    const visibleDaily = sortedDaily.slice(Math.max(0, visibleDailyEnd - 40), visibleDailyEnd);
    if (visible15m.length < 3 || visible5m.length < 4 || visible1h.length < 8 || !visibleDaily.length) continue;
    const range = detectRange(visible1h.slice(0, -2).slice(-12));
    if (!range.qualifies) continue;
    const anchors = calculateAnchors({ dailyCandles: visibleDaily, currentPrice: candle.close });
    const monthlyOpen = Number(anchors.monthlyOpen);
    const levelToLevel = anchors.sideBias === 'long' && monthlyOpen > range.high
      ? { level: range.high, nextTarget: monthlyOpen }
      : anchors.sideBias === 'short' && monthlyOpen < range.low
        ? { level: range.low, nextTarget: monthlyOpen }
        : null;
    const intent = evaluateEntry({
      symbol,
      candles15m: visible15m,
      candles5m: visible5m,
      range,
      anchors,
      equityUsd,
      leverage,
      riskPct,
      levelToLevel,
    });
    if (!intent.qualifies) {
      (intent.reasons || []).forEach(reject);
      continue;
    }
    const regime = classifyMarketRegime(visible1h);
    const variantAdmission = evaluateVariantEntry({ intent, regime, variant });
    if (!variantAdmission.allow) {
      reject(variantAdmission.reason);
      continue;
    }
    totalSignals += 1;
    const executedRr = rewardRisk({
      side: intent.side,
      entry: intent.entry,
      stop: intent.stop,
      target: intent.targets[intent.targets.length - 1],
    });
    if (executedRr < 3) {
      reject('reward_risk_below_3');
      continue;
    }
    let sized;
    try {
      sized = calculatePaperPosition({ ...intent.order, equityUsd, riskPct: intent.order.riskPct, side: intent.side });
    } catch (error) {
      reject(error.message);
      continue;
    }
    const risk = evaluatePaperPerpsRisk({
      ...intent.order,
      ...rollingRisk(timestamp),
      equityUsd,
      liquidationBufferMultiple: sized.liquidationBufferMultiple,
    });
    if (!risk.allow) {
      risk.reasons.forEach(reject);
      continue;
    }
    position = {
      symbol,
      side: intent.side,
      setup: intent.setup,
      setupGrade: intent.setupGrade,
      regime,
      plannedRewardRisk: intent.rr,
      maxFavorableR: 0,
      maxAdverseR: 0,
      openedAt: new Date(timestamp).toISOString(),
      openedAtMs: timestamp,
      targets: intent.targets,
      entryFeeUsd: sized.notionalUsd * feeRate,
      entrySlippageUsd: sized.notionalUsd * slippageRate,
      fills: [],
      remainingNotionalUsd: sized.notionalUsd,
      ...sized,
    };
  }
  return {
    mode: 'historical-replay',
    market: 'perps',
    strategy: 'traderxo_perps',
    variant: { id: variant.id, label: variant.label },
    symbol,
    assumptions: {
      startingEquityUsd: startEquity,
      leverage,
      riskPct,
      feeBps,
      slippageBps,
      fundingBpsPerEightHours,
      source: 'completed_candles_only',
      persistsPaperTrades: false,
    },
    trades: closedTrades,
    summary: summarizeCompletedTrades(closedTrades, {
      startingEquityUsd: startEquity,
      totalSignals,
      rejectReasons,
      openPosition: position,
    }),
  };
}

module.exports = { runHistoricalReplay };
