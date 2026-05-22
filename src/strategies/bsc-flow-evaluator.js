'use strict';

const { detectBscFlowBreakout } = require('./bsc-flow-breakout-detector');
const { checkBscFlowSafety } = require('./bsc-flow-safety');

function createBscFlowEvaluator(deps = {}) {
  async function evaluate(tokenData = {}, options = {}) {
    const cfg = options.config || {};
    if (!cfg.enabled) return { signal: 'HOLD', details: { setupType: 'bsc_flow_breakout', scannerReasons: ['strategy_disabled'] } };
    const safety = await checkBscFlowSafety(tokenData, {
      config: cfg,
      checkHoneypot: deps.checkHoneypot,
      fetchDexScreener: deps.fetchDexScreener,
    });
    if (!safety.ok) {
      return {
        signal: 'HOLD',
        details: {
          setupType: 'bsc_flow_breakout',
          technicalSignal: 'HOLD',
          triggerTimeframe: '60m_flow',
          structureType: 'bsc_flow_breakout',
          scannerReasons: safety.reasons,
          reasons: safety.reasons,
          metrics: safety.metrics,
        },
      };
    }
    const result = detectBscFlowBreakout(safety.tokenData, cfg);
    return {
      signal: result.signal,
      details: {
        setupType: 'bsc_flow_breakout',
        technicalSignal: result.signal,
        triggerTimeframe: '60m_flow',
        structureType: result.structureType || 'bsc_flow_breakout',
        scannerReasons: result.qualifies ? [] : result.reasons,
        reasons: result.reasons,
        stopPrice: result.stopPrice,
        targetPrice: result.targetPrice,
        riskPct: result.riskPct,
        maxSlippagePct: result.maxSlippagePct,
        staleExitMinutes: result.staleExitMinutes,
        useMevJitter: result.useMevJitter,
        metrics: { ...(result.metrics || {}), safety: safety.metrics },
      },
    };
  }
  return { evaluate };
}

module.exports = { createBscFlowEvaluator };
