'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const logger = require('../src/utils/logger');
const { runPythonSidecar } = require('../src/utils/python-sidecar');
const { resolveArtifactPath } = require('../src/utils/model-registry');
const {
  FEATURE_ORDER,
  FEATURE_SCHEMA_VERSION,
  getFeatureSchemaHash,
} = require('../src/utils/feature-schema');

const DEFAULT_FRAMEWORKS = [
  'sklearn_random_forest',
  'xgboost',
  'lightgbm',
  'catboost',
  'torch_lstm',
  'torch_gru',
];

function accuracy(rows = []) {
  if (!rows.length) return 0;
  return rows.filter((row) => row.correct).length / rows.length;
}

function precision(rows = []) {
  const predictedBuys = rows.filter((row) => row.predicted === 1);
  if (!predictedBuys.length) return 0;
  return predictedBuys.filter((row) => row.actual === 1).length / predictedBuys.length;
}

function avgFutureReturnOnBuys(rows = []) {
  const predictedBuys = rows.filter((row) => row.predicted === 1);
  if (!predictedBuys.length) return 0;
  return predictedBuys.reduce((sum, row) => sum + Number(row.futureReturnPct || 0), 0) / predictedBuys.length;
}

function splitWalkForward(rows = [], folds = 3, trainPct = 0.65) {
  const sorted = [...rows].sort((a, b) => new Date(a.ts || 0) - new Date(b.ts || 0));
  const foldSize = Math.floor(sorted.length / folds);
  const windows = [];
  for (let i = 0; i < folds; i += 1) {
    const end = i === folds - 1 ? sorted.length : (i + 1) * foldSize;
    const window = sorted.slice(0, end);
    const trainEnd = Math.floor(window.length * trainPct);
    const trainRows = window.slice(0, trainEnd);
    const testRows = window.slice(trainEnd);
    if (trainRows.length && testRows.length) {
      // Day 5 ML correctness assertion: no test sample timestamp may be earlier than the
      // last train sample timestamp. Forward-bias contamination would silently inflate metrics.
      const maxTrainTs = trainRows.reduce((max, r) => {
        const t = new Date(r.ts || 0).getTime();
        return t > max ? t : max;
      }, 0);
      const earliestTestTs = testRows.reduce((min, r) => {
        const t = new Date(r.ts || 0).getTime();
        return t < min ? t : min;
      }, Infinity);
      if (Number.isFinite(maxTrainTs) && Number.isFinite(earliestTestTs) && earliestTestTs < maxTrainTs) {
        throw new Error(`[ml-leaderboard] FORWARD-BIAS DETECTED in fold ${i + 1}: earliest test ts ${new Date(earliestTestTs).toISOString()} < last train ts ${new Date(maxTrainTs).toISOString()}`);
      }
      windows.push({ fold: i + 1, trainRows, testRows });
    }
  }
  return windows;
}

async function inferRows({ framework, artifactPath, featureOrder, rows }) {
  const maxRows = Math.max(50, Number(process.env.ML_LEADERBOARD_MAX_TEST_ROWS || 600));
  const sampledRows = rows.length > maxRows
    ? rows.filter((_, index) => index % Math.ceil(rows.length / maxRows) === 0).slice(0, maxRows)
    : rows;
  const result = await runPythonSidecar('infer_model_batch', {
    framework,
    artifactPath,
    metadata: { framework, artifactPath, featureOrder },
    rows: sampledRows.map((row) => ({ features: row.features })),
  }, logger).catch((error) => ({ ok: false, error: error.message }));
  if (!result?.ok) return [];
  return (result.predictions || []).map((prediction, index) => {
    const row = sampledRows[index];
    const score = Number(prediction.score || 0.5);
    const actual = Number(row?.label) ? 1 : 0;
    const predicted = score >= 0.5 ? 1 : 0;
    return {
      predicted,
      actual,
      correct: predicted === actual,
      score,
      futureReturnPct: Number(row?.futureReturnPct || 0),
    };
  });
}

