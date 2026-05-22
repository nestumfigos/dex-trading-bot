'use strict';

function num(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function hold(reason, extra = {}) {
  return { signal: 'HOLD', qualifies: false, setupType: 'bsc_flow_breakout', reasons: [reason], ...extra };
}

function detectBscFlowBreakout(tokenData = {}, cfg = {}) {
  const priceExpansionPct = Math.max(
    num(tokenData.priceChange60mPct ?? tokenData.priceChange1hPct),
    num(tokenData.priceChange1h),
    num(tokenData.priceChange24h),
  );
  const netBuyFlowUsd10m = num(tokenData.netBuyFlowUsd10m);
  const volumeSpike = num(tokenData.volumeSpike ?? tokenData.volumeSpikeRatio);
  const liquidityUsd = num(tokenData.liquidityUsd);
  const buyTaxPct = num(tokenData.buyTaxPct ?? tokenData.buyTax);
  const sellTaxPct = num(tokenData.sellTaxPct ?? tokenData.sellTax);
  const honeypot = tokenData.honeypot === true || tokenData.isHoneypot === true;
  const liquidityLockedUsd = num(tokenData.liquidityLockedUsd ?? tokenData.lockedLiquidityUsd ?? liquidityUsd);

  const minExpansionPct = num(cfg.minPriceExpansion60mPct, 5);
  const minNetBuyFlowUsd = num(cfg.minNetBuyFlowUsd, 5000);
  const minVolumeSpike = num(cfg.volumeSpikeMultiplier, 1.8);
  const minLiquidityUsd = num(cfg.minLiquidityUsd, 50_000);
  const minLockedLiquidityUsd = num(cfg.minLockedLiquidityUsd, 50_000);
  const maxTaxPct = num(cfg.maxTaxPct, 5);
  const riskPct = Math.max(0.15, Math.min(0.25, num(cfg.riskPct, 0.2)));
  const maxSlippagePct = Math.min(3, Math.max(0.1, num(cfg.maxSlippagePct, 3)));

  if (honeypot) return hold('honeypot_detected');
  if (buyTaxPct >= maxTaxPct || sellTaxPct >= maxTaxPct) return hold('tax_above_max', { buyTaxPct, sellTaxPct });
  if (liquidityUsd < minLiquidityUsd) return hold('liquidity_below_min', { liquidityUsd });
  if (liquidityLockedUsd < minLockedLiquidityUsd) return hold('locked_liquidity_below_min', { liquidityLockedUsd });
  if (priceExpansionPct < minExpansionPct) return hold('price_expansion_below_min', { priceExpansionPct });
  if (netBuyFlowUsd10m < minNetBuyFlowUsd) return hold('net_buy_flow_below_min', { netBuyFlowUsd10m });
  if (volumeSpike < minVolumeSpike) return hold('volume_spike_below_min', { volumeSpike });

  const entryPrice = num(tokenData.price);
  const stopPrice = entryPrice > 0 ? entryPrice * (1 - num(cfg.structuralStopPct, 8) / 100) : null;
  const targetPrice = entryPrice > 0 ? entryPrice * (1 + Math.max(priceExpansionPct, 5) * 2 / 100) : null;
  return {
    signal: 'BUY',
    qualifies: true,
    setupType: 'bsc_flow_breakout',
    structureType: 'bsc_flow_breakout',
    entryPrice,
    stopPrice,
    targetPrice,
    staleExitMinutes: num(cfg.staleExitMinutes, 30),
    riskPct,
    maxSlippagePct,
    useMevJitter: cfg.useMevJitter !== false,
    reasons: ['price_expansion_60m', 'net_buy_flow_confirmed', 'volume_spike_confirmed', 'safety_gates_passed'],
    metrics: { priceExpansionPct, netBuyFlowUsd10m, volumeSpike, liquidityUsd, liquidityLockedUsd, buyTaxPct, sellTaxPct },
  };
}

module.exports = { detectBscFlowBreakout };
