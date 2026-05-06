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
  await registry.ensureExternalModelRegistryEntries();
  logger.info('[ModelRegistry] production artifact-backed model entries ensured');
}

main().catch((error) => {
  logger.error(`[ModelRegistry] production ensure failed: ${error.message}`);
  process.exit(1);
});
