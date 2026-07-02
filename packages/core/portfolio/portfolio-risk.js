'use strict';

function numberOr(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeExposureRow(row = {}) {
  return {
    botProfile: row.botProfile || row.bot_profile || null,
    marketType: row.marketType || row.market_type || null,
    symbol: row.symbol ? String(row.symbol).toUpperCase() : null,
    strategy: row.strategy || row.strategyId || row.strategy_id || null,
    notionalUsd: numberOr(
      row.notionalUsd ?? row.notional_usd ?? row.quoteUsd ?? row.quote_usd ?? row.positionUsd ?? row.position_usd,
      0,
    ),
    riskUsd: numberOr(
      row.riskUsd ?? row.risk_usd ?? row.maxLossUsd ?? row.max_loss_usd ?? row.riskAmountUsd ?? row.risk_amount_usd,
      0,
    ),
    unrealizedPnlUsd: numberOr(row.unrealizedPnlUsd ?? row.unrealized_pnl_usd, 0),
    correlationKey: row.correlationKey || row.correlation_key || row.symbol || null,
  };
}

function summarizeBy(rows, field) {
  return Object.values(rows.reduce((acc, row) => {
    const key = row[field] || 'unknown';
    acc[key] = acc[key] || { key, notionalUsd: 0, riskUsd: 0, count: 0 };
    acc[key].notionalUsd += row.notionalUsd;
    acc[key].riskUsd += Math.abs(row.riskUsd);
    acc[key].count += 1;
    return acc;
  }, {})).sort((left, right) => Math.abs(right.riskUsd) - Math.abs(left.riskUsd));
}

function resolveBudgetPct(budgets = {}, key = null, fallback = null) {
  if (!budgets || !key) return fallback;
  const direct = budgets[key] ?? budgets[String(key).toLowerCase()] ?? budgets[String(key).toUpperCase()];
  const raw = direct && typeof direct === 'object'
    ? direct.maxHeatPct ?? direct.heatPct ?? direct.budgetPct ?? direct.riskPct
    : direct;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : fallback;
}

function riskBudgetUsd(equityUsd, budgetPct) {
  const equity = Math.max(0, numberOr(equityUsd, 0));
  const pct = numberOr(budgetPct, 0);
  return equity > 0 && pct > 0 ? (equity * pct) / 100 : 0;
}

function findPairCorrelation(correlationPairs = {}, leftKey, rightKey) {
  if (!leftKey || !rightKey || leftKey === rightKey) return 0;
  const pairKey = `${leftKey}:${rightKey}`;
  const reverseKey = `${rightKey}:${leftKey}`;
  return Math.abs(numberOr(correlationPairs[pairKey] ?? correlationPairs[reverseKey], 0));
}

function summarizePortfolioRisk({
  exposures = [],
  equityUsd = 0,
  correlationPairs = {},
} = {}) {
  const rows = (Array.isArray(exposures) ? exposures : []).map(normalizeExposureRow);
  const equity = Math.max(0, numberOr(equityUsd, 0));
  const totalNotionalUsd = rows.reduce((sum, row) => sum + Math.abs(row.notionalUsd), 0);
  const totalRiskUsd = rows.reduce((sum, row) => sum + Math.abs(row.riskUsd), 0);
  const portfolioHeatPct = equity > 0 ? (totalRiskUsd / equity) * 100 : 0;

  const bySymbol = rows.reduce((acc, row) => {
    const key = row.symbol || 'unknown';
    acc[key] = acc[key] || { symbol: key, notionalUsd: 0, riskUsd: 0, count: 0 };
    acc[key].notionalUsd += row.notionalUsd;
    acc[key].riskUsd += row.riskUsd;
    acc[key].count += 1;
    return acc;
  }, {});

  let maxCorrelation = 0;
  const keys = rows.map((row) => row.correlationKey).filter(Boolean);
  for (let i = 0; i < keys.length; i += 1) {
    for (let j = i + 1; j < keys.length; j += 1) {
      const pairKey = `${keys[i]}:${keys[j]}`;
      const reverseKey = `${keys[j]}:${keys[i]}`;
      maxCorrelation = Math.max(
        maxCorrelation,
        Math.abs(numberOr(correlationPairs[pairKey] ?? correlationPairs[reverseKey], 0)),
      );
    }
  }

  return {
    equityUsd: equity,
    totalNotionalUsd,
    totalRiskUsd,
    portfolioHeatPct,
    openPositionCount: rows.length,
    maxCorrelation,
    bySymbol: Object.values(bySymbol).sort((left, right) => Math.abs(right.riskUsd) - Math.abs(left.riskUsd)),
    byProfile: summarizeBy(rows, 'botProfile').map((row) => ({ botProfile: row.key, ...row, key: undefined })),
    byStrategy: summarizeBy(rows, 'strategy').map((row) => ({ strategy: row.key, ...row, key: undefined })),
  };
}

function buildPortfolioAllocationPlan({
  exposures = [],
  equityUsd = 0,
  targetHeatPct = 3,
  maxHeatPct = 6,
  profileBudgets = {},
  strategyBudgets = {},
  correlationPairs = {},
  maxCorrelation = 1,
  proposedTrade = null,
} = {}) {
  const rows = (Array.isArray(exposures) ? exposures : []).map(normalizeExposureRow);
  const equity = Math.max(0, numberOr(equityUsd, 0));
  const targetPct = Math.max(0, numberOr(targetHeatPct, 3));
  const maxPct = Math.max(targetPct, numberOr(maxHeatPct, targetPct));
  const targetRiskUsd = riskBudgetUsd(equity, targetPct);
  const maxRiskUsd = riskBudgetUsd(equity, maxPct);
  const usedRiskUsd = rows.reduce((sum, row) => sum + Math.abs(row.riskUsd), 0);
  const currentHeatPct = equity > 0 ? (usedRiskUsd / equity) * 100 : 0;
  const availableRiskUsd = Math.max(0, maxRiskUsd - usedRiskUsd);
  const targetAvailableRiskUsd = Math.max(0, targetRiskUsd - usedRiskUsd);

  const profileAllocations = summarizeBy(rows, 'botProfile').map((row) => {
    const budgetPct = resolveBudgetPct(profileBudgets, row.key, null);
    const budgetRisk = budgetPct == null ? null : riskBudgetUsd(equity, budgetPct);
    const available = budgetRisk == null ? null : Math.max(0, budgetRisk - Math.abs(row.riskUsd));
    return {
      botProfile: row.key,
      riskUsd: row.riskUsd,
      notionalUsd: row.notionalUsd,
      count: row.count,
      budgetPct,
      budgetRiskUsd: budgetRisk,
      availableRiskUsd: available,
      utilizationPct: budgetRisk && budgetRisk > 0 ? (Math.abs(row.riskUsd) / budgetRisk) * 100 : 0,
      status: budgetRisk != null && Math.abs(row.riskUsd) > budgetRisk ? 'over_budget' : 'ok',
    };
  });

  const strategyAllocations = summarizeBy(rows, 'strategy').map((row) => {
    const budgetPct = resolveBudgetPct(strategyBudgets, row.key, null);
    const budgetRisk = budgetPct == null ? null : riskBudgetUsd(equity, budgetPct);
    const available = budgetRisk == null ? null : Math.max(0, budgetRisk - Math.abs(row.riskUsd));
    return {
      strategy: row.key,
      riskUsd: row.riskUsd,
      notionalUsd: row.notionalUsd,
      count: row.count,
      budgetPct,
      budgetRiskUsd: budgetRisk,
      availableRiskUsd: available,
      utilizationPct: budgetRisk && budgetRisk > 0 ? (Math.abs(row.riskUsd) / budgetRisk) * 100 : 0,
      status: budgetRisk != null && Math.abs(row.riskUsd) > budgetRisk ? 'over_budget' : 'ok',
    };
  });

  let proposed = null;
  if (proposedTrade) {
    const row = normalizeExposureRow(proposedTrade);
    const proposedRiskUsd = Math.abs(row.riskUsd);
    const reasons = [];
    let allowedRiskUsd = availableRiskUsd;

    if (proposedRiskUsd <= 0) {
      reasons.push('proposed_risk_required');
      allowedRiskUsd = 0;
    }

    if (usedRiskUsd + proposedRiskUsd > maxRiskUsd) {
      reasons.push('portfolio_heat_budget_exceeded');
    }

    const profileUsedUsd = rows
      .filter((item) => item.botProfile === row.botProfile)
      .reduce((sum, item) => sum + Math.abs(item.riskUsd), 0);
    const profileBudgetPct = resolveBudgetPct(profileBudgets, row.botProfile, null);
    const profileBudgetRiskUsd = profileBudgetPct == null ? null : riskBudgetUsd(equity, profileBudgetPct);
    const profileAvailableRiskUsd = profileBudgetRiskUsd == null ? null : Math.max(0, profileBudgetRiskUsd - profileUsedUsd);
    if (profileBudgetRiskUsd != null) {
      allowedRiskUsd = Math.min(allowedRiskUsd, profileAvailableRiskUsd);
      if (profileUsedUsd + proposedRiskUsd > profileBudgetRiskUsd) reasons.push('profile_budget_exceeded');
    }

    const strategyUsedUsd = rows
      .filter((item) => item.strategy === row.strategy)
      .reduce((sum, item) => sum + Math.abs(item.riskUsd), 0);
    const strategyBudgetPct = resolveBudgetPct(strategyBudgets, row.strategy, null);
    const strategyBudgetRiskUsd = strategyBudgetPct == null ? null : riskBudgetUsd(equity, strategyBudgetPct);
    const strategyAvailableRiskUsd = strategyBudgetRiskUsd == null ? null : Math.max(0, strategyBudgetRiskUsd - strategyUsedUsd);
    if (strategyBudgetRiskUsd != null) {
      allowedRiskUsd = Math.min(allowedRiskUsd, strategyAvailableRiskUsd);
      if (strategyUsedUsd + proposedRiskUsd > strategyBudgetRiskUsd) reasons.push('strategy_budget_exceeded');
    }

    const maxPairCorrelation = rows.reduce(
      (maxValue, item) => Math.max(maxValue, findPairCorrelation(correlationPairs, row.correlationKey, item.correlationKey)),
      0,
    );
    if (maxPairCorrelation > Math.abs(numberOr(maxCorrelation, 1))) reasons.push('correlation_cap_pressure');

    const riskMultiplier = proposedRiskUsd > 0
      ? Math.max(0, Math.min(1, allowedRiskUsd / proposedRiskUsd))
      : 0;
    if (proposedRiskUsd > 0 && riskMultiplier < 1) reasons.push('risk_reduction_required');

    proposed = {
      ...row,
      proposedRiskUsd,
      afterRiskUsd: usedRiskUsd + proposedRiskUsd,
      afterHeatPct: equity > 0 ? ((usedRiskUsd + proposedRiskUsd) / equity) * 100 : 0,
      availableRiskUsd,
      profileUsedRiskUsd: profileUsedUsd,
      profileAvailableRiskUsd,
      strategyUsedRiskUsd: strategyUsedUsd,
      strategyAvailableRiskUsd,
      maxPairCorrelation,
      riskMultiplier,
      recommendedRiskUsd: proposedRiskUsd * riskMultiplier,
      allow: reasons.length === 0,
      reasons,
    };
  }

  return {
    equityUsd: equity,
    targetHeatPct: targetPct,
    maxHeatPct: maxPct,
    targetRiskUsd,
    maxRiskUsd,
    usedRiskUsd,
    currentHeatPct,
    availableRiskUsd,
    targetAvailableRiskUsd,
    openPositionCount: rows.length,
    profileAllocations,
    strategyAllocations,
    proposedTrade: proposed,
  };
}

module.exports = {
  buildPortfolioAllocationPlan,
  normalizeExposureRow,
  summarizePortfolioRisk,
};
