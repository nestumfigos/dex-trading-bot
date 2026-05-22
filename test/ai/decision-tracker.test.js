'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { trackAi, estimateCost, classifyError, TOKEN_COST_PER_1K } = require('../../src/ai/decision-tracker');

// ─── classifyError ─────────────────────────────────────────────────────────

test('classifyError: timeout patterns → TIMEOUT', () => {
  assert.equal(classifyError(new Error('ETIMEDOUT')), 'TIMEOUT');
  assert.equal(classifyError(new Error('Request timed out after 15000ms')), 'TIMEOUT');
});

test('classifyError: 429 / rate limit → RATE_LIMIT', () => {
  assert.equal(classifyError(new Error('Request failed with status code 429')), 'RATE_LIMIT');
  assert.equal(classifyError(new Error('too many requests')), 'RATE_LIMIT');
});

test('classifyError: 401/403 → AUTH', () => {
  assert.equal(classifyError(new Error('401 Unauthorized')), 'AUTH');
  assert.equal(classifyError(new Error('Invalid API key')), 'AUTH');
});

test('classifyError: parse → PARSE', () => {
  assert.equal(classifyError(new Error('Unexpected token in JSON')), 'PARSE');
});

test('classifyError: unknown → UNKNOWN', () => {
  assert.equal(classifyError(new Error('Random error')), 'UNKNOWN');
  assert.equal(classifyError(null), 'UNKNOWN');
});

// ─── estimateCost ──────────────────────────────────────────────────────────

test('estimateCost: anthropic 1k input + 1k output ≈ $0.018', () => {
  const cost = estimateCost('anthropic', 1000, 1000);
  assert.ok(Math.abs(cost - 0.018) < 0.0001, `got ${cost}`);
});

test('estimateCost: groq is much cheaper', () => {
  const groq = estimateCost('groq', 1000, 1000);
  const anth = estimateCost('anthropic', 1000, 1000);
  assert.ok(groq < anth * 0.1, 'groq should be < 10% of anthropic');
});

test('estimateCost: unknown provider → 0', () => {
  assert.equal(estimateCost('does-not-exist', 1000, 1000), 0);
});

test('estimateCost: NaN tokens → 0', () => {
  assert.equal(estimateCost('anthropic', NaN, undefined), 0);
});

// ─── trackAi ──────────────────────────────────────────────────────────────

function makeStubSql() {
  const inserts = [];
  return {
    request() {
      const inputs = {};
      return {
        input(k, v) { inputs[k] = v; return this; },
        async query() { inserts.push({ ...inputs }); return { recordset: [] }; },
      };
    },
    _inserts: inserts,
  };
}

test('trackAi: success path captures latency + signal + cost', async () => {
  const sql = makeStubSql();
  const result = await trackAi(
    { provider: 'anthropic', model: 'claude-3-5-sonnet', purpose: 'trade_signal', symbol: 'KCS', chain: 'kucoin', scope: 'live' },
    async () => {
      await new Promise((r) => setTimeout(r, 10));
      return { signal: 'BUY', confidence: 75, requestTokens: 500, responseTokens: 200, responseExcerpt: '{"signal":"BUY"}' };
    },
    { sql },
  );
  assert.equal(result.signal, 'BUY');
  // persistDecision is fire-and-forget; give it a tick to write
  await new Promise((r) => setImmediate(r));
  assert.equal(sql._inserts.length, 1);
  const row = sql._inserts[0];
  assert.equal(row.provider, 'anthropic');
  assert.equal(row.success, 1);
  assert.equal(row.signal, 'BUY');
  assert.ok(row.latency_ms >= 10);
  assert.ok(row.cost_usd > 0);
});

test('trackAi: failure path records error code + re-throws', async () => {
  const sql = makeStubSql();
  await assert.rejects(
    () => trackAi(
      { provider: 'groq', purpose: 'lesson' },
      async () => { throw new Error('429 Too Many Requests'); },
      { sql },
    ),
    /429/,
  );
  await new Promise((r) => setImmediate(r));
  assert.equal(sql._inserts.length, 1);
  const row = sql._inserts[0];
  assert.equal(row.success, 0);
  assert.equal(row.error_code, 'RATE_LIMIT');
});

test('trackAi: SQL down (no pool) does not throw', async () => {
  const result = await trackAi(
    { provider: 'anthropic' },
    async () => ({ signal: 'HOLD' }),
    { sql: null },
  );
  assert.equal(result.signal, 'HOLD');
});

test('trackAi: caller-provided costUsd overrides estimate', async () => {
  const sql = makeStubSql();
  await trackAi(
    { provider: 'anthropic' },
    async () => ({ signal: 'BUY', requestTokens: 1000, responseTokens: 1000, costUsd: 99 }),
    { sql },
  );
  await new Promise((r) => setImmediate(r));
  assert.equal(sql._inserts[0].cost_usd, 99);
});

test('TOKEN_COST_PER_1K is frozen', () => {
  assert.throws(() => { TOKEN_COST_PER_1K.foo = {}; }, TypeError);
});
