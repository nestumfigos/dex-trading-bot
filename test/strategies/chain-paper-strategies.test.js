'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { detectBscFlowBreakout } = require('../../src/strategies/bsc-flow-breakout-detector');
const { createBscFlowEvaluator } = require('../../src/strategies/bsc-flow-evaluator');
const { checkBscFlowSafety, extractDexSafety, extractHoneypotSafety, pickBscPair } = require('../../src/strategies/bsc-flow-safety');
const { detectBaseDexMomentumReclaim } = require('../../src/strategies/base-dex-momentum-reclaim-detector');
const { createBaseDexMomentumReclaimEvaluator } = require('../../src/strategies/base-dex-momentum-reclaim-evaluator');
const { createSolanaBullFlagEvaluator } = require('../../src/strategies/bull-flag-evaluator-solana');

function c(close, volume, overrides = {}) {
  const open = overrides.open ?? close;
  return {
    open,
    high: overrides.high ?? Math.max(close, open) * 1.002,
    low: overrides.low ?? Math.min(close, open) * 0.998,
    close,
    volume,
  };
}

function validBullFlagCandles() {
  return [
    ...Array.from({ length: 20 }, (_, index) => c(100 + (index % 3) * 0.05, 900 + (index % 4) * 30)),
    c(106.2, 2400, { open: 100.6, high: 107.0, low: 100.6 }),
    c(105.7, 800, { open: 106.2, high: 106.2, low: 105.3 }),
    c(105.9, 760, { open: 105.7, high: 106.1, low: 105.4 }),
    c(107.3, 3000, { open: 105.9, high: 107.5, low: 105.9 }),
  ];
}

function scaledBullFlagCandles(multiplier = 1) {
  return validBullFlagCandles().map((row) => ({
    ...row,
    open: row.open * multiplier,
    high: row.high * multiplier,
    low: row.low * multiplier,
    close: row.close * multiplier,
  }));
}

function bscToken(overrides = {}) {
  return {
    address: '0x0000000000000000000000000000000000000001',
    price: 1,
    priceChange60mPct: 7,
    netBuyFlowUsd10m: 8000,
    volumeSpike: 2.2,
    liquidityUsd: 80_000,
    liquidityLockedUsd: 70_000,
    buyTaxPct: 3,
    sellTaxPct: 4,
    honeypot: false,
    ...overrides,
  };
}

function bscPair(overrides = {}) {
  return {
    chainId: 'bsc',
    priceUsd: '1',
    liquidity: { usd: 90_000 },
    priceChange: { h1: 7 },
    volume: { m5: 20_000, h24: 250_000 },
    txns: { m5: { buys: 18, sells: 6 } },
    ...overrides,
  };
}

function bscCfg(overrides = {}) {
  return {
    enabled: true,
    minLiquidityUsd: 50_000,
    minLockedLiquidityUsd: 50_000,
    maxTaxPct: 5,
    riskPct: 0.2,
    maxSlippagePct: 3,
    ...overrides,
  };
}

function solanaCfg(overrides = {}) {
  return {
    enabled: true,
    min24hVolumeUsd: 300_000,
    minLiquidityUsd: 500_000,
    minBuyRatioRecentPct: 60,
    maxSlippagePct: 1.5,
    maxTop10HoldersPct: 30,
    minNetEdgePct: 2.5,
    polePctMin: 5,
    poleMaxCandles: 4,
    flagMinCandles: 2,
    flagMaxCandles: 8,
    flagDepthMaxPct: 50,
    flagVolContractMaxRatio: 0.70,
    breakoutVolMinRatio: 1.5,
    ...overrides,
  };
}

function solanaToken(overrides = {}) {
  return {
    symbol: 'SOLX',
    address: 'So111',
    chainKey: 'solana',
    liquidityUsd: 700_000,
    volume24hUsd: 1_000_000,
    expectedSlippagePct: 1,
    netBuyFlowUsd10m: 6000,
    topHoldersPct: 20,
    buyRatioRecentPct: 65,
    dataSources: ['birdeye', 'dexscreener'],
    ...overrides,
  };
}

