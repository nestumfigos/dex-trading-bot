'use strict';

const { randomUUID } = require('crypto');
const { calculatePaperPosition } = require('../strategies/perps-sizing');
const { evaluatePaperPerpsRisk } = require('../risk/perps-gates');
const { buildReduceOnlyExit } = require('../exits/perps-reduce-only');

// B1P.9: mode is one of 'paper' | 'canary' | 'live'. Plumbed into the risk gate so
// canary/live modes inherit position-count caps + equity floor + tighter leverage cap.
function createPaperExecutionAdapter({ telemetry, entryAdmission = null, mode = 'paper', now = () => new Date().toISOString() } = {}) {
  const positions = new Map(
    (telemetry?.listOpenPositions?.() || []).map((position) => [String(position.id), { ...position }]),
  );

  function openPosition(order = {}, { signalEvent = null } = {}) {
    const admitted = entryAdmission?.getEntryPolicy?.();
    if (admitted && !admitted.allow) return { accepted: false, reasons: [admitted.reason] };
    if (admitted?.variant && order.variantId && order.variantId !== admitted.variant.id) {
      return { accepted: false, reasons: ['strategy_variant_not_admitted'] };
    }
    const admittedVariantId = admitted?.variant?.id || order.variantId || 'baseline';
    const id = String(order.id || `paper-perp-${Date.now()}`);
    if (positions.has(id)) return { accepted: false, reasons: ['position_already_open'] };
    const maxRiskPct = order.isAPlus === true || order.setupGrade === 'A+' ? 1 : 0.5;
    if (!Number.isFinite(Number(order.riskPct)) || Number(order.riskPct) <= 0 || Number(order.riskPct) > maxRiskPct) {
      return { accepted: false, reasons: ['risk_pct_above_strategy_cap'] };
    }
    let sized;
    try {
      sized = calculatePaperPosition(order);
    } catch (error) {
      return { accepted: false, reasons: [error.message] };
    }
    const openPositions = Array.from(positions.values());
    const reservedMarginUsd = openPositions.reduce((sum, position) => (
      sum + (Number(position.remainingNotionalUsd || 0) / Number(position.leverage || 1))
    ), 0);
    // B2P.22: openRiskUsd uses CURRENT equity for budgeting, not point-in-time
    // entry equity. Previously `position.riskUsd` was stored at entry as
    // (entry_equity × riskPct/100). After winning trades grew equity, the
    // budget anchor stayed at the original equity, so the next trade's risk
    // cap was implicitly higher relative to current equity (profits leaked
    // back into the risk budget without re-anchoring). Recompute against
    // current equity using each position's recorded riskPct.
    const currentEquity = Number(order.equityUsd || 0);
    const openRiskUsd = openPositions.reduce((sum, position) => {
      const originalNotional = Number(position.notionalUsd || 0);
      const remainingFraction = originalNotional > 0
        ? Number(position.remainingNotionalUsd || 0) / originalNotional
        : 0;
      const dynamicRiskUsd = currentEquity > 0 && Number.isFinite(Number(position.riskPct))
        ? currentEquity * (Number(position.riskPct) / 100)
        : Number(position.riskUsd || 0); // fallback to stored
      return sum + (dynamicRiskUsd * remainingFraction);
    }, 0);
    const riskState = telemetry?.riskWindowSummary?.() || {};
    const risk = evaluatePaperPerpsRisk({
      ...order,
      ...riskState,
      liquidationBufferMultiple: sized.liquidationBufferMultiple,
      requiredMarginUsd: sized.marginUsd,
      reservedMarginUsd,
      candidateRiskUsd: sized.riskUsd,
      openRiskUsd,
      // B1P.9: canary/live cap on concurrent positions; paper unbounded.
      mode,
      openPositionCount: openPositions.length,
    });
    if (!risk.allow) return { accepted: false, reasons: risk.reasons };
    // B2P.14: real binance perps fees are maker 0.02% / taker 0.04%.
    // Order type determines tier. Default to taker (worst case) when missing.
    // Caller MAY override via order.makerFeeRate / order.takerFeeRate per symbol/account.
    const orderType = String(order.orderType || 'market').toLowerCase();
    const makerFeeRate = Number.isFinite(Number(order.makerFeeRate)) ? Number(order.makerFeeRate) : 0.0002;
    const takerFeeRate = Number.isFinite(Number(order.takerFeeRate)) ? Number(order.takerFeeRate) : 0.0004;
    const entryFeeRate = orderType === 'limit' ? makerFeeRate : takerFeeRate;
    const position = {
      id,
      lifecycleId: String(order.lifecycleId || randomUUID()),
      signalId: order.signalId || null,
      symbol: order.symbol,
      market: order.market || 'perps',
      strategy: order.strategy || 'traderxo_perps',
      setup: order.setup || null,
      setupGrade: order.setupGrade || null,
      variantId: admittedVariantId,
      targets: Array.isArray(order.targets) ? order.targets.map(Number) : [],
      anchorBias: order.anchorBias || null,
      range: order.range || null,
      manualCutReasons: order.manualCutReasons || [],
      invalidationReason: order.invalidationReason || null,
      openedMarketAt: order.openedMarketAt || null,
      openedAt: now(),
      remainingNotionalUsd: sized.notionalUsd,
      entryFeeUsd: sized.notionalUsd * entryFeeRate,
      entryFeeRate,
      entryOrderType: orderType,
      makerFeeRate,
      takerFeeRate,
      // B2P.15: depth-aware slippage. Flat 2bps under-prices large positions.
      // baseSlippageBps = order.baseSlippageBps ?? 2. Penalty scales with
      // notional/depth ratio so 30k-notional on a 100k-depth book pays meaningfully
      // more than 5k on the same depth. Caller MAY pass `depthUsd` from the
      // orderbook snapshot at signal time; missing depth falls back to flat base.
      entrySlippageUsd: (function() {
        const baseSlippageBps = Math.max(0, Number(order.baseSlippageBps ?? 2));
        const depthUsd = Number(order.depthUsd || 0);
        const penaltyFactor = Number(order.slippagePenaltyBpsPerDepthRatio ?? 50);
        const ratioPenaltyBps = depthUsd > 0
          ? Math.min(200, (sized.notionalUsd / depthUsd) * penaltyFactor)
          : 0;
        return sized.notionalUsd * ((baseSlippageBps + ratioPenaltyBps) / 10000);
      })(),
      entrySlippageBps: (function() {
        const baseSlippageBps = Math.max(0, Number(order.baseSlippageBps ?? 2));
        const depthUsd = Number(order.depthUsd || 0);
        const penaltyFactor = Number(order.slippagePenaltyBpsPerDepthRatio ?? 50);
        return depthUsd > 0
          ? baseSlippageBps + Math.min(200, (sized.notionalUsd / depthUsd) * penaltyFactor)
          : baseSlippageBps;
      })(),
      fundingRatePerEightHours: Math.max(0, Number(order.fundingBpsPerEightHours ?? 1) / 10000),
      // B2P.22: persist riskPct so future-equity-aware risk budgeting at open time
      // can recompute dynamic riskUsd = currentEquity * riskPct/100 per position.
      riskPct: Number(order.riskPct),
      ...sized,
    };
    const acceptedSignalEvent = signalEvent ? { ...signalEvent, accepted: true, reasons: [] } : null;
    if (typeof telemetry?.commitExecution === 'function') {
      telemetry.commitExecution({ position, signalEvent: acceptedSignalEvent });
    } else {
      telemetry?.upsertOpenPosition?.(position);
    }
    positions.set(id, position);
    return { accepted: true, position, signalEventCommitted: Boolean(acceptedSignalEvent && telemetry?.commitExecution) };
  }

  function reduceOnlyExit({
    positionId,
    notionalUsd,
    price,
    reason = 'MANUAL_EXIT',
    fundingUsd = 0,
    feeUsd = 0,
    slippageUsd = 0,
    signalId = null,
  } = {}, { signalEvent = null } = {}) {
    const position = positions.get(String(positionId));
    if (!position) return { accepted: false, reasons: ['position_not_found'] };
    let order;
    try {
      order = buildReduceOnlyExit({ position, notionalUsd, price, reason });
    } catch (error) {
      return { accepted: false, reasons: [error.message] };
    }
    // B1P.1: hard-assert reduceOnly on every outbound exit. Prevents accidental
    // direction-flip if buildReduceOnlyExit (or any future call site) ever drops the flag.
    if (order.reduceOnly !== true) {
      throw new Error('reduceOnly_required_on_exit');
    }
    // B1P.2: side guard. Null/corrupt position.side would otherwise fall through
    // to long-math in movePct below, risking sign flip on PnL accounting.
    if (position.side !== 'long' && position.side !== 'short') {
      return { accepted: false, reasons: ['invalid_position_side'] };
    }
    const closeNotional = order.closeNotionalUsd;
    const suppliedCosts = [fundingUsd, feeUsd, slippageUsd].map(Number);
    if (suppliedCosts.some((value) => !Number.isFinite(value) || value < 0)) {
      return { accepted: false, reasons: ['costs_must_be_finite_and_non_negative'] };
    }
    const originalNotional = Number(position.notionalUsd || closeNotional);
    const closeFraction = originalNotional > 0 ? closeNotional / originalNotional : 1;
    const heldHours = Math.max(0, (Date.parse(now()) - Date.parse(position.openedAt)) / 3600000) || 0;
    const modeledFundingUsd = closeNotional * Number(position.fundingRatePerEightHours || 0) * (heldHours / 8);
    // B2P.14: exit fee follows order-type tier. Exits via reduce-only at market
    // (default) pay taker; resting limit reduce-only pays maker. Use stored
    // takerFeeRate/makerFeeRate on the position so live + paper agree on rates
    // even if config changes mid-trade.
    const exitOrderType = String(reason || '').includes('LIMIT') ? 'limit' : 'market';
    const exitFeeRate = exitOrderType === 'limit'
      ? Number(position.makerFeeRate ?? 0.0002)
      : Number(position.takerFeeRate ?? 0.0004);
    const modeledFeeUsd = (closeNotional * exitFeeRate) + (Number(position.entryFeeUsd || 0) * closeFraction);
    // B2P.15: exit slippage uses the same depth-aware base rate stored on the
    // position when known; falls back to flat 2bps if missing for legacy rows.
    const exitSlippageBps = Number(position.entrySlippageBps ?? 2);
    const modeledSlippageUsd = (closeNotional * (exitSlippageBps / 10000)) + (Number(position.entrySlippageUsd || 0) * closeFraction);
    const chargedFundingUsd = Math.max(suppliedCosts[0], modeledFundingUsd);
    const chargedFeeUsd = Math.max(suppliedCosts[1], modeledFeeUsd);
    const chargedSlippageUsd = Math.max(suppliedCosts[2], modeledSlippageUsd);
    const movePct = position.side === 'long'
      ? (Number(price) - position.entryPrice) / position.entryPrice
      : (position.entryPrice - Number(price)) / position.entryPrice;
    const grossPnlUsd = closeNotional * movePct;
    const pnlUsd = grossPnlUsd - chargedFundingUsd - chargedFeeUsd - chargedSlippageUsd;
    const remainingNotionalUsd = position.remainingNotionalUsd - closeNotional;
    const closed = remainingNotionalUsd <= 0.000001;
    // B1P.6 (verified no-fix): adapter rejects true scale-in (line 21 above:
    // `position_already_open`). Reduce-only exit alone does NOT change entryPrice,
    // stopPrice, or leverage, so the liquidation-price formula (entry × (1 ±
    // (1/lev − maintenance))) yields the same value as at open. Recomputing
    // liquidationBufferMultiple here would produce an identical number. If true
    // scale-in is enabled later, this branch must recompute liquidationPrice +
    // liquidationBufferMultiple using a weighted-avg entry. Audit finding
    // 05-position-funding.md #2 was based on that future scenario.
    const trade = {
      id: `${position.id}-exit-${Date.now()}`,
      signalId,
      positionId: position.id,
      lifecycleId: position.lifecycleId,
      symbol: position.symbol,
      market: position.market,
      strategy: position.strategy,
      setup: position.setup || null,
      side: position.side,
      type: 'EXIT',
      reduceOnly: true,
      reason,
      closedAt: now(),
      notionalUsd: closeNotional,
      entryPrice: position.entryPrice,
      exitPrice: Number(price),
      grossPnlUsd,
      pnlUsd,
      riskUsd: position.riskUsd,
      fundingUsd: chargedFundingUsd,
      feeUsd: chargedFeeUsd,
      slippageUsd: chargedSlippageUsd,
      liquidationBufferMultiple: position.liquidationBufferMultiple,
      heldHours,
      closed,
    };
    const nextPosition = closed ? null : { ...position, remainingNotionalUsd };
    const acceptedSignalEvent = signalEvent ? { ...signalEvent, accepted: true, reasons: [] } : null;
    if (typeof telemetry?.commitExecution === 'function') {
      telemetry.commitExecution({
        trade,
        position: nextPosition,
        removePositionId: closed ? position.id : null,
        signalEvent: acceptedSignalEvent,
      });
    } else {
      telemetry?.recordTrade?.(trade);
      if (closed) telemetry?.removeOpenPosition?.(position.id);
      else telemetry?.upsertOpenPosition?.(nextPosition);
    }
    if (closed) {
      positions.delete(position.id);
    } else {
      positions.set(position.id, nextPosition);
    }
    return { accepted: true, order, trade, signalEventCommitted: Boolean(acceptedSignalEvent && telemetry?.commitExecution) };
  }

  return { openPosition, reduceOnlyExit, positions };
}

module.exports = { createPaperExecutionAdapter };
