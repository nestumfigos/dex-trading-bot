'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const config = require('../config');
const logger = require('../src/utils/logger');
const { ModelRegistry } = require('../src/utils/model-registry');
const {
  buildFeatureSeriesFromHistories,
  trainActorCriticPolicy,
  trainPpoPolicy,
  trainQPolicy,
} = require('../src/utils/rl-policy');

async function main() {
  const dataDir = path.resolve(process.cwd(), process.env.BOT_DATA_DIR || 'data');
  const statePath = path.join(dataDir, 'state.json');
  const raw = fs.readFileSync(statePath, 'utf8');
  const state = JSON.parse(raw);
  const priceHistory = state?.strategyState?.priceHistory || {};
  const volumeHistory = state?.strategyState?.volumeHistory || {};
  const featureSeries = buildFeatureSeriesFromHistories(
    priceHistory,
    volumeHistory,
    Number(config.rl?.trainingSeriesLimit || 12)
  );

  if (featureSeries.length < 100) {
    throw new Error(`Not enough RL feature rows: ${featureSeries.length}`);
  }

  const algorithm = String(process.env.RL_NATIVE_ALGORITHM || config.rl?.nativeAlgorithm || 'q_learning').trim().toLowerCase();
  const policy = algorithm === 'ppo'
    ? trainPpoPolicy(featureSeries, {
      episodes: Number(config.rl?.trainingEpisodes || 24),
      clipRatio: Number(config.rl?.ppoClipRatio || 0.2),
    })
    : algorithm === 'actor_critic'
      ? trainActorCriticPolicy(featureSeries, {
        episodes: Number(config.rl?.trainingEpisodes || 24),
      })
      : trainQPolicy(featureSeries, {
        episodes: Number(config.rl?.trainingEpisodes || 24),
      });

  const registry = new ModelRegistry({
    logger,
    botProfile: String(process.env.BOT_PROFILE || (process.env.PAPER_TRADING === 'true' ? 'paper' : 'live')).toLowerCase(),
  });
  const policyId = await registry.upsertRlPolicy({
    policyName: config.paperTrading ? 'paper_rl_default' : 'live_rl_default',
    botProfile: config.paperTrading ? 'paper' : 'live',
    stage: config.paperTrading ? 'paper_training' : 'live_candidate',
    status: 'active',
    policy,
    metrics: {
      featureRows: featureSeries.length,
      stateCount: policy.stateCount,
      episodes: policy.episodes,
      algorithm: policy.algorithm || algorithm,
      ...(policy.metrics || {}),
    },
  });

  logger.info(`[RL] policy trained and stored: ${policyId} | rows=${featureSeries.length} states=${policy.stateCount}`);
}

main().catch((error) => {
  logger.error(`[RL] training failed: ${error.message}`);
  process.exit(1);
});
