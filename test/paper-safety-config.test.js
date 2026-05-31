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

test('self-evolution apply and promotion gates require explicit true', () => {
  const configPath = require.resolve('../config');
  const previous = {
    BOT_PROFILE: process.env.BOT_PROFILE,
    PAPER_TRADING: process.env.PAPER_TRADING,
    SELF_EVOLUTION_AUTO_APPLY: process.env.SELF_EVOLUTION_AUTO_APPLY,
    SELF_EVOLUTION_ALLOW_LIVE_APPLY: process.env.SELF_EVOLUTION_ALLOW_LIVE_APPLY,
    SELF_EVOLUTION_AUTO_PROMOTE: process.env.SELF_EVOLUTION_AUTO_PROMOTE,
  };
  const restore = () => {
    delete require.cache[configPath];
    Object.entries(previous).forEach(([key, value]) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    });
  };

  try {
    process.env.BOT_PROFILE = 'paper';
    process.env.PAPER_TRADING = 'true';
    process.env.SELF_EVOLUTION_AUTO_APPLY = '';
    process.env.SELF_EVOLUTION_ALLOW_LIVE_APPLY = '';
    process.env.SELF_EVOLUTION_AUTO_PROMOTE = '';
    delete require.cache[configPath];
    let config = require('../config');
    assert.equal(config.selfEvolution.autoApply, false);
    assert.equal(config.selfEvolution.allowLiveApply, false);
    assert.equal(config.selfEvolution.autoPromote, false);

    process.env.SELF_EVOLUTION_AUTO_APPLY = 'true';
    process.env.SELF_EVOLUTION_ALLOW_LIVE_APPLY = 'true';
    process.env.SELF_EVOLUTION_AUTO_PROMOTE = 'true';
    delete require.cache[configPath];
    config = require('../config');
    assert.equal(config.selfEvolution.autoApply, true);
    assert.equal(config.selfEvolution.allowLiveApply, true);
    assert.equal(config.selfEvolution.autoPromote, true);
  } finally {
    restore();
  }
});
