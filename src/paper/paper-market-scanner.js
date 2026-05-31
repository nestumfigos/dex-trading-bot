'use strict';

const { calculateTimeOpenAnchors } = require('../strategies/perps-anchors');
const { detectHorizontalRange } = require('../strategies/perps-range-detector');
const { evaluateTraderXoEntry, evaluatePositionManagement } = require('../strategies/traderxo-paper-engine');
const { resolveStrategyVariant, evaluateVariantEntry } = require('../strategies/traderxo-research-variants');

function createPaperMarketScanner({
  processor,
  telemetry,
  feed,
  symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
  equityUsd = 10000,
  leverage = 3,
  now = () => Date.now(),
  entryAdmission = null,
  // B6P.ws-wire: optional. When provided, scanner asks for the latest mark
  // price per symbol and passes it into the order so calculatePaperPosition
  // can anchor stopDistance + liquidationPrice on mark instead of entry.
  getLatestMarkPrice = null,
} = {}) {
  if (!processor || !telemetry || !feed) throw new Error('processor, telemetry, and feed are required');
  const status = { enabled: true, active: false, lastScanAt: null, lastError: null, lastResults: [] };

  async function scanSymbol(symbol) {
    const normalizedSymbol = String(symbol).trim().toUpperCase();
    const [candles5m, candles15m, candles1h, dailyCandles] = await Promise.all([
      feed.getCompletedCandles(normalizedSymbol, '5m', 24),
      feed.getCompletedCandles(normalizedSymbol, '15m', 24),
      feed.getCompletedCandles(normalizedSymbol, '1h', 18),
      feed.getDailyCandles(normalizedSymbol, 40),
    ]);
    const latest = candles15m[candles15m.length - 1];
    if (!latest) return { symbol: normalizedSymbol, action: 'HOLD', reasons: ['no_completed_15m_candle'] };
    const open = telemetry.listOpenPositions().find((position) => position.symbol === normalizedSymbol);
    if (open) {
      const positionVariant = resolveStrategyVariant(open.variantId || 'baseline');
      const openedMarketAt = Number(open.openedMarketAt || 0);
      const barsSinceEntry = candles15m.filter((candle) => candle.openTime > openedMarketAt).length;
      const management = evaluatePositionManagement({
        position: open,
        candle: latest,
        barsSinceEntry,
        policy: positionVariant.management,
      });
      if (management.action === 'HOLD') return { symbol: normalizedSymbol, ...management };
      // B1P.10: re-sync position state before emitting EXIT. A concurrent HTTP signal
      // may have already closed this position between the listOpenPositions() snapshot
      // and now. Avoid surfacing a misleading accepted=true result downstream.
      const stillOpen = telemetry.listOpenPositions().some((position) => String(position.id) === String(open.id));
      if (!stillOpen) {
        return { symbol: normalizedSymbol, action: 'HOLD', reasons: ['position_already_closed_between_scan_and_exit'] };
      }
      const result = processor.processSignal({
        id: `native-exit:${normalizedSymbol}:${latest.openTime}:${management.reason}`,
        paperOnly: true,
        approved: true,
        market: 'perps',
        strategy: 'traderxo_perps',
        action: 'EXIT',
        positionId: open.id,
        exit: {
          price: management.price,
          notionalUsd: management.notionalUsd,
          reason: management.reason,
          nextStopPrice: management.nextStopPrice,
        },
      });
      return { symbol: normalizedSymbol, action: management.action, result };
    }
    const admitted = entryAdmission?.getEntryPolicy?.() || {
      allow: true,
      variant: resolveStrategyVariant('baseline'),
    };
    if (!admitted.allow) {
      return { symbol: normalizedSymbol, action: 'HOLD', reasons: [admitted.reason] };
    }
    const range = detectHorizontalRange(candles1h.slice(0, -2));
    if (!range.qualifies) return { symbol: normalizedSymbol, action: 'HOLD', reasons: range.reasons };
    const anchors = calculateTimeOpenAnchors({ dailyCandles, currentPrice: latest.close });
    const monthlyOpen = Number(anchors.monthlyOpen);
    const levelToLevel = anchors.sideBias === 'long' && monthlyOpen > range.high
      ? { level: range.high, nextTarget: monthlyOpen }
      : anchors.sideBias === 'short' && monthlyOpen < range.low
        ? { level: range.low, nextTarget: monthlyOpen }
        : null;
    const intent = evaluateTraderXoEntry({
      symbol: normalizedSymbol,
      candles15m,
      candles5m,
      range,
      anchors,
      equityUsd,
      leverage,
      levelToLevel,
    });
    if (!intent.qualifies) return { symbol: normalizedSymbol, action: 'HOLD', reasons: intent.reasons };
    const rangeWindow = candles1h.slice(-12);
    const averageRangePct = rangeWindow.reduce((sum, candle) => (
      sum + ((Number(candle.high) - Number(candle.low)) / Number(candle.close)) * 100
    ), 0) / Math.max(1, rangeWindow.length);
    const firstClose = Number(rangeWindow[0]?.close);
    const lastClose = Number(rangeWindow[rangeWindow.length - 1]?.close);
    const directionPct = firstClose > 0 ? (Math.abs(lastClose - firstClose) / firstClose) * 100 : 0;
    const regime = averageRangePct >= 2 ? 'volatile' : (directionPct >= 3 ? 'trending' : 'ranging');
    const variantGate = evaluateVariantEntry({ intent, regime, variant: admitted.variant });
    if (!variantGate.allow) return { symbol: normalizedSymbol, action: 'HOLD', reasons: [variantGate.reason] };
    const positionId = `native-perps:${normalizedSymbol}`;
    // B6P.ws-wire: enrich order with markPrice + symbol so sizing can use them
    // for MM tier lookup (B5P.4) and mark-anchored stop math (B5P.5).
    const markPrice = (typeof getLatestMarkPrice === 'function')
      ? getLatestMarkPrice(normalizedSymbol)
      : null;
    const orderWithMeta = {
      ...intent.order,
      variantId: admitted.variant.id,
      openedMarketAt: latest.openTime,
      symbol: normalizedSymbol,
    };
    if (Number.isFinite(Number(markPrice)) && Number(markPrice) > 0) {
      orderWithMeta.markPrice = Number(markPrice);
    }
    const result = processor.processSignal({
      id: `native-open:${normalizedSymbol}:${latest.openTime}:${intent.setup}:${intent.side}`,
      paperOnly: true,
      approved: true,
      market: 'perps',
      strategy: 'traderxo_perps',
      action: intent.side === 'long' ? 'OPEN_LONG' : 'OPEN_SHORT',
      positionId,
      setup: intent.setup,
      order: orderWithMeta,
    });
    return { symbol: normalizedSymbol, action: result.accepted ? 'OPEN' : 'REJECTED', intent, result };
  }

  async function scanAll() {
    if (status.active) return { skipped: true, reason: 'scan_already_active' };
    status.active = true;
    try {
      const results = [];
      for (const symbol of symbols) {
        try {
          results.push(await scanSymbol(symbol));
        } catch (error) {
          results.push({ symbol, action: 'ERROR', reason: error.message });
        }
      }
      status.lastScanAt = new Date(Number(now())).toISOString();
      status.lastResults = results;
      const errors = results.filter((result) => result.action === 'ERROR');
      status.lastError = errors.length > 0
        ? errors.map((result) => `${result.symbol}:${result.reason}`).join('; ')
        : null;
      return { skipped: false, results };
    } catch (error) {
      status.lastError = error.message;
      throw error;
    } finally {
      status.active = false;
    }
  }

  function getStatus() {
    return {
      ...status,
      admission: entryAdmission?.getStatus?.() || { required: false, allowNewPaperEntries: true, variantId: 'baseline' },
      lastResults: status.lastResults.map((result) => ({ ...result })),
    };
  }

  return { scanAll, scanSymbol, getStatus };
}

module.exports = { createPaperMarketScanner };
