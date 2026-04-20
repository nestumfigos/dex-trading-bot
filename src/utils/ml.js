// Simple ML utilities for anomaly detection and signal generation (free, in-memory)

/**
 * Z-score anomaly detection for a numeric array
 * Returns true if the latest value is an outlier (z > threshold)
 */
function isZScoreAnomaly(arr, threshold = 2.5) {
  if (!Array.isArray(arr) || arr.length < 10) return false;
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  const std = Math.sqrt(arr.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / arr.length);
  const z = std === 0 ? 0 : (arr[arr.length - 1] - mean) / std;
  return Math.abs(z) > threshold;
}

/**
 * Simple moving average crossover signal
 * Returns 1 for bullish, -1 for bearish, 0 for neutral
 */
function movingAverageSignal(arr, shortPeriod = 5, longPeriod = 20) {
  if (arr.length < longPeriod) return 0;
  const sma = (data, n) => data.slice(-n).reduce((a, b) => a + b, 0) / n;
  const shortMA = sma(arr, shortPeriod);
  const longMA = sma(arr, longPeriod);
  if (shortMA > longMA) return 1;
  if (shortMA < longMA) return -1;
  return 0;
}

module.exports = { isZScoreAnomaly, movingAverageSignal };