async function evaluateFramework({ framework, dataset, outDir, folds }) {
  const featureOrder = dataset.featureOrder || [];
  const windows = splitWalkForward(dataset.rows || [], folds);
  const foldResults = [];
  for (const window of windows) {
    const artifactPath = resolveArtifactPath(path.join(outDir, `${framework}-fold-${window.fold}.model`).replace(/\\/g, '/'));
    const trained = await runPythonSidecar('train_model', {
      framework,
      artifactPath,
      rows: window.trainRows,
      featureOrder,
    }, logger).catch((error) => ({ ok: false, error: error.message }));
    if (!trained?.ok) {
      foldResults.push({ fold: window.fold, skipped: true, error: trained?.error || 'training_failed' });
      continue;
    }
    const preds = await inferRows({ framework, artifactPath, featureOrder, rows: window.testRows });
    foldResults.push({
      fold: window.fold,
      trainedRows: window.trainRows.length,
      testRows: window.testRows.length,
      predictions: preds.length,
      sampledTestRows: preds.length,
      accuracy: accuracy(preds),
      precision: precision(preds),
      avgFutureReturnOnBuys: avgFutureReturnOnBuys(preds),
      artifactPath,
    });
  }
  const valid = foldResults.filter((fold) => !fold.skipped && fold.predictions > 0);
  return {
    framework,
    folds: foldResults,
    avgAccuracy: valid.length ? valid.reduce((sum, fold) => sum + fold.accuracy, 0) / valid.length : 0,
    avgPrecision: valid.length ? valid.reduce((sum, fold) => sum + Number(fold.precision || 0), 0) / valid.length : 0,
    avgFutureReturnOnBuys: valid.length ? valid.reduce((sum, fold) => sum + Number(fold.avgFutureReturnOnBuys || 0), 0) / valid.length : 0,
    completedFolds: valid.length,
  };
}

async function main() {
  const datasetPath = path.resolve(process.cwd(), process.argv[2] || 'artifacts/models/ml_dataset.json');
  const outPath = path.resolve(process.cwd(), process.argv[3] || 'artifacts/models/ml_leaderboard.json');
  const frameworks = (process.argv[4] ? process.argv[4].split(',') : DEFAULT_FRAMEWORKS).map((s) => s.trim()).filter(Boolean);
  const folds = Math.max(2, Math.min(8, Number(process.env.ML_WALK_FORWARD_FOLDS || 3)));
  const dataset = JSON.parse(fs.readFileSync(datasetPath, 'utf8'));
  const expectedHash = getFeatureSchemaHash(FEATURE_ORDER, FEATURE_SCHEMA_VERSION);
  const datasetHash = String(dataset.featureSchemaHash || dataset.metadata?.featureSchemaHash || '');
  if (datasetHash && datasetHash !== expectedHash) {
    throw new Error(`Leaderboard dataset feature schema mismatch: dataset=${datasetHash} runtime=${expectedHash}`);
  }
  const outDir = path.dirname(outPath);
  fs.mkdirSync(outDir, { recursive: true });
  const results = [];
  for (const framework of frameworks) {
    results.push(await evaluateFramework({ framework, dataset, outDir, folds }));
  }
  const leaderboard = {
    generatedAt: new Date().toISOString(),
    dataset: dataset.metadata || {},
    featureOrder: dataset.featureOrder || FEATURE_ORDER,
    featureSchemaVersion: FEATURE_SCHEMA_VERSION,
    featureSchemaHash: expectedHash,
    results: results.sort((a, b) => {
      const left = (b.avgFutureReturnOnBuys * 0.55) + (b.avgPrecision * 0.25) + (b.avgAccuracy * 0.20);
      const right = (a.avgFutureReturnOnBuys * 0.55) + (a.avgPrecision * 0.25) + (a.avgAccuracy * 0.20);
      return left - right;
    }),
  };
  fs.writeFileSync(outPath, JSON.stringify(leaderboard, null, 2));
  console.log(JSON.stringify({ outPath, winner: leaderboard.results[0]?.framework || null, results: leaderboard.results.length }));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
