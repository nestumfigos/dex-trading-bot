'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const logger = require('../src/utils/logger');
const { runPythonSidecar } = require('../src/utils/python-sidecar');
const { ModelRegistry, resolveArtifactPath } = require('../src/utils/model-registry');

async function main() {
  const engine = String(process.argv[2] || process.env.RL_PRODUCTION_POLICY_ENGINE || 'sb3').trim().toLowerCase();
  const datasetPath = path.resolve(process.cwd(), process.argv[3] || 'artifacts/models/ml_dataset.json');
  const artifactPath = resolveArtifactPath(
    engine === 'rllib'
      ? 'artifacts/rl/rllib_policy_production-v1'
      : 'artifacts/rl/sb3_policy_production-v1'
  );
  if (!fs.existsSync(datasetPath)) {
    throw new Error(`RL dataset not found: ${datasetPath}`);
  }
  const dataset = JSON.parse(fs.readFileSync(datasetPath, 'utf8'));
  const result = await runPythonSidecar('train_rl', {
    engine,
    algorithm: engine === 'rllib' ? (process.env.RL_RLLIB_ALGORITHM || 'PPO') : (process.env.RL_SB3_ALGORITHM || 'PPO'),
    artifactPath,
    featureOrder: dataset.featureOrder || [],
    rows: dataset.rows || [],
    episodes: Number(process.env.RL_PRODUCTION_TRAINING_EPISODES || 2000),
  }, logger);
  const registry = new ModelRegistry({
    logger,
    botProfile: String(process.env.BOT_PROFILE || (process.env.PAPER_TRADING === 'true' ? 'paper' : 'live')).toLowerCase(),
  });
  await registry.ensureReady();
  await registry.upsertRlPolicy({
    policyName: engine === 'rllib' ? 'rllib_production_default' : 'sb3_production_default',
    stage: 'production',
    status: 'active',
    policy: {
      framework: engine,
      engine,
      artifactPath: result.artifactPath || artifactPath,
      featureOrder: dataset.featureOrder || [],
      algorithm: engine === 'rllib' ? (process.env.RL_RLLIB_ALGORITHM || 'PPO') : (process.env.RL_SB3_ALGORITHM || 'PPO'),
    },
    metrics: {
      ...(result.metrics || {}),
      artifactPath: result.artifactPath || artifactPath,
      featureOrder: dataset.featureOrder || [],
      framework: engine,
      trainedRows: Number(result.trainedRows || (dataset.rows || []).length || 0),
    },
  });
  logger.info(`[ProductionRL] ${engine} trainer result: ${JSON.stringify(result)}`);
}

main().catch((error) => {
  logger.error(`[ProductionRL] training failed: ${error.message}`);
  process.exit(1);
});
