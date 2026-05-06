'use strict';

require('dotenv').config();

const logger = console;
const { runSelfTest, getSqlStatus } = require('../src/utils/sqlServer');

(async () => {
  process.env.SQL_ENABLED = 'true';
  const result = await runSelfTest(logger);
  const status = getSqlStatus();

  if (!result.ok) {
    logger.error('[SQL] Bootstrap/self-test failed', status);
    process.exit(1);
  }

  logger.log('[SQL] Bootstrap/self-test passed', status);
  process.exit(0);
})().catch((error) => {
  logger.error('[SQL] Bootstrap script crashed', error);
  process.exit(1);
});
