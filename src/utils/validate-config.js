'use strict';

const logger = require('./logger');

function pushMissing(required, value, key) {
  if (!value || String(value).trim() === '') {
    required.push(key);
  }
}

function validateConfig(config) {
  const warnings = [];
  const errors = [];

  if (!Number.isFinite(config.bot.scanIntervalSeconds) || config.bot.scanIntervalSeconds < 30) {
    warnings.push(`SCAN_INTERVAL_SECONDS=${config.bot.scanIntervalSeconds} is very low; use 60-90s for live mode.`);
  }

  if (!config.paperTrading) {
    const walletKeys = [
      { key: 'SOLANA_PRIVATE_KEY', value: config.solana.privateKey, label: 'Solana' },
      { key: 'BSC_PRIVATE_KEY', value: config.bsc.privateKey, label: 'BSC' },
      { key: 'BASE_PRIVATE_KEY', value: config.base.privateKey, label: 'Base' },
    ];

    const configuredWallets = walletKeys.filter((item) => item.value && String(item.value).trim() !== '');
    if (configuredWallets.length === 0) {
      errors.push('Live mode requires at least one funded chain private key (SOLANA_PRIVATE_KEY, BSC_PRIVATE_KEY, or BASE_PRIVATE_KEY).');
    }

    walletKeys
      .filter((item) => !item.value || String(item.value).trim() === '')
      .forEach((item) => warnings.push(`${item.label} private key missing (${item.key}); that chain will not execute live trades.`));

    if (!config.kucoin.apiKey || !config.kucoin.apiSecret || !config.kucoin.apiPassphrase) {
      warnings.push('KuCoin API credentials are missing; KuCoin adapter will degrade.');
    }

    const bindHost = String(config.dashboard?.bindHost || '').trim();
    const adminToken = String(config.dashboard?.adminToken || '').trim();
    if (bindHost && bindHost !== '127.0.0.1' && bindHost !== 'localhost' && bindHost !== '::1' && !adminToken) {
      errors.push('Dashboard is bound to a non-local host (DASHBOARD_BIND_HOST) without DASHBOARD_ADMIN_TOKEN. Write APIs are exposed to remote hosts. Either bind to localhost or set a strong admin token.');
    }
  }

  if (config.anthropic.enabled && !config.anthropic.apiKey) {
    warnings.push('ANTHROPIC_ENABLED=true but ANTHROPIC_API_KEY is missing; AI decisions will be skipped.');
  }

  if (config.risk.maxTokenAgeHours <= 0) {
    warnings.push(`MAX_TOKEN_AGE_HOURS=${config.risk.maxTokenAgeHours} disables launch-age risk checks.`);
  }

  if (config.execution.slippageBps < 10 || config.execution.slippageBps > 2000) {
    warnings.push(`SLIPPAGE_BPS=${config.execution.slippageBps} looks unusual.`);
  }

  if (config.execution.kucoinMaxSlippagePct <= 0 || config.execution.kucoinMaxSlippagePct > 10) {
    warnings.push(`KUCOIN_MAX_SLIPPAGE_PCT=${config.execution.kucoinMaxSlippagePct} looks unusual.`);
  }

  if (config.execution.solanaMaxPriceImpactPct <= 0 || config.execution.solanaMaxPriceImpactPct > 30) {
    warnings.push(`SOLANA_MAX_PRICE_IMPACT_PCT=${config.execution.solanaMaxPriceImpactPct} looks unusual.`);
  }

  if (config.risk.maxCorrelationPct < 30 || config.risk.maxCorrelationPct > 100) {
    warnings.push(`MAX_CORRELATION_PCT=${config.risk.maxCorrelationPct} is outside the recommended 50-90 range.`);
  }

  if (config.risk.aiConfidenceFloor < 40 || config.risk.aiConfidenceFloor > 95) {
    warnings.push(`AI_CONFIDENCE_FLOOR=${config.risk.aiConfidenceFloor} is outside the recommended 60-85 range.`);
  }

  if (config.ai.narrativeMinScore < 40 || config.ai.narrativeMinScore > 90) {
    warnings.push(`AI_NARRATIVE_MIN_SCORE=${config.ai.narrativeMinScore} is outside the recommended 55-75 range.`);
  }

  if (config.strategy.minNetBuyFlowUsd < 5000) {
    warnings.push(`MIN_NET_BUY_FLOW_USD=${config.strategy.minNetBuyFlowUsd} is low for smart-money filtering.`);
  }

  warnings.forEach((line) => logger.warn(`Config validation: ${line}`));
  errors.forEach((line) => logger.error(`Config validation: ${line}`));

  return {
    ok: errors.length === 0,
    warnings,
    errors,
  };
}

module.exports = { validateConfig };
