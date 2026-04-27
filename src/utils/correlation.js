// Portfolio correlation matrix utility

/**
 * Calculate log returns for a price array
 */
function calcReturns(prices) {
  if (!Array.isArray(prices) || prices.length < 2) return [];
  const returns = [];
  for (let i = 1; i < prices.length; i++) {
    const prev = Number(prices[i - 1]);
    const next = Number(prices[i]);
    if (!Number.isFinite(prev) || !Number.isFinite(next) || prev <= 0 || next <= 0) {
      continue;
    }
    returns.push(Math.log(next / prev));
  }
  return returns;
}

/**
 * Calculate Pearson correlation between two arrays
 */
function pearson(a, b) {
  if (a.length !== b.length || a.length < 2) return 0;
  const meanA = a.reduce((x, y) => x + y, 0) / a.length;
  const meanB = b.reduce((x, y) => x + y, 0) / b.length;
  let num = 0, denA = 0, denB = 0;
  for (let i = 0; i < a.length; i++) {
    const da = a[i] - meanA;
    const db = b[i] - meanB;
    num += da * db;
    denA += da * da;
    denB += db * db;
  }
  return denA && denB ? num / Math.sqrt(denA * denB) : 0;
}

/**
 * Build correlation matrix for a map of token price histories
 * @param {Object} priceHistories { token: [prices] }
 * @returns {Object} { tokens: [...], matrix: [[corr]] }
 */
function buildCorrelationMatrix(priceHistories) {
  const tokens = Object.keys(priceHistories);
  const returns = tokens.map((t) => calcReturns(priceHistories[t]));
  const matrix = tokens.map((_, i) =>
    tokens.map((_, j) => pearson(returns[i], returns[j]))
  );
  return { tokens, matrix };
}

module.exports = { buildCorrelationMatrix };