test('BSC flow detector buys only fast expansion plus buy flow and safety gates', () => {
  const result = detectBscFlowBreakout(bscToken());
  assert.equal(result.signal, 'BUY');
  assert.equal(result.setupType, 'bsc_flow_breakout');
  assert.equal(result.maxSlippagePct, 3);
  assert.equal(result.useMevJitter, true);
});

test('BSC flow detector blocks honeypot, tax, liquidity, flow, and volume failures', () => {
  assert.equal(detectBscFlowBreakout({ honeypot: true }).signal, 'HOLD');
  assert.equal(detectBscFlowBreakout({ buyTaxPct: 6, liquidityUsd: 100_000, liquidityLockedUsd: 100_000 }).signal, 'HOLD');
  assert.equal(detectBscFlowBreakout({ liquidityUsd: 10_000 }).signal, 'HOLD');
  assert.equal(detectBscFlowBreakout({ liquidityUsd: 100_000, liquidityLockedUsd: 100_000, priceChange60mPct: 8, netBuyFlowUsd10m: 1, volumeSpike: 2 }).signal, 'HOLD');
  assert.equal(detectBscFlowBreakout({ liquidityUsd: 100_000, liquidityLockedUsd: 100_000, priceChange60mPct: 8, netBuyFlowUsd10m: 8000, volumeSpike: 1 }).signal, 'HOLD');
});

for (let index = 0; index < 10; index += 1) {
  test(`BSC detector fixture ${index + 1}: risk and slippage stay inside plan gates`, () => {
    const result = detectBscFlowBreakout(bscToken({
      price: 1 + index * 0.05,
      priceChange60mPct: 6 + index * 0.2,
      netBuyFlowUsd10m: 7000 + index * 500,
      volumeSpike: 2 + index * 0.05,
    }), bscCfg({ riskPct: index % 2 === 0 ? 0.1 : 0.35, maxSlippagePct: 5 }));
    assert.equal(result.signal, 'BUY');
    assert.ok(result.riskPct >= 0.15 && result.riskPct <= 0.25);
    assert.equal(result.maxSlippagePct, 3);
    assert.equal(result.useMevJitter, true);
  });
}

test('BSC safety normalizers extract honeypot and DexScreener data', () => {
  assert.equal(extractHoneypotSafety({ simulationResult: { buyTax: 0.03, sellTax: 4 } }).buyTaxPct, 3);
  assert.equal(extractHoneypotSafety({ isHoneypot: true }).isHoneypot, true);
  assert.equal(pickBscPair({ pairs: [{ chainId: 'eth' }, bscPair()] })?.chainId, 'bsc');
  assert.equal(extractDexSafety(bscPair()).liquidityUsd, 90_000);
});

const safetyCases = [
  ['passes remote honeypot and DexScreener safety', {}, true, []],
  ['blocks missing address', { address: '' }, false, ['missing_bsc_token_address']],
  ['blocks honeypot API result', {}, false, ['honeypot_detected'], { isHoneypot: true }],
  ['blocks tokenData honeypot override', { honeypot: true }, false, ['honeypot_detected']],
  ['blocks buy tax over max', { buyTaxPct: 6 }, false, ['tax_above_max']],
  ['blocks sell tax over max', { sellTaxPct: 6 }, false, ['tax_above_max']],
  ['blocks DexScreener low liquidity', { liquidityUsd: undefined, liquidityLockedUsd: undefined }, false, ['liquidity_below_min'], {}, bscPair({ liquidity: { usd: 10_000 } })],
  ['blocks low locked liquidity override', { liquidityLockedUsd: 20_000 }, false, ['locked_liquidity_below_min']],
  ['uses DexScreener liquidity as lock proxy when lock data is missing', { liquidityUsd: undefined, liquidityLockedUsd: undefined }, true, []],
  ['uses tokenData tax data when honeypot source is unavailable', { buyTaxPct: 3, sellTaxPct: 4 }, true, [], null],
  ['uses tokenData liquidity when remote fetch fails', { liquidityUsd: 80_000, liquidityLockedUsd: 80_000 }, true, [], {}, null],
  ['keeps DexScreener flow fields for detector', { netBuyFlowUsd10m: 0 }, true, [], {}, bscPair({ txns: { m5: { buys: 20, sells: 5 } }, volume: { m5: 25_000 } })],
];

