'use strict';

// Bull-flag strategy evaluator (Week 12 B.3).
// Returns evaluation contract { signal, details } matching strategy.evaluateForStrategy shape.
// Wraps the pure detector with scanner gates (24h volume, liquidity, net edge) and
// chain enablement / per-chain overrides.
//
// Factory-injected for testability:
//   - fetchOhlcv({ chainKey, address, pairAddress, interval, limit }) → Promise<{ candles, ... } | null>
//
// Returns:
//   { signal: 'BUY'|'HOLD', details: { ...detectorOutput, scannerReasons, setupType, ... } }

function createBullFlagEvaluator({ logger, fetchOhlcv, detectBullFlag }) {
  if (typeof fetchOhlcv !== 'function') throw new Error('bull-flag evaluator: fetchOhlcv required');
  if (typeof detectBullFlag !== 'function') throw new Error('bull-flag evaluator: detectBullFlag required');
  const log = logger || { info() {}, warn() {}, debug() {}, error() {} };

  function resolveChainCfg(cfg, chainKey) {
    const base = { ...cfg };
    const override = cfg?.perChainOverrides?.[chainKey] || null;
    if (override) Object.assign(base, override);
    return base;
  }

  function holdResult(reasons, extra = {}) {
    return {
      signal: 'HOLD',
      details: {
        setupType: 'spot_day_bull_flag',
        technicalSignal: 'HOLD',
        scannerReasons: reasons,
        ...extra,
      },
    };
  }

  function num(value, fallback = 0) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : fallback;
  }

  function pctChange(from, to) {
    return from > 0 ? ((to - from) / from) * 100 : 0;
  }

  function parseList(value, fallback) {
    if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
    const raw = String(value || '').trim();
    if (!raw) return fallback.slice();
    return raw.split(',').map((item) => item.trim()).filter(Boolean);
  }

  function timeframeMinutes(interval) {
    const match = String(interval || '15m').toLowerCase().match(/^(\d+)(m|h)$/);
    if (!match) return 15;
    const amount = Number(match[1]);
    return match[2] === 'h' ? amount * 60 : amount;
  }

  function normalizeCandle(raw) {
    if (!raw) return null;
    const open = Number(raw.open ?? raw.o);
    const high = Number(raw.high ?? raw.h);
    const low = Number(raw.low ?? raw.l);
    const close = Number(raw.close ?? raw.c);
    const volume = Number(raw.volume ?? raw.v ?? 0);
    if (![open, high, low, close].every((value) => Number.isFinite(value) && value > 0)) return null;
    return { open, high, low, close, volume: Number.isFinite(volume) ? volume : 0, timestamp: raw.timestamp ?? raw.t ?? null };
  }

  function ema(values, period) {
    const closes = values.map(Number).filter((value) => Number.isFinite(value) && value > 0);
    const span = Math.max(1, Number(period || 1));
    if (closes.length < span) return null;
    const k = 2 / (span + 1);
    let current = closes.slice(0, span).reduce((sum, value) => sum + value, 0) / span;
    for (let i = span; i < closes.length; i += 1) {
      current = closes[i] * k + current * (1 - k);
    }
    return current;
  }

  function checkEmaConfirmation(candles, cfg) {
    const normalized = (Array.isArray(candles) ? candles : []).map(normalizeCandle).filter(Boolean);
    const fastPeriod = Math.max(1, num(cfg.emaFastPeriod, 9));
    const slowPeriod = Math.max(fastPeriod + 1, num(cfg.emaSlowPeriod, 21));
    if (normalized.length < slowPeriod) {
      return { pass: false, reason: 'ema_confirmation_insufficient_candles', candlesAvailable: normalized.length };
    }
    const closes = normalized.map((row) => row.close);
    const fast = ema(closes, fastPeriod);
    const slow = ema(closes, slowPeriod);
    const close = closes[closes.length - 1];
    const tolerancePct = Math.max(0, num(cfg.emaTolerancePct, 0.15));
    const tolerance = 1 - (tolerancePct / 100);
    const pass = close >= fast * tolerance && fast >= slow * tolerance;
    return { pass, reason: pass ? 'ema_constructive' : 'ema_confirmation_failed', emaFast: fast, emaSlow: slow, close };
  }

  function checkOneHourConfirmation(candles) {
    const normalized = (Array.isArray(candles) ? candles : []).map(normalizeCandle).filter(Boolean);
    if (normalized.length < 2) {
      return { pass: false, reason: 'one_hour_confirmation_insufficient_candles', candlesAvailable: normalized.length };
    }
    const latest = normalized[normalized.length - 1];
    const prior = normalized[normalized.length - 2];
    const priorMidpoint = (prior.high + prior.low) / 2;
    const pass = latest.close >= latest.open || latest.close >= priorMidpoint;
    return {
      pass,
      reason: pass ? 'one_hour_constructive' : 'one_hour_confirmation_failed',
      open: latest.open,
      close: latest.close,
      priorMidpoint,
    };
  }

  function spreadBpsFromToken(tokenData) {
    const explicit = num(tokenData.expectedSpreadBps ?? tokenData.spreadBps, NaN);
    if (Number.isFinite(explicit)) return Math.max(0, explicit);
    const bid = num(tokenData.bestBid ?? tokenData.bid, 0);
    const ask = num(tokenData.bestAsk ?? tokenData.ask, 0);
    if (bid > 0 && ask > bid) return ((ask - bid) / bid) * 10_000;
    return 0;
  }

  function checkOrderBookTokenGate(tokenData, cfg) {
    const bidDepth = num(tokenData.bidDepthUsd ?? tokenData.bidDepth ?? tokenData.orderBookBidUsd, 0);
    const askDepth = num(tokenData.askDepthUsd ?? tokenData.askDepth ?? tokenData.orderBookAskUsd, 0);
    if (!(bidDepth > 0) || !(askDepth > 0)) return { pass: true, reason: 'orderbook_unavailable' };
    const maxAskBidDepthRatio = Math.max(1, num(cfg.maxAskBidDepthRatio, 1.35));
    const minDepthImbalance = num(cfg.minOrderBookDepthImbalance, -0.15);
    const ratio = askDepth / bidDepth;
    const imbalance = (bidDepth - askDepth) / (bidDepth + askDepth);
    if (ratio > maxAskBidDepthRatio) {
      return { pass: false, reason: `ask_wall_depth_ratio:${ratio.toFixed(2)}>${maxAskBidDepthRatio}`, bidDepth, askDepth, ratio, imbalance };
    }
    if (imbalance < minDepthImbalance) {
      return { pass: false, reason: `orderbook_depth_imbalance:${imbalance.toFixed(2)}<${minDepthImbalance}`, bidDepth, askDepth, ratio, imbalance };
    }
    return { pass: true, reason: 'orderbook_constructive', bidDepth, askDepth, ratio, imbalance };
  }

  async function fetchSeries(tokenData, chainKey, interval, cfg) {
    return fetchOhlcv({
      chainKey,
      symbol: tokenData.symbol,
      address: tokenData.address,
      pairAddress: tokenData.pairAddress || tokenData.poolAddress,
      interval,
      limit: Math.max(
        30,
        Number(cfg.latestVolumeLookbackCandles || 20)
          + Number(cfg.flagMaxCandles || 8)
          + Number(cfg.poleMaxCandles || 4)
          + 8,
      ),
    });
  }

  async function evaluate(tokenData = {}, options = {}) {
    const cfgRaw = options.config || {};
    const chainKey = String(options.chainKey || tokenData.chainKey || tokenData.chain || '').toLowerCase();
    const cfg = resolveChainCfg(cfgRaw, chainKey);

    if (!cfg.enabled) return holdResult(['strategy_disabled']);

    if (Array.isArray(cfg.enabledChains) && cfg.enabledChains.length && !cfg.enabledChains.includes(chainKey)) {
      return holdResult([`chain_not_enabled:${chainKey}`]);
    }

    const volume24hUsd = Number(tokenData.volume24hUsd || tokenData.volume24h || 0);
    const liquidityUsd = Number(tokenData.liquidityUsd || 0);
    const minVol = Number(cfg.min24hVolumeUsd || 0);
    const minLiq = Number(cfg.minLiquidityUsd || 0);

    if (volume24hUsd < minVol) {
      return holdResult([`volume_below_min:${volume24hUsd.toFixed(0)}<${minVol}`], { volume24hUsd });
    }
    if (liquidityUsd < minLiq) {
      return holdResult([`liquidity_below_min:${liquidityUsd.toFixed(0)}<${minLiq}`], { liquidityUsd });
    }

    if (cfg.minTokenAgeDays > 0) {
      const ageDays = Number(tokenData.ageDays || tokenData.tokenAgeDays || 0);
      if (ageDays > 0 && ageDays < cfg.minTokenAgeDays) {
        return holdResult([`token_age_below_min:${ageDays}<${cfg.minTokenAgeDays}d`], { ageDays });
      }
    }

    const seriesByInterval = new Map();
    const detectorAttempts = [];
    const intervals = parseList(cfg.timeframes || cfg.triggerTimeframes, ['15m']);
    let selected = null;

    for (const interval of intervals) {
      let ohlcv;
      try {
        ohlcv = await fetchSeries(tokenData, chainKey, interval, cfg);
      } catch (error) {
        log.debug(`[bull-flag] OHLCV fetch failed for ${tokenData.symbol} ${interval}: ${error.message}`);
        detectorAttempts.push({ interval, reason: 'ohlcv_fetch_error' });
        continue;
      }

      if (!ohlcv || !Array.isArray(ohlcv.candles) || !ohlcv.candles.length) {
        detectorAttempts.push({ interval, reason: 'ohlcv_unavailable' });
        continue;
      }

      seriesByInterval.set(interval, ohlcv);
      const detection = detectBullFlag(ohlcv.candles, {
        setupType: cfg.setupType || 'spot_day_bull_flag',
        polePctMin: cfg.polePctMin,
        poleMaxCandles: interval === '5m' ? Number(cfg.fiveMinutePoleMaxCandles || 12) : cfg.poleMaxCandles,
        flagMinCandles: interval === '5m' ? Number(cfg.fiveMinuteFlagMinCandles || 3) : cfg.flagMinCandles,
        flagMaxCandles: interval === '5m' ? Number(cfg.fiveMinuteFlagMaxCandles || 24) : cfg.flagMaxCandles,
        flagDepthMaxPct: cfg.flagDepthMaxPct,
        maxFlagUpwardDriftPct: cfg.maxFlagUpwardDriftPct,
        flagVolContractMaxRatio: cfg.flagVolContractMaxRatio,
        breakoutVolMinRatio: cfg.breakoutVolMinRatio,
        latestVolumeLookbackCandles: cfg.latestVolumeLookbackCandles,
        latestVolumeMinRatio: cfg.latestVolumeMinRatio,
        minSixtyMinuteMovePct: cfg.minSixtyMinuteMovePct,
        maxSixtyMinuteMovePct: cfg.maxSixtyMinuteMovePct,
        breakoutLookbackCandles: interval === '5m'
          ? Number(cfg.fiveMinuteBreakoutLookbackCandles || cfg.breakoutLookbackCandles || 0)
          : Number(cfg.breakoutLookbackCandles || 0),
        allowTrendlineBreakout: cfg.allowTrendlineBreakout !== false,
        allowContinuationScout: cfg.allowContinuationScout === true,
        scoutPolePctMin: cfg.scoutPolePctMin,
        scoutMinSixtyMinuteMovePct: cfg.scoutMinSixtyMinuteMovePct,
        scoutLatestVolumeMinRatio: cfg.scoutLatestVolumeMinRatio,
        scoutBreakoutVolMinRatio: cfg.scoutBreakoutVolMinRatio,
        scoutFlagVolContractMaxRatio: cfg.scoutFlagVolContractMaxRatio,
        scoutLookbackCandles: cfg.scoutLookbackCandles,
        scoutMinPullbackPct: cfg.scoutMinPullbackPct,
        scoutMaxDepthPct: cfg.scoutMaxDepthPct,
        scoutBreakoutReclaimTolerancePct: cfg.scoutBreakoutReclaimTolerancePct,
        timeframeMinutes: timeframeMinutes(interval),
      });

      detectorAttempts.push({ interval, reason: detection.reason || 'qualified', detection });
      if (detection.qualifies) {
        selected = { interval, ohlcv, detection };
        break;
      }
    }

    if (!selected) {
      const firstReason = detectorAttempts.find((item) => item.reason)?.reason || 'no_qualify';
      const reason = String(firstReason).startsWith('ohlcv_') ? firstReason : `detector:${firstReason}`;
      return holdResult([reason], { detectorAttempts });
    }

    const { detection } = selected;

    if (cfg.requireEmaConfirmation !== false) {
      let emaSeries = seriesByInterval.get('15m');
      if (!emaSeries && selected.interval !== '15m') {
        try {
          emaSeries = await fetchSeries(tokenData, chainKey, '15m', cfg);
          if (emaSeries?.candles?.length) seriesByInterval.set('15m', emaSeries);
        } catch (_) {
          emaSeries = null;
        }
      }
      const emaCheck = checkEmaConfirmation(emaSeries?.candles || selected.ohlcv.candles, cfg);
      if (!emaCheck.pass) return holdResult([emaCheck.reason], { detection, emaCheck });
    }

    if (cfg.requireOneHourConfirmation !== false) {
      let oneHourSeries = seriesByInterval.get('1h');
      if (!oneHourSeries) {
        try {
          oneHourSeries = await fetchSeries(tokenData, chainKey, '1h', cfg);
          if (oneHourSeries?.candles?.length) seriesByInterval.set('1h', oneHourSeries);
        } catch (_) {
          oneHourSeries = null;
        }
      }
      const oneHourCheck = checkOneHourConfirmation(oneHourSeries?.candles || []);
      if (!oneHourCheck.pass) return holdResult([oneHourCheck.reason], { detection, oneHourCheck });
    }

    // Stop-distance hard cap: skip if stop is too far from entry
    const tokenPrice = Number(tokenData.price || 0);
    const entryPrice = tokenPrice > 0 ? Math.max(tokenPrice, Number(detection.breakoutClose || 0)) : Number(detection.breakoutClose || 0);
    const stopDistancePct = pctChange(entryPrice, Number(detection.stopPrice || 0));
    const targetDistancePct = pctChange(entryPrice, Number(detection.targetPrice || 0));
    const stopDistanceAbsPct = Math.abs(Number(stopDistancePct || 0));
    if (cfg.maxStopDistancePct && stopDistanceAbsPct > Number(cfg.maxStopDistancePct)) {
      return holdResult([`stop_distance_too_wide:${stopDistanceAbsPct.toFixed(2)}>${cfg.maxStopDistancePct}`], { detection });
    }

    // Net-edge gate: measured move must exceed estimated fees+slippage by minNetEdgePct
    const expectedFeesBps = Number(tokenData.expectedFeesBps ?? cfg.expectedFeesBps ?? 30); // ~0.3% round-trip default
    const tokenSlippageBps = Number(tokenData.expectedSlippageBps);
    const tokenSlippagePct = Number(tokenData.expectedSlippagePct);
    const expectedSlippageBps = Number.isFinite(tokenSlippageBps)
      ? tokenSlippageBps
      : (Number.isFinite(tokenSlippagePct) ? tokenSlippagePct * 100 : Number(cfg.expectedSlippageBps ?? 20));
    const expectedSpreadBps = spreadBpsFromToken(tokenData);
    const totalCostPct = (expectedFeesBps + expectedSlippageBps + expectedSpreadBps) / 100;
    const netEdgePct = Number(targetDistancePct || 0) - totalCostPct;
    if (cfg.minNetEdgePct && netEdgePct < Number(cfg.minNetEdgePct)) {
      return holdResult([`net_edge_too_thin:${netEdgePct.toFixed(2)}<${cfg.minNetEdgePct}`], { detection, netEdgePct, totalCostPct });
    }
    if (stopDistanceAbsPct <= totalCostPct) {
      return holdResult([`stop_distance_inside_cost_buffer:${stopDistanceAbsPct.toFixed(2)}<=${totalCostPct.toFixed(2)}`], { detection, totalCostPct });
    }

    const measuredMoveAbs = Number(detection.targetPrice || 0) - Number(detection.breakoutClose || 0);
    const targetRemainingAbs = Number(detection.targetPrice || 0) - entryPrice;
    const targetRemainingPctOfMove = measuredMoveAbs > 0 ? (targetRemainingAbs / measuredMoveAbs) * 100 : 0;
    const minTargetRemainingPct = Number(cfg.minTargetRemainingPct ?? 20);
    if (!(targetRemainingAbs > 0) || targetRemainingPctOfMove < minTargetRemainingPct) {
      return holdResult([`entry_too_close_to_target:${targetRemainingPctOfMove.toFixed(1)}<${minTargetRemainingPct}`], {
        detection,
        entryPrice,
        targetRemainingPctOfMove,
      });
    }

    // C3 (Phase C): minimum reward-to-risk gate. plan/day-trade.txt explicitly
    // requires net win average at least 2x net loss; combined with the +5% pole
    // floor that implies a minimum RR ~2. Without this gate, a marginal flag
    // with a wide flag-low could pass net-edge but ship a 1.2R trade —
    // exhausting the daily-loss budget on three flat losses. Default 2.0;
    // override via cfg.minRR.
    const minRR = Number(cfg.minRR || 2.0);
    const rrValue = stopDistanceAbsPct > 0 ? targetDistancePct / stopDistanceAbsPct : Number(detection.rr);
    if (Number.isFinite(rrValue) && rrValue < minRR) {
      return holdResult([`reward_risk_below_min:${rrValue.toFixed(2)}<${minRR}`], { detection, rr: rrValue });
    }

    const orderBookGate = checkOrderBookTokenGate(tokenData, cfg);
    if (!orderBookGate.pass) {
      return holdResult([orderBookGate.reason], { detection, orderBookGate });
    }

    // Determine A+ grade
    const isAPlus = (Number(detection.volumeExpansion) >= Number(cfg.aPlusVolumeExpansionMin || Infinity)) &&
                    (Number(detection.flagDepthPct) <= Number(cfg.aPlusFlagDepthMaxPct || -Infinity));

    return {
      signal: 'BUY',
      details: {
        setupType: 'spot_day_bull_flag',
        technicalSignal: 'BUY',
        triggerTimeframe: selected.interval,
        confidence: Math.min(1, Math.max(0.55, 0.55 + Math.min(0.35, (Number(detection.rr) || 0) / 10))),
        detection,
        entryPrice,
        netEdgePct,
        totalCostPct,
        expectedFeesBps,
        expectedSlippageBps,
        expectedSpreadBps,
        isAPlus,
        riskPct: isAPlus ? Number(cfg.riskPctAPlus || 0.50) : Number(cfg.riskPctBase || 0.35),
        stopPrice: detection.stopPrice,
        targetPrice: detection.targetPrice,
        breakoutClose: detection.breakoutClose,
        flagHigh: detection.flagHigh,
        flagLow: detection.flagLow,
        poleStartPrice: detection.poleStartPrice,
        poleHighPrice: detection.poleHighPrice,
        poleHeightPct: detection.poleHeightPct,
        flagDepthPct: detection.flagDepthPct,
        volumeExpansion: detection.volumeExpansion,
        latestVolumeRatio: detection.latestVolumeRatio,
        volumeContraction: detection.volumeContraction,
        sixtyMinuteMovePct: detection.sixtyMinuteMovePct,
        targetRemainingPctOfMove,
        rr: rrValue,
        scannerReasons: [],
        reasons: [],
      },
    };
  }

  return { evaluate };
}

module.exports = { createBullFlagEvaluator };
