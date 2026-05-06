const technicalIndicators = require('technicalindicators');

// Calculate a technical indicator using technicalindicators
// Example: calculateIndicator('EMA', { period: 14, values: [..] })
async function calculateIndicator(type, params) {
  try {
    const IndicatorClass = technicalIndicators[type];
    if (!IndicatorClass) {
      throw new Error(`Indicator ${type} not found`);
    }
    const indicator = new IndicatorClass(params);
    return indicator.getResult();
  } catch (error) {
    throw new Error(`Failed to calculate ${type}: ${error.message}`);
  }
}

module.exports = { calculateIndicator };