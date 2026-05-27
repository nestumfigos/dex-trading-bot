'use strict';

function createPaperSignalProcessor({ adapter, telemetry, now = () => new Date().toISOString() } = {}) {
  if (!adapter) throw new Error('paper execution adapter is required');

  function reject(signalId, reasons) {
    const result = { accepted: false, signalId, reasons };
    if (signalId && !telemetry?.hasSignal?.(signalId)) {
      telemetry?.recordSignalEvent?.({ signalId, accepted: false, reasons, processedAt: now() });
    }
    return result;
  }

  function processSignal(signal = {}) {
    const signalId = String(signal.id || '').trim();
    if (!signalId) return { accepted: false, reasons: ['signal_id_required'] };
    if (telemetry?.hasSignal?.(signalId)) {
      return { accepted: false, signalId, duplicate: true, reasons: ['duplicate_signal'] };
    }
    if (signal.paperOnly !== true || signal.approved !== true) {
      return reject(signalId, ['approved_paper_signal_required']);
    }
    if (
      String(signal.market || '').toLowerCase() !== 'perps'
      || String(signal.strategy || '').toLowerCase() !== 'traderxo_perps'
    ) {
      return reject(signalId, ['traderxo_perps_signal_required']);
    }

    const action = String(signal.action || '').toUpperCase();
    const signalEvent = {
      signalId,
      action,
      positionId: String(signal.positionId || signalId),
      processedAt: now(),
    };
    let result;
    if (action === 'OPEN_LONG' || action === 'OPEN_SHORT') {
      result = adapter.openPosition({
        ...signal.order,
        id: String(signal.positionId || signalId),
        signalId,
        side: action === 'OPEN_LONG' ? 'long' : 'short',
        market: 'perps',
        strategy: 'traderxo_perps',
        setup: signal.setup || signal.order?.setup || null,
      }, { signalEvent });
    } else if (action === 'EXIT') {
      result = adapter.reduceOnlyExit({
        ...signal.exit,
        positionId: signal.positionId,
        signalId,
      }, { signalEvent });
    } else {
      return reject(signalId, ['unsupported_signal_action']);
    }

    if (!result.signalEventCommitted) {
      telemetry?.recordSignalEvent?.({
        ...signalEvent,
        accepted: Boolean(result.accepted),
        reasons: result.reasons || [],
      });
    }
    return { ...result, signalId };
  }

  return { processSignal };
}

module.exports = { createPaperSignalProcessor };
