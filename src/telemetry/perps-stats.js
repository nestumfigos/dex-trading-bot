'use strict';

const fs = require('fs');
const path = require('path');

function readArray(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function persistSnapshotAtomic(filePath, snapshot) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  let handle;
  try {
    handle = fs.openSync(tmp, 'w');
    fs.writeFileSync(handle, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
    fs.fsyncSync(handle);
    fs.closeSync(handle);
    handle = null;
    fs.renameSync(tmp, filePath);
  } finally {
    if (handle !== null && handle !== undefined) fs.closeSync(handle);
    try {
      fs.rmSync(tmp, { force: true });
    } catch (_) {
      // The successful rename already removed the temporary file.
    }
  }
}

function isApprovedPerpsTrade(trade) {
  return trade?.market === 'perps'
    && trade?.strategy === 'traderxo_perps'
    && !String(trade.positionId || '').startsWith('paper-spot:')
    && !String(trade.signalId || '').startsWith('spot-');
}

function isApprovedPerpsPosition(position) {
  return position?.market === 'perps'
    && position?.strategy === 'traderxo_perps'
    && !String(position.id || '').startsWith('paper-spot:')
    && !String(position.signalId || '').startsWith('spot-');
}

// B1P.7: write-time guards. After purging spot contamination from data files,
// refuse to accept any new record that would re-introduce it. Symmetric with the
// read-side `isApprovedPerps*` filters so write + read converge on the same shape.
function assertPerpsTrade(trade) {
  if (!isApprovedPerpsTrade(trade)) {
    throw new Error(`telemetry rejected non-perps trade: id=${trade?.id} market=${trade?.market} strategy=${trade?.strategy} positionId=${trade?.positionId}`);
  }
}

function assertPerpsPosition(position) {
  if (!isApprovedPerpsPosition(position)) {
    throw new Error(`telemetry rejected non-perps position: id=${position?.id} market=${position?.market} strategy=${position?.strategy}`);
  }
}

function readAuthoritativeState(statePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (
      parsed?.version !== 1
      || !Array.isArray(parsed.trades)
      || !Array.isArray(parsed.openPositions)
      || !Array.isArray(parsed.signalEvents)
    ) {
      throw new Error('paper perps state snapshot has an invalid shape');
    }
    return parsed;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`paper perps authoritative state unavailable: ${error.message}`);
  }
}