for (const [name, tokenOverrides, expectedOk, expectedReasons, hpOverride = {}, pairOverride = bscPair()] of safetyCases) {
  test(`BSC safety fixture: ${name}`, async () => {
    const result = await checkBscFlowSafety(bscToken(tokenOverrides), {
      config: bscCfg(),
      checkHoneypot: async () => (hpOverride == null ? null : { simulationResult: { buyTax: 3, sellTax: 4 }, ...hpOverride }),
      fetchDexScreener: async () => (pairOverride ? { pairs: [pairOverride] } : null),
    });
    assert.equal(result.ok, expectedOk);
    for (const reason of expectedReasons) assert.ok(result.reasons.includes(reason));
  });
}

test('BSC evaluator reuses safety clients before detector execution', async () => {
  const evaluator = createBscFlowEvaluator({
    checkHoneypot: async () => ({ simulationResult: { buyTax: 3, sellTax: 4 } }),
    fetchDexScreener: async () => ({ pairs: [bscPair()] }),
  });
  const result = await evaluator.evaluate(bscToken({ liquidityUsd: undefined, liquidityLockedUsd: 70_000 }), { config: bscCfg() });
  assert.equal(result.signal, 'BUY');
  assert.deepEqual(result.details.scannerReasons, []);
  assert.ok(result.details.metrics.safety.sources.includes('dexscreener-client'));
});

test('Base detector accepts support sweep reclaim with Base liquidity and volume floors', () => {
  const result = detectBaseDexMomentumReclaim({
    tokenData: {
      price: 1.05,
      liquidityUsd: 1_500_000,
      volumeSpike: 3,
      supportPrice: 1,
      recentLow: 0.98,
    },
  });
  assert.equal(result.signal, 'BUY');
  assert.equal(result.structureType, 'base_support_reclaim');
});

test('Base detector accepts tighter bull flag variant and rejects weak floors', () => {
  const buy = detectBaseDexMomentumReclaim({
    tokenData: { liquidityUsd: 1_500_000, volumeSpike: 3 },
    candles: validBullFlagCandles(),
  });
  assert.equal(buy.signal, 'BUY');
  assert.equal(buy.structureType, 'base_bull_flag');

  assert.equal(detectBaseDexMomentumReclaim({ tokenData: { liquidityUsd: 500_000, volumeSpike: 3 } }).signal, 'HOLD');
  assert.equal(detectBaseDexMomentumReclaim({ tokenData: { liquidityUsd: 1_500_000, volumeSpike: 1 } }).signal, 'HOLD');
});

for (let index = 0; index < 15; index += 1) {
  test(`Base support reclaim fixture ${index + 1}: sweep plus reclaim qualifies`, () => {
    const supportPrice = 1 + index * 0.01;
    const result = detectBaseDexMomentumReclaim({
      tokenData: {
        price: supportPrice * 1.02,
        liquidityUsd: 1_500_000 + index * 25_000,
        volumeSpike: 2.6 + index * 0.02,
        supportPrice,
        recentLow: supportPrice * 0.99,
      },
    });
    assert.equal(result.signal, 'BUY');
    assert.equal(result.structureType, 'base_support_reclaim');
  });
}

for (let index = 0; index < 15; index += 1) {
  test(`Base bull-flag fixture ${index + 1}: tighter Base floors qualify`, () => {
    const result = detectBaseDexMomentumReclaim({
      tokenData: {
        liquidityUsd: 1_500_000 + index * 30_000,
        volumeSpike: 2.8 + index * 0.02,
      },
      candles: scaledBullFlagCandles(1 + index * 0.01),
    });
    assert.equal(result.signal, 'BUY');
    assert.equal(result.structureType, 'base_bull_flag');
  });
}

test('Base evaluator verifies OHLCV-fed bull-flag path', async () => {
  const evaluator = createBaseDexMomentumReclaimEvaluator({
    fetchOhlcv: async () => ({ candles: validBullFlagCandles() }),
  });
  const result = await evaluator.evaluate({ address: '0xbase', liquidityUsd: 1_500_000, volumeSpike: 3 }, { config: { enabled: true } });
  assert.equal(result.signal, 'BUY');
  assert.equal(result.details.structureType, 'base_bull_flag');
});

