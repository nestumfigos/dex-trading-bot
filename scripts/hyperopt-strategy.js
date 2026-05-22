'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { runHyperopt, buildBaseBacktestOptions } = require('../src/utils/research');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(path.resolve(filePath), 'utf8'));
}

async function main() {
  const inputPath = process.argv[2];
  if (!inputPath) {
    throw new Error('Usage: node scripts/hyperopt-strategy.js <input.json>');
  }

  const payload = readJson(inputPath);
  const result = runHyperopt({
    priceHistory: payload.priceHistory,
    volumeHistory: payload.volumeHistory,
    strategyName: payload.strategy || 'momentum',
    mode: payload.mode || 'walk_forward',
    paramGrid: payload.paramGrid || {},
    maxCandidates: payload.maxCandidates || 30,
    baseOptions: {
      ...buildBaseBacktestOptions(payload),
      trainPct: payload.trainPct,
      validatePct: payload.validatePct,
      regimeWindowBars: payload.regimeWindowBars,
    },
  });

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
