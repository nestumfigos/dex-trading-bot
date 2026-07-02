'use strict';

// Paper fill realism (2026-07-02 perf audit).
//
// WHY: paper fills previously returned `{ txid: paper_tx_*, simulated: true }`
// with NO price/qty data, so downstream accounting fell back to the *expected*
// price — zero slippage, zero spread cost, zero fees. Result: paper momentum
// showed 59% win rate / PF 1.05 while the SAME strategy on live showed 38% /
// PF 0.53. The canary was structurally optimistic, which poisons every
// promotion decision made from paper metrics.
//
// WHAT: simulate a realistic taker fill:
//   BUY  fills at referencePrice * (1 + slippage), receives base qty net of fee
//   SELL fills at referencePrice * (1 - slippage), receives quote net of fee
// Reference price should be the top-of-book ask (buy) / bid (sell) when the
// caller can supply it — that bakes in spread cost. Slippage is jittered
// 0.5x–1.5x around the configured base to model variance instead of a
// constant offset the strategy could implicitly overfit to.
//
// Defaults (override via env):
//   KuCoin spot: fee 10 bps (0.1% taker), extra slippage 5 bps beyond spread
//   DEX venues:  fee 30 bps (pool fee),   slippage 75 bps (impact + latency)
//
// PAPER_SIM_FILLS_ENABLED=false restores the legacy ideal-fill behavior.

function envBps(name, dflt) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 0 ? v : dflt;
}

const SIM_ENABLED = process.env.PAPER_SIM_FILLS_ENABLED !== 'false';

const VENUE_DEFAULTS = {
  kucoin: {
    feeBps: () => envBps('PAPER_SIM_KUCOIN_FEE_BPS', 10),
    slippageBps: () => envBps('PAPER_SIM_KUCOIN_EXTRA_SLIPPAGE_BPS', 5),
  },
  dex: {
    feeBps: () => envBps('PAPER_SIM_DEX_FEE_BPS', 30),
    slippageBps: () => envBps('PAPER_SIM_DEX_SLIPPAGE_BPS', 75),
  },
};

/**
 * Simulate a realistic paper fill.
 *
 * @param {Object} opts
 * @param {'buy'|'sell'} opts.side
 * @param {number} opts.referencePriceUsd  top-of-book ask (buy) / bid (sell),
 *                                         or best available price estimate
 * @param {number} [opts.requestedQuoteUsd]  BUY: quote amount being spent
 * @param {number} [opts.requestedBaseQty]   SELL: base qty being sold
 * @param {'kucoin'|'dex'} [opts.venueClass]
 * @returns fill result shaped like a live exchange fill (executedPriceUsd,
 *          filledBaseQty, filledQuoteUsd, hasExchangeFilledData) or a bare
 *          legacy result when disabled / no reference price available.
 */
function simulatePaperFill({
  side,
  referencePriceUsd,
  requestedQuoteUsd = null,
  requestedBaseQty = null,
  venueClass = 'kucoin',
} = {}) {
  const txid = `paper_tx_${Date.now()}`;
  const ref = Number(referencePriceUsd);
  if (!SIM_ENABLED || !Number.isFinite(ref) || ref <= 0) {
    // Legacy shape — downstream falls back to expected price (ideal fill).
    return { txid, simulated: true, simulatedFill: false };
  }

  const venue = VENUE_DEFAULTS[venueClass] || VENUE_DEFAULTS.kucoin;
  const feeBps = venue.feeBps();
  // Jitter 0.5x–1.5x so paper doesn't see a constant, overfittable offset.
  const slipBps = venue.slippageBps() * (0.5 + Math.random());

  const dir = side === 'sell' ? -1 : 1;
  const executedPriceUsd = ref * (1 + (dir * slipBps) / 10000);

  let filledBaseQty;
  let filledQuoteUsd;
  if (side === 'sell') {
    const qty = Number(requestedBaseQty || 0);
    filledBaseQty = qty;
    // Taker fee comes out of the quote proceeds.
    filledQuoteUsd = qty * executedPriceUsd * (1 - feeBps / 10000);
  } else {
    const quote = Number(requestedQuoteUsd || 0);
    filledQuoteUsd = quote; // full quote is debited
    // Taker fee comes out of the base received.
    filledBaseQty = (quote / executedPriceUsd) * (1 - feeBps / 10000);
  }

  if (!Number.isFinite(filledBaseQty) || filledBaseQty <= 0) {
    return { txid, simulated: true, simulatedFill: false };
  }

  return {
    txid,
    simulated: true,
    simulatedFill: true,
    executedPriceUsd,
    filledBaseQty,
    filledQuoteUsd,
    hasExchangeFilledData: true,
    appliedSlippageBps: Math.round(slipBps * 100) / 100,
    appliedFeeBps: feeBps,
  };
}

module.exports = { simulatePaperFill };
