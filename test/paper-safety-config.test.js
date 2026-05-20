const test = require('node:test');
const assert = require('node:assert/strict');

test('BOT_PROFILE=paper forces paper trading even when PAPER_TRADING is missing', () => {
  const configPath = require.resolve('../config');
  const previousProfile = process.env.BOT_PROFILE;
  const previousPaper = process.env.PAPER_TRADING;
  delete require.cache[configPath];
  process.env.BOT_PROFILE = 'paper';
  delete process.env.PAPER_TRADING;

  const config = require('../config');
  assert.equal(config.paperTrading, true);

  delete require.cache[configPath];
  if (previousProfile === undefined) delete process.env.BOT_PROFILE;
  else process.env.BOT_PROFILE = previousProfile;
  if (previousPaper === undefined) delete process.env.PAPER_TRADING;
  else process.env.PAPER_TRADING = previousPaper;
});
