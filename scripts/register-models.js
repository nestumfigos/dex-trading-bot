'use strict';

require('dotenv').config();

const logger = require('../src/utils/logger');
const { ModelRegistry } = require('../src/utils/model-registry');

async function main() {
  const registry = new ModelRegistry({
    logger,
    botProfile: String(process.env.BOT_PROFILE || (process.env.PAPER_TRADING === 'true' ? 'paper' : 'live')).toLowerCase(),
  });
  await registry.ensureReady();
  logger.info('[ModelRegistry] default models ensured');
}

main().catch((error) => {
  logger.error(`[ModelRegistry] ensure failed: ${error.message}`);
  process.exit(1);
});
