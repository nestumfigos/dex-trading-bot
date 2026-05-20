'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const AgentMemory = require('../src/agent/agentMemory');

function makeMemory(config) {
  const memory = new AgentMemory({
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    config,
  });
  memory.saveIfDirty = async () => {};
  return memory;
}

function samplePosition() {
  return {
    symbol: 'TEST',
    chain: 'kucoin',
    strategy: 'momentum',
    entryPrice: 1,
    lastPrice: 0.96,
    openedAt: new Date(Date.now() - 30 * 60_000).toISOString(),
    entryRsi: 58,
    entryVolumeSpike: 1.4,
    entryLiquidityUsd: 250000,
    exitClassification: 'stop_loss',
  };
}

test('paper agent memory does not spend AI even when a Groq key exists', async (t) => {
  const originalPost = axios.post;
  const originalEnv = {
    GROQ_API_KEY: process.env.GROQ_API_KEY,
    GROQ_ENABLED: process.env.GROQ_ENABLED,
    PAPER_TRADING: process.env.PAPER_TRADING,
    BOT_PROFILE: process.env.BOT_PROFILE,
  };
  process.env.GROQ_API_KEY = 'test-key';
  process.env.GROQ_ENABLED = 'true';
  process.env.PAPER_TRADING = 'true';
  process.env.BOT_PROFILE = 'paper';
  axios.post = async () => {
    throw new Error('unexpected_ai_call');
  };
  t.after(() => {
    axios.post = originalPost;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const memory = makeMemory({
    paperTrading: true,
    groq: { enabled: true, apiKey: 'test-key' },
    agentMemory: {
      paperAiEnabled: false,
      aiLessonsEnabled: true,
      dailyAiLessonLimit: 8,
      aiLessonMinAbsPnlUsd: 0,
      aiLessonMinAbsPnlPct: 0,
    },
  });

  const lesson = await memory.generateLessonWithAI(samplePosition(), -10);
  assert.match(lesson, /Avoid TEST/);
  assert.equal(Number(memory.data.aiUsage.lessonCalls || 0), 0);
});

test('live agent memory respects daily AI lesson budget', async (t) => {
  const originalPost = axios.post;
  const originalEnv = {
    GROQ_API_KEY: process.env.GROQ_API_KEY,
    GROQ_ENABLED: process.env.GROQ_ENABLED,
    PAPER_TRADING: process.env.PAPER_TRADING,
    BOT_PROFILE: process.env.BOT_PROFILE,
  };
  process.env.GROQ_API_KEY = 'test-key';
  process.env.GROQ_ENABLED = 'true';
  process.env.PAPER_TRADING = 'false';
  process.env.BOT_PROFILE = 'live';
  let calls = 0;
  axios.post = async () => {
    calls += 1;
    return {
      data: {
        choices: [{
          message: {
            content: '{"lesson":"AI lesson used once","avoidPattern":"weak setup","confidence":90}',
          },
        }],
      },
    };
  };
  t.after(() => {
    axios.post = originalPost;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const memory = makeMemory({
    paperTrading: false,
    groq: { enabled: true, apiKey: 'test-key' },
    agentMemory: {
      paperAiEnabled: false,
      aiLessonsEnabled: true,
      dailyAiLessonLimit: 1,
      aiLessonMinAbsPnlUsd: 0,
      aiLessonMinAbsPnlPct: 0,
    },
  });

  const first = await memory.generateLessonWithAI(samplePosition(), -10);
  const second = await memory.generateLessonWithAI(samplePosition(), -9);
  assert.equal(first, 'AI lesson used once');
  assert.match(second, /Avoid TEST/);
  assert.equal(calls, 1);
  assert.equal(Number(memory.data.aiUsage.lessonCalls || 0), 1);
});