function createPaperTelemetry({
  historyPath = path.resolve(process.cwd(), 'data', 'perps-paper-trades.json'),
  positionsPath = path.resolve(path.dirname(historyPath), 'perps-paper-open-positions.json'),
  signalsPath = path.resolve(path.dirname(historyPath), 'perps-paper-signals.json'),
  statePath = path.resolve(path.dirname(historyPath), 'perps-paper-state.json'),
  persistSnapshot = persistSnapshotAtomic,
  now = () => Date.now(),
} = {}) {
  let state = readAuthoritativeState(statePath);
  if (!state) {
    state = {
      version: 1,
      revision: 0,
      migratedFromLegacyFiles: true,
      trades: readArray(historyPath),
      openPositions: readArray(positionsPath).filter(isApprovedPerpsPosition),
      signalEvents: readArray(signalsPath),
    };
    persistSnapshot(statePath, state);
  }

  function commit(mutator) {
    const next = {
      ...state,
      revision: Number(state.revision || 0) + 1,
      updatedAt: new Date(Number(now())).toISOString(),
      trades: state.trades.map((trade) => ({ ...trade })),
      openPositions: state.openPositions.map((position) => ({ ...position })),
      signalEvents: state.signalEvents.map((event) => ({ ...event })),
    };
    mutator(next);
    persistSnapshot(statePath, next);
    state = next;
  }

  function recordTrade(trade) {
    assertPerpsTrade(trade); // B1P.7
    commit((next) => next.trades.push({ ...trade }));
  }

  function upsertOpenPosition(position) {
    assertPerpsPosition(position); // B1P.7
    commit((next) => {
      next.openPositions = next.openPositions.filter((item) => String(item.id) !== String(position.id));
      next.openPositions.push({ ...position });
    });
  }

  function removeOpenPosition(positionId) {
    commit((next) => {
      next.openPositions = next.openPositions.filter((item) => String(item.id) !== String(positionId));
    });
  }

  function commitExecution({ trade = null, position = null, removePositionId = null, signalEvent = null } = {}) {
    if (trade) assertPerpsTrade(trade); // B1P.7
    if (position) assertPerpsPosition(position); // B1P.7
    commit((next) => {
      if (trade) next.trades.push({ ...trade });
      if (removePositionId != null) {
        next.openPositions = next.openPositions.filter((item) => String(item.id) !== String(removePositionId));
      }
      if (position) {
        next.openPositions = next.openPositions.filter((item) => String(item.id) !== String(position.id));
        next.openPositions.push({ ...position });
      }
      if (signalEvent) next.signalEvents.push({ ...signalEvent });
    });
  }

  function listOpenPositions() {
    return state.openPositions.map((position) => ({ ...position }));
  }

  function hasSignal(signalId) {
    return state.signalEvents.some((event) => String(event.signalId) === String(signalId));
  }

  function recordSignalEvent(event) {
    commit((next) => next.signalEvents.push({ ...event }));
  }

  function listSignalEvents() {
    return state.signalEvents.slice().reverse();
  }

  function listTrades() {
    return state.trades.filter(isApprovedPerpsTrade).slice().reverse();
  }

  function excludedTradeCount() {
    return state.trades.filter((trade) => !isApprovedPerpsTrade(trade)).length;
  }

  function listCompletedPositions() {
    const grouped = new Map();
    state.trades.filter((trade) => isApprovedPerpsTrade(trade) && trade.type === 'EXIT').forEach((trade) => {
      const key = String(trade.lifecycleId || trade.positionId || trade.id);
      const fills = grouped.get(key) || [];
      fills.push(trade);
      grouped.set(key, fills);
    });
    return Array.from(grouped.values())
      .filter((fills) => fills.some((trade) => trade.closed === true) || fills.every((trade) => trade.closed == null))
      .map((fills) => ({
        ...fills[fills.length - 1],
        pnlUsd: fills.reduce((sum, trade) => sum + Number(trade.pnlUsd || 0), 0),
        fundingUsd: fills.reduce((sum, trade) => sum + Number(trade.fundingUsd || 0), 0),
        feeUsd: fills.reduce((sum, trade) => sum + Number(trade.feeUsd || 0), 0),
        slippageUsd: fills.reduce((sum, trade) => sum + Number(trade.slippageUsd || 0), 0),
        liquidationBufferMultiple: Math.min(...fills.map((trade) => Number(trade.liquidationBufferMultiple ?? Infinity))),
      }));
  }

  // B1P.5 (verified no-fix): the rolling daily/weekly summary reads from
  // `state.trades`, which is persisted via `persistSnapshotAtomic` on every commit.
  // After restart, `readAuthoritativeState` rehydrates the same trade list, so
  // pre-restart fills inside the 24h/168h window contribute correctly to dailyR
  // and weeklyR. Audit finding 02-risk.md #2 conflated "no fixed-clock reset"
  // (true — rolling window by design) with "loss-trackers reset on restart"
  // (false — state persists). If a fixed-UTC daily window is later desired,
  // change the cutoff math here; the persistence layer requires no change.
  function riskWindowSummary() {
    const current = Number(now());
    const oneDayAgo = current - (24 * 60 * 60 * 1000);
    const oneWeekAgo = current - (7 * 24 * 60 * 60 * 1000);
    const closed = listCompletedPositions();
    const inWindow = (trade, cutoff) => Date.parse(trade.closedAt || 0) >= cutoff;
    const sumPnl = (rows) => rows.reduce((sum, trade) => sum + Number(trade.pnlUsd || 0), 0);
    const sumR = (rows) => rows.reduce((sum, trade) => {
      const riskUsd = Number(trade.riskUsd || 0);
      return riskUsd > 0 ? sum + (Number(trade.pnlUsd || 0) / riskUsd) : sum;
    }, 0);
    const daily = closed.filter((trade) => inWindow(trade, oneDayAgo));
    const weekly = closed.filter((trade) => inWindow(trade, oneWeekAgo));
    return {
      dailyPnlUsd: sumPnl(daily),
      weeklyPnlUsd: sumPnl(weekly),
      dailyR: sumR(daily),
      weeklyR: sumR(weekly),
    };
  }

  function stats() {
    const closed = listCompletedPositions();
    const wins = closed.filter((trade) => Number(trade.pnlUsd) > 0).length;
    const grossProfit = closed.reduce((sum, trade) => sum + Math.max(0, Number(trade.pnlUsd || 0)), 0);
    const grossLoss = closed.reduce((sum, trade) => sum + Math.min(0, Number(trade.pnlUsd || 0)), 0);
    const pnlUsd = grossProfit + grossLoss;
    // B2P.30: stressed-expectancy formula change. Previously doubled ALL three
    // cost categories (funding + fees + slippage) which over-penalized long-hold
    // strategies — funding is unavoidable accrual, not execution risk. New
    // formula: subtract funding+fees at face value (they happen exactly once)
    // and double ONLY slippage (the execution-risk component the stress test is
    // meant to surface). Matches PERPS_BOOTSTRAP D.13 intent.
    const stressedPnlUsd = closed.reduce((sum, trade) => (
      sum + Number(trade.grossPnlUsd || 0)
      - Number(trade.fundingUsd || 0)
      - Number(trade.feeUsd || 0)
      - (2 * Number(trade.slippageUsd || 0))
    ), 0);
    const nearMisses = closed.filter((trade) => Number(trade.liquidationBufferMultiple) < 2).length;
    return {
      trades: closed.length,
      closed: closed.length,
      wins,
      winRatePct: closed.length ? (wins / closed.length) * 100 : 0,
      pnlUsd,
      profitFactor: grossLoss < 0 ? grossProfit / Math.abs(grossLoss) : null,
      fundingPaidUsd: closed.reduce((sum, trade) => sum + Number(trade.fundingUsd || 0), 0),
      feesPaidUsd: closed.reduce((sum, trade) => sum + Number(trade.feeUsd || 0), 0),
      slippagePaidUsd: closed.reduce((sum, trade) => sum + Number(trade.slippageUsd || 0), 0),
      liquidationNearMisses: nearMisses,
      expectancyUsd: closed.length ? pnlUsd / closed.length : 0,
      stressedPnlUsd,
      stressedExpectancyUsd: closed.length ? stressedPnlUsd / closed.length : 0,
      excludedNonPerpsTrades: excludedTradeCount(),
    };
  }

  function evidence({ observationDays = 0 } = {}) {
    const summary = stats();
    const reasons = [];
    if (Number(observationDays) < 28) reasons.push('paper_observation_under_28_days');
    if (summary.closed < 200) reasons.push('paper_trades_under_200');
    if (summary.expectancyUsd <= 0) reasons.push('expectancy_not_positive_after_costs');
    if (summary.stressedExpectancyUsd <= 0) reasons.push('stressed_expectancy_not_positive_after_2x_costs');
    if (summary.liquidationNearMisses > 0) reasons.push('liquidation_near_misses_present');
    return { passed: reasons.length === 0, reasons, summary };
  }

  return {
    recordTrade,
    upsertOpenPosition,
    removeOpenPosition,
    commitExecution,
    listOpenPositions,
    hasSignal,
    recordSignalEvent,
    listSignalEvents,
    listTrades,
    excludedTradeCount,
    listCompletedPositions,
    riskWindowSummary,
    stats,
    evidence,
  };
}

module.exports = { createPaperTelemetry };
