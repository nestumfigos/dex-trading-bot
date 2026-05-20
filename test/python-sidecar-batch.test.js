const test = require('node:test');
const assert = require('node:assert/strict');

const { runPythonSidecarBatch } = require('../src/utils/python-sidecar');

test('python sidecar exposes batch inference to avoid one process per validation row', async () => {
  const result = await runPythonSidecarBatch('infer_model', [
    { features: { priceChange24hPct: 3, return3Pct: 1, volumeSpike: 2, buyRatioRecentPct: 65 } },
    { features: { priceChange24hPct: -3, return3Pct: -1, volumeSpike: 0.5, buyRatioRecentPct: 35 } },
  ], { metadata: { framework: 'fallback' } }, { debug() {} });

  assert.equal(result.ok, true);
  assert.equal(result.predictions.length, 2);
});
