'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createFableEvaluator, partitionSessions } = require('../../src/strategies/fable-evaluator');

const silentLogger = { info() {}, warn() {}, debug() {}, error() {} };

// "now" = 01:00 UTC — inside the refill window.
const NOW = Date.UTC(2026, 6, 7, 1, 0, 0);
const BAR_MS = 15 * 60_000;

// Build a synthetic 15m series ending at `NOW`, spanning back `bars` bars.
// shape(tsMs, i) -> { open, high, low, close, volume }
function buildCandles(bars, shape) {
  const out = [];
  for (let i = 0; i < bars; i += 1) {
    const ts = NOW - (bars - i) * BAR_MS;
    const c = shape(ts, i);
    out.push({ timestamp: Math.floor(ts / 1000), ...c });
  }
  return out;
}

// Baseline qualifying scenario:
//   thick session (12:00-20:00 prev day): flat around 100, decent volume,
//     low 99 (support)
//   thin session (20:00-24:00): drifts 100 -> 95.5 (-4.5%) on LOW volume,
//     low 95 (holds above thick support * tolerance? 95 < 99! -> support
//     must be the THICK session's low; thin low may be lower than thick low
//     breaks the gate...)
// NOTE: gate requires thinLow >= thickLow*(1-0.5%). So the markdown must
// stay above thick support: thick session low must be BELOW the thin low.
// Make thick range 94..101 (low 94 early spike-down), thin drop 100 -> 95.5
// with low 95.2 (> 94). Refill candle: green, volume above thin median.
function qualifyingCandles() {
  return buildCandles(120, (ts) => {
    const hour = new Date(ts).getUTCHours() + new Date(ts).getUTCMinutes() / 60;
    const isPrevDay = ts < Date.UTC(2026, 6, 7, 0, 0, 0);
    if (isPrevDay && hour >= 12 && hour < 20) {
      // thick: oscillate 99-101 with one early dip to 94 (session low),
      // volume 1000/bar
      const dip = hour < 12.5;
      return { open: 100, high: 101, low: dip ? 94 : 99, close: 100, volume: 1000 };
    }
    if (isPrevDay && hour >= 20) {
      // thin: grind down 100 -> 95.5 on volume 300/bar (0.3x thick)
      const progress = (hour - 20) / 4; // 0..1
      const px = 100 - 4.5 * progress;
      return { open: px + 0.1, high: px + 0.3, low: Math.max(95.2, px - 0.3), close: px, volume: 300 };
    }
    if (!isPrevDay) {
      // refill: first candles green on rising volume
      return { open: 95.6, high: 96.4, low: 95.5, close: 96.2, volume: 450 };
    }
    // earlier history (before 12:00 prev day): flat
    return { open: 100, high: 100.5, low: 99.5, close: 100, volume: 900 };
  });
}

function makeEvaluator(candles, nowMs = NOW) {
  return createFableEvaluator({
    logger: silentLogger,
    fetchOhlcv: async () => ({ candles }),
    now: () => nowMs,
  });
}

const TOKEN = { symbol: 'ABC', address: 'ABC', price: 96.2, volume24hUsd: 5_000_000, liquidityUsd: 1_000_000 };

test('partitionSessions splits thick/thin/refill on UTC boundaries', () => {
  const { thick, thin, refill } = partitionSessions(qualifyingCandles(), NOW);
  assert.equal(thick.length, 32); // 8h of 15m
  assert.equal(thin.length, 16);  // 4h of 15m
  assert.ok(refill.length >= 3);  // 00:00 -> 01:00
});

test('qualifying thin-markdown refill -> BUY with sane geometry', async () => {
  const ev = makeEvaluator(qualifyingCandles());
  const r = await ev.evaluate(TOKEN, { config: {}, chainKey: 'kucoin' });
  assert.equal(r.signal, 'BUY', JSON.stringify(r.details));
  assert.equal(r.details.setupType, 'fable');
  assert.ok(r.details.markdownPct < -2 && r.details.markdownPct > -9);
  assert.ok(r.details.thinVolRatio < 0.8, `thinVolRatio=${r.details.thinVolRatio}`);
  assert.ok(r.details.stopPrice < 96.2, 'stop below entry');
  assert.ok(r.details.targetPrice > 96.2, 'target above entry');
  assert.ok(r.details.rr >= 1.0, `rr=${r.details.rr}`);
  assert.match(r.details.timeExitAt, /T08:00:00/);
});

test('outside refill window (12:00 UTC) -> HOLD', async () => {
  const ev = makeEvaluator(qualifyingCandles(), Date.UTC(2026, 6, 7, 12, 0, 0));
  const r = await ev.evaluate(TOKEN, { config: {}, chainKey: 'kucoin' });
  assert.equal(r.signal, 'HOLD');
  assert.deepEqual(r.details.scannerReasons, ['fable_outside_refill_window']);
});

test('no markdown (flat thin session) -> HOLD', async () => {
  const candles = buildCandles(120, (ts) => {
    const hour = new Date(ts).getUTCHours();
    const isPrevDay = ts < Date.UTC(2026, 6, 7, 0, 0, 0);
    if (isPrevDay && hour >= 12 && hour < 20) return { open: 100, high: 101, low: 94, close: 100, volume: 1000 };
    if (isPrevDay && hour >= 20) return { open: 100, high: 100.5, low: 99.5, close: 100, volume: 300 };
    if (!isPrevDay) return { open: 100, high: 100.8, low: 99.9, close: 100.6, volume: 450 };
    return { open: 100, high: 100.5, low: 99.5, close: 100, volume: 900 };
  });
  const r = await makeEvaluator(candles).evaluate({ ...TOKEN, price: 100.6 }, { config: {}, chainKey: 'kucoin' });
  assert.equal(r.signal, 'HOLD');
  assert.ok(r.details.scannerReasons.includes('fable_no_markdown'));
});

test('markdown on REAL volume (distribution) -> HOLD', async () => {
  const candles = buildCandles(120, (ts) => {
    const hour = new Date(ts).getUTCHours() + new Date(ts).getUTCMinutes() / 60;
    const isPrevDay = ts < Date.UTC(2026, 6, 7, 0, 0, 0);
    if (isPrevDay && hour >= 12 && hour < 20) return { open: 100, high: 101, low: 94, close: 100, volume: 1000 };
    if (isPrevDay && hour >= 20) {
      const px = 100 - 4.5 * ((hour - 20) / 4);
      return { open: px + 0.1, high: px + 0.3, low: Math.max(95.2, px - 0.3), close: px, volume: 1500 }; // HEAVY tape
    }
    if (!isPrevDay) return { open: 95.6, high: 96.4, low: 95.5, close: 96.2, volume: 2000 };
    return { open: 100, high: 100.5, low: 99.5, close: 100, volume: 900 };
  });
  const r = await makeEvaluator(candles).evaluate(TOKEN, { config: {}, chainKey: 'kucoin' });
  assert.equal(r.signal, 'HOLD');
  assert.ok(r.details.scannerReasons.includes('fable_markdown_on_real_volume'));
});

test('thick support broken during markdown -> HOLD', async () => {
  const candles = buildCandles(120, (ts) => {
    const hour = new Date(ts).getUTCHours() + new Date(ts).getUTCMinutes() / 60;
    const isPrevDay = ts < Date.UTC(2026, 6, 7, 0, 0, 0);
    if (isPrevDay && hour >= 12 && hour < 20) return { open: 100, high: 101, low: 99, close: 100, volume: 1000 };
    if (isPrevDay && hour >= 20) {
      const px = 100 - 4.5 * ((hour - 20) / 4);
      // thin low 95.2 << thick low 99 -> support broken
      return { open: px + 0.1, high: px + 0.3, low: Math.max(95.2, px - 0.3), close: px, volume: 300 };
    }
    if (!isPrevDay) return { open: 95.6, high: 96.4, low: 95.5, close: 96.2, volume: 450 };
    return { open: 100, high: 100.5, low: 99.5, close: 100, volume: 900 };
  });
  const r = await makeEvaluator(candles).evaluate(TOKEN, { config: {}, chainKey: 'kucoin' });
  assert.equal(r.signal, 'HOLD');
  assert.ok(r.details.scannerReasons.includes('fable_thick_support_broken'), JSON.stringify(r.details.scannerReasons));
});

test('red refill candle (no bid confirmation) -> HOLD', async () => {
  const candles = qualifyingCandles().map((c, i, arr) => (
    i === arr.length - 1 ? { ...c, open: 96.2, close: 95.6 } : c
  ));
  const r = await makeEvaluator(candles).evaluate(TOKEN, { config: {}, chainKey: 'kucoin' });
  assert.equal(r.signal, 'HOLD');
  assert.ok(r.details.scannerReasons.includes('fable_no_bid_confirmation'));
});

test('knife candle (range too wide) -> HOLD', async () => {
  const candles = qualifyingCandles().map((c, i, arr) => (
    i === arr.length - 1 ? { ...c, high: 99.5, low: 94.5 } : c // ~5% range
  ));
  const r = await makeEvaluator(candles).evaluate(TOKEN, { config: {}, chainKey: 'kucoin' });
  assert.equal(r.signal, 'HOLD');
  assert.ok(r.details.scannerReasons.includes('fable_knife_candle'));
});

test('insufficient candles -> HOLD', async () => {
  const r = await makeEvaluator(qualifyingCandles().slice(-30)).evaluate(TOKEN, { config: {}, chainKey: 'kucoin' });
  assert.equal(r.signal, 'HOLD');
  assert.ok(r.details.scannerReasons.includes('fable_insufficient_candles'));
});
