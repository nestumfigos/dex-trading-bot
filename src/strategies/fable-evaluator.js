'use strict';

// FABLE — thin-session markdown, thick-session refill (original, 2026-07-07).
//
// Born from this system's own ledger data, not a textbook pattern. 218 closed
// momentum trades showed session microstructure dominates: UTC 20-24h is
// structurally toxic (36% win, thin books, mechanical dumping) while
// 00-08h UTC runs 63-67% win as Asia liquidity returns. Fable trades the
// TRANSITION between those regimes instead of trading inside either one:
//
//   THESIS: a token marked down 2-9% during the thin window (20-24 UTC) on
//   BELOW-thick-session volume was pushed by mechanical selling into an
//   empty book — not by real distribution. If the prior thick session's
//   (12-20 UTC) support held through the markdown, returning liquidity at
//   the Asia open tends to refill the move. Buy the first confirmed bid in
//   the refill window (00:00-02:30 UTC), target a retrace of the markdown,
//   stop under the thin-session low, and be flat by 08:00 UTC — before the
//   marginal 08-12h bucket — no matter what.
//
// The toxic window is used as SIGNAL, never traded. Every parameter is
// env-tunable (FABLE_*); defaults are deliberately strict.
//
// Exits are structural (see evaluate-exit-decision.js 'fable' block):
//   FABLE_STRUCTURE_STOP   price <= stop (thin-session low, capped)
//   FABLE_REFILL_COMPLETE  price >= target (61.8% markdown retrace)
//   FABLE_TIME_EXIT        clock >= 08:00 UTC — thesis expired, flat.

const MS_PER_HOUR = 3600_000;

function utcHourFloat(tsMs) {
  const d = new Date(tsMs);
  return d.getUTCHours() + d.getUTCMinutes() / 60;
}

function candleTsMs(candle) {
  const ts = Number(candle?.timestamp || 0);
  return ts > 1e12 ? ts : ts * 1000; // seconds -> ms
}

function sum(arr) { return arr.reduce((s, v) => s + Number(v || 0), 0); }

function median(arr) {
  const xs = arr.map(Number).filter((v) => Number.isFinite(v) && v >= 0).sort((a, b) => a - b);
  if (!xs.length) return 0;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

/**
 * Partition candles into the three Fable sessions relative to "now":
 *   thick  = 12:00-20:00 UTC of the PREVIOUS day-cycle
 *   thin   = 20:00-24:00 UTC of the previous day-cycle
 *   refill = 00:00 UTC (today) -> now
 * Called only inside the refill window, so "previous 20:00" is 4-6.5h back.
 */
function partitionSessions(candles, nowMs) {
  const midnight = new Date(nowMs);
  midnight.setUTCHours(0, 0, 0, 0);
  const midnightMs = midnight.getTime();
  const thinStartMs = midnightMs - 4 * MS_PER_HOUR;   // 20:00 prev day
  const thickStartMs = midnightMs - 12 * MS_PER_HOUR; // 12:00 prev day

  const thick = [];
  const thin = [];
  const refill = [];
  for (const candle of candles) {
    const ts = candleTsMs(candle);
    if (ts >= thickStartMs && ts < thinStartMs) thick.push(candle);
    else if (ts >= thinStartMs && ts < midnightMs) thin.push(candle);
    else if (ts >= midnightMs && ts <= nowMs) refill.push(candle);
  }
  return { thick, thin, refill };
}

function createFableEvaluator({ logger = console, fetchOhlcv, now = () => Date.now() } = {}) {
  if (typeof fetchOhlcv !== 'function') throw new Error('createFableEvaluator: fetchOhlcv required');

  function holdResult(reasons, details = {}) {
    return { signal: 'HOLD', details: { setupType: 'fable', scannerReasons: reasons, ...details } };
  }

  async function evaluate(tokenData = {}, { config: cfg = {}, chainKey = 'kucoin' } = {}) {
    const nowMs = now();
    const hour = utcHourFloat(nowMs);

    // 1) Refill window gate — Fable only ever buys 00:00-02:30 UTC.
    const windowStart = Number(cfg.entryWindowStartUtc ?? 0);
    const windowEnd = Number(cfg.entryWindowEndUtc ?? 2.5);
    if (hour < windowStart || hour >= windowEnd) {
      return holdResult(['fable_outside_refill_window']);
    }

    const ohlcv = await fetchOhlcv({
      chainKey,
      symbol: tokenData.symbol,
      address: tokenData.address,
      pairAddress: tokenData.pairAddress,
      interval: '15m',
      limit: 120, // 30h of 15m bars — covers thick+thin+refill comfortably
    });
    const candles = ohlcv?.candles;
    if (!Array.isArray(candles) || candles.length < 60) {
      return holdResult(['fable_insufficient_candles']);
    }

    const { thick, thin, refill } = partitionSessions(candles, nowMs);
    if (thick.length < 24) return holdResult(['fable_thick_session_incomplete']); // >=6h of 8
    if (thin.length < 12) return holdResult(['fable_thin_session_incomplete']);   // >=3h of 4
    if (refill.length < 1) return holdResult(['fable_no_refill_candle_yet']);

    // 2) Markdown: thin-session net move must be a controlled drop.
    const thinOpen = Number(thin[0].open);
    const thinClose = Number(thin[thin.length - 1].close);
    if (!(thinOpen > 0) || !(thinClose > 0)) return holdResult(['fable_bad_thin_prices']);
    const markdownPct = ((thinClose - thinOpen) / thinOpen) * 100;
    const mdMin = Number(cfg.markdownMinPct ?? 2);
    const mdMax = Number(cfg.markdownMaxPct ?? 9);
    if (markdownPct > -mdMin) return holdResult(['fable_no_markdown'], { markdownPct });
    if (markdownPct < -mdMax) return holdResult(['fable_markdown_too_deep'], { markdownPct });

    // 3) Thin tape: per-bar volume in the thin window must be BELOW the thick
    //    session's — the markdown happened into an empty book, not real flow.
    const thinVolPerBar = sum(thin.map((c) => c.volume)) / thin.length;
    const thickVolPerBar = sum(thick.map((c) => c.volume)) / thick.length;
    if (!(thickVolPerBar > 0)) return holdResult(['fable_no_thick_volume']);
    const thinVolRatio = thinVolPerBar / thickVolPerBar;
    const maxThinRatio = Number(cfg.thinVolMaxRatio ?? 0.8);
    if (thinVolRatio > maxThinRatio) {
      return holdResult(['fable_markdown_on_real_volume'], { markdownPct, thinVolRatio });
    }

    // 4) Structure held: thick-session support survived the markdown.
    const thickLow = Math.min(...thick.map((c) => Number(c.low)));
    const thinLow = Math.min(...thin.map((c) => Number(c.low)));
    const price = Number(tokenData.price || refill[refill.length - 1].close);
    if (!(price > 0)) return holdResult(['fable_no_price']);
    const supportTolerance = 1 - Number(cfg.supportBreakTolerancePct ?? 0.5) / 100;
    if (thinLow < thickLow * supportTolerance) {
      return holdResult(['fable_thick_support_broken'], { thickLow, thinLow });
    }
    if (price <= thickLow) return holdResult(['fable_price_below_thick_support'], { thickLow, price });

    // 5) Bid returning: last completed refill candle green on volume above the
    //    thin-session median — liquidity is actually coming back, we're not
    //    catching a still-falling knife in an empty book.
    const confirm = refill[refill.length - 1];
    const confirmGreen = Number(confirm.close) > Number(confirm.open);
    const thinVolMedian = median(thin.map((c) => c.volume));
    const bidVolRatio = thinVolMedian > 0 ? Number(confirm.volume) / thinVolMedian : 0;
    const minBidVolRatio = Number(cfg.bidReturnVolRatio ?? 1.2);
    if (!confirmGreen) return holdResult(['fable_no_bid_confirmation'], { markdownPct, thinVolRatio });
    if (bidVolRatio < minBidVolRatio) {
      return holdResult(['fable_bid_volume_too_light'], { bidVolRatio });
    }

    // 6) Not a knife: confirmation candle range must be orderly.
    const confirmRangePct = ((Number(confirm.high) - Number(confirm.low)) / Number(confirm.close)) * 100;
    if (confirmRangePct > Number(cfg.maxKnifeRangePct ?? 3)) {
      return holdResult(['fable_knife_candle'], { confirmRangePct });
    }

    // 7) Geometry: stop under the thin low (capped), target = 61.8% retrace
    //    of the markdown from entry. Reject wide stops and poor R:R.
    const stopStructural = thinLow * (1 - Number(cfg.stopUnderLowPct ?? 0.2) / 100);
    const stopCap = price * (1 - Number(cfg.maxStopDistancePct ?? 6) / 100);
    const stopPrice = Math.max(stopStructural, stopCap) === stopCap && stopStructural < stopCap
      ? stopCap // structural stop too far — cap it
      : stopStructural;
    const stopDistancePct = ((price - stopPrice) / price) * 100;
    if (!(stopDistancePct > 0.3)) return holdResult(['fable_stop_too_tight'], { stopDistancePct });

    const retraceFraction = Number(cfg.targetRetraceFraction ?? 0.618);
    const targetPrice = price * (1 + (Math.abs(markdownPct) * retraceFraction) / 100);
    const rr = (targetPrice - price) / (price - stopPrice);
    if (rr < Number(cfg.minRR ?? 1.0)) {
      return holdResult(['fable_rr_below_min'], { rr, stopDistancePct, markdownPct });
    }

    // Time exit: flat by 08:00 UTC today, before the marginal 08-12h bucket.
    const timeExit = new Date(nowMs);
    timeExit.setUTCHours(Number(cfg.timeExitUtcHour ?? 8), 0, 0, 0);

    return {
      signal: 'BUY',
      details: {
        setupType: 'fable',
        technicalSignal: 'BUY',
        confidence: Math.min(0.9, 0.55 + Math.min(0.2, (rr - 1) * 0.1) + Math.min(0.15, (maxThinRatio - thinVolRatio))),
        entryPrice: price,
        stopPrice,
        targetPrice,
        rr,
        markdownPct,
        thinVolRatio,
        bidVolRatio,
        confirmRangePct,
        thickLow,
        thinLow,
        stopDistancePct,
        timeExitAt: timeExit.toISOString(),
        riskPct: Number(cfg.riskPct ?? 0.35),
      },
    };
  }

  return { evaluate };
}

module.exports = { createFableEvaluator, partitionSessions };