test('Solana bull-flag evaluator requires liquidity, slippage, holder, flow, and fresh multisource gates', async () => {
  const evaluator = createSolanaBullFlagEvaluator({
    fetchOhlcv: async () => ({ candles: validBullFlagCandles() }),
  });
  const cfg = solanaCfg();
  const token = solanaToken();
  const result = await evaluator.evaluate(token, { config: cfg, chainKey: 'solana' });
  assert.equal(result.signal, 'BUY');
  assert.equal(result.details.setupType, 'solana_bull_flag_v2');

  assert.equal((await evaluator.evaluate({ ...token, liquidityUsd: 1000 }, { config: cfg })).signal, 'HOLD');
  assert.equal((await evaluator.evaluate({ ...token, expectedSlippagePct: 2 }, { config: cfg })).signal, 'HOLD');
  assert.equal((await evaluator.evaluate({ ...token, topHoldersPct: 40 }, { config: cfg })).signal, 'HOLD');
  assert.equal((await evaluator.evaluate({ ...token, buyRatioRecentPct: 50 }, { config: cfg })).signal, 'HOLD');
  assert.equal((await evaluator.evaluate({ ...token, dataSources: ['birdeye'] }, { config: cfg })).signal, 'HOLD');
});

for (let index = 0; index < 15; index += 1) {
  test(`Solana v2 bull-flag BUY fixture ${index + 1}: multisource flow remains valid`, async () => {
    const evaluator = createSolanaBullFlagEvaluator({
      fetchOhlcv: async () => ({ candles: scaledBullFlagCandles(1 + index * 0.005) }),
    });
    const result = await evaluator.evaluate(solanaToken({
      liquidityUsd: 700_000 + index * 25_000,
      buyRatioRecentPct: 62 + (index % 5),
      expectedSlippagePct: 0.8 + (index % 3) * 0.1,
    }), { config: solanaCfg(), chainKey: 'solana' });
    assert.equal(result.signal, 'BUY');
    assert.equal(result.details.setupType, 'solana_bull_flag_v2');
  });
}

const solanaHoldCases = [
  ['low liquidity', { liquidityUsd: 100_000 }, 'liquidity_below_solana_floor'],
  ['wide slippage', { expectedSlippagePct: 2 }, 'slippage_above_solana_cap'],
  ['holder concentration', { topHoldersPct: 40 }, 'top10_holder_concentration_above_max'],
  ['weak buy flow', { buyRatioRecentPct: 50 }, 'buy_flow_ratio_below_min'],
  ['weak net buy flow', { netBuyFlowUsd10m: 1000 }, 'net_buy_flow_below_solana_min'],
  ['wide price impact', { expectedPriceImpactPct: 3 }, 'price_impact_above_solana_cap'],
  ['single source', { dataSources: ['birdeye'] }, 'fresh_multisource_data_required'],
  ['low 24h volume', { volume24hUsd: 10_000 }, 'volume_below_min'],
  ['stale birdeye', { dataSources: ['birdeye', 'dexscreener'], birdeyeAgeMs: 15 * 60_000 }, 'fresh_multisource_data_required'],
  ['stale dexscreener', { dataSources: ['birdeye', 'dexscreener'], dexscreenerAgeMs: 15 * 60_000 }, 'fresh_multisource_data_required'],
  ['disabled strategy', {}, 'strategy_disabled', { enabled: false }],
  ['bad candles', {}, 'ohlcv_unavailable', {}, []],
];

for (const [name, tokenOverrides, reason, cfgOverrides = {}, candles = validBullFlagCandles()] of solanaHoldCases) {
  test(`Solana v2 HOLD fixture: ${name}`, async () => {
    const evaluator = createSolanaBullFlagEvaluator({
      fetchOhlcv: async () => ({ candles }),
    });
    const result = await evaluator.evaluate(solanaToken(tokenOverrides), { config: solanaCfg(cfgOverrides), chainKey: 'solana' });
    assert.equal(result.signal, 'HOLD');
    assert.ok(result.details.scannerReasons.some((item) => String(item).includes(reason)));
  });
}
