'use strict';

require('dotenv').config();

const logger = require('../src/utils/logger');
const { runPythonSidecar } = require('../src/utils/python-sidecar');

async function main() {
  const result = await runPythonSidecar('health', {}, logger);
  logger.info(`[PythonSidecar] ${JSON.stringify(result)}`);
}

main().catch((error) => {
  logger.error(`[PythonSidecar] health failed: ${error.message}`);
  process.exit(1);
});
