'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { mountWeek6Routes, requireAdmin, _internals } = require('../../src/dashboard-extensions');

// ─── Auth gate ────────────────────────────────────────────────────────────

test('requireAdmin: missing DASHBOARD_ADMIN_TOKEN → 503', () => {
  delete process.env.DASHBOARD_ADMIN_TOKEN;
  let status; let body;
  const res = { status(s) { status = s; return this; }, json(b) { body = b; return this; } };
  requireAdmin({ headers: {} }, res, () => { throw new Error('next called unexpectedly'); });
  assert.equal(status, 503);
  assert.match(body.error, /DASHBOARD_ADMIN_TOKEN/);
});

test('requireAdmin: wrong token → 401', () => {
  process.env.DASHBOARD_ADMIN_TOKEN = 'secret123';
  let status; let body;
  const res = { status(s) { status = s; return this; }, json(b) { body = b; return this; } };
  requireAdmin({ headers: { authorization: 'Bearer wrong' } }, res, () => { throw new Error('next called'); });
  assert.equal(status, 401);
  assert.match(body.error, /unauthorized/);
  delete process.env.DASHBOARD_ADMIN_TOKEN;
});

test('requireAdmin: correct token → next() called', () => {
  process.env.DASHBOARD_ADMIN_TOKEN = 'secret123';
  let called = false;
  requireAdmin({ headers: { authorization: 'Bearer secret123' } }, {}, () => { called = true; });
  assert.equal(called, true);
  delete process.env.DASHBOARD_ADMIN_TOKEN;
});

// ─── parseLimit / clampHours ───────────────────────────────────────────────

test('parseLimit: missing → default', () => {
  assert.equal(_internals.parseLimit({ query: {} }, 50), 50);
});

test('parseLimit: caps at max', () => {
  assert.equal(_internals.parseLimit({ query: { limit: '999' } }, 50, 100), 100);
});

test('parseLimit: NaN → default', () => {
  assert.equal(_internals.parseLimit({ query: { limit: 'abc' } }, 50), 50);
});

test('clampHours: caps at max', () => {
  assert.equal(_internals.clampHours({ query: { hours: '500' } }, 24, 168), 168);
});

test('clampHours: missing → default', () => {
  assert.equal(_internals.clampHours({ query: {} }, 24), 24);
});

// ─── mountWeek6Routes ─────────────────────────────────────────────────────

function makeFakeApp() {
  const routes = [];
  const stub = (method) => (path, ...handlers) => routes.push({ method, path, handlers });
  return {
    get: stub('GET'), post: stub('POST'), delete: stub('DELETE'), patch: stub('PATCH'),
    _routes: routes,
  };
}

test('mountWeek6Routes: registers all endpoints (GET + POST + DELETE + PATCH)', () => {
  const app = makeFakeApp();
  const result = mountWeek6Routes(app, { getPool: async () => null, logger: { info() {}, warn() {} } });
  const gets    = app._routes.filter((r) => r.method === 'GET').length;
  const posts   = app._routes.filter((r) => r.method === 'POST').length;
  const deletes = app._routes.filter((r) => r.method === 'DELETE').length;
  const patches = app._routes.filter((r) => r.method === 'PATCH').length;
  assert.equal(gets, 10, 'expected 10 GET endpoints (incl /api/risk-rules, /api/health-canary/sparklines)');
  assert.equal(posts, 1, 'expected 1 POST endpoint');
  assert.equal(deletes, 1, 'expected 1 DELETE endpoint');
  assert.equal(patches, 1, 'expected 1 PATCH endpoint');
  assert.equal(result.endpoints.length, 13);
});

test('mountWeek6Routes: throws on non-Express app', () => {
  assert.throws(() => mountWeek6Routes({}, { getPool: async () => null }), /Express-compatible/);
});

test('mountWeek6Routes: POST + DELETE include requireAdmin in handler chain', () => {
  const app = makeFakeApp();
  mountWeek6Routes(app, { getPool: async () => null });
  const postOverride = app._routes.find((r) => r.method === 'POST' && r.path === '/api/symbol-overrides');
  assert.ok(postOverride, 'POST /api/symbol-overrides should be registered');
  assert.equal(postOverride.handlers.length, 2, 'POST should have 2 handlers (auth + body)');
  assert.equal(postOverride.handlers[0], requireAdmin, 'first handler must be requireAdmin');

  const del = app._routes.find((r) => r.method === 'DELETE' && r.path === '/api/symbol-overrides/:id');
  assert.ok(del, 'DELETE /api/symbol-overrides/:id should be registered');
  assert.equal(del.handlers[0], requireAdmin);
});

test('mountWeek6Routes: GET endpoints have single handler (no auth required)', () => {
  const app = makeFakeApp();
  mountWeek6Routes(app, { getPool: async () => null });
  const gets = app._routes.filter((r) => r.method === 'GET');
  for (const g of gets) {
    assert.equal(g.handlers.length, 1, `GET ${g.path} should have 1 handler (no auth)`);
  }
});

// ─── Endpoint behavior with mock pool ─────────────────────────────────────

function makeFakePool(records = []) {
  return {
    request() {
      return {
        input() { return this; },
        async query() { return { recordset: records }; },
      };
    },
  };
}

test('GET /api/rejections returns ok response with mock pool', async () => {
  const app = makeFakeApp();
  const mockPool = makeFakePool([{ id: 1, gate: 'tier_feasibility', symbol: 'KCS' }]);
  mountWeek6Routes(app, { getPool: async () => mockPool });
  const route = app._routes.find((r) => r.method === 'GET' && r.path === '/api/rejections');
  let status = 200; let body;
  const req = { query: {} };
  const res = {
    status(s) { status = s; return this; },
    json(b) { body = b; return this; },
  };
  await route.handlers[0](req, res);
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.count, 1);
  assert.equal(body.data[0].gate, 'tier_feasibility');
});

test('GET /api/ai-decisions/cost aggregates by provider', async () => {
  const app = makeFakeApp();
  const mockPool = makeFakePool([
    { provider: 'anthropic', call_count: 100, total_cost_usd: 5.25, avg_latency_ms: 450, success_count: 95, buy_count: 30, hold_count: 50, sell_count: 15 },
    { provider: 'groq',      call_count: 200, total_cost_usd: 0.10, avg_latency_ms: 120, success_count: 199, buy_count: 60, hold_count: 80, sell_count: 60 },
  ]);
  mountWeek6Routes(app, { getPool: async () => mockPool });
  const route = app._routes.find((r) => r.method === 'GET' && r.path === '/api/ai-decisions/cost');
  let body;
  await route.handlers[0]({ query: {} }, { status() { return this; }, json(b) { body = b; return this; } });
  assert.equal(body.ok, true);
  assert.equal(body.data.length, 2);
  assert.equal(body.data[0].provider, 'anthropic');
  assert.equal(body.data[0].total_cost_usd, 5.25);
});

test('GET /api/risk-rules uses the configured SQL pool provider', async () => {
  const app = makeFakeApp();
  const mockPool = makeFakePool([{ name: 'max_size', scope: 'paper', enabled: true }]);
  mountWeek6Routes(app, { getPool: async () => mockPool });
  const route = app._routes.find((r) => r.method === 'GET' && r.path === '/api/risk-rules');
  let body;
  await route.handlers[0]({ query: {} }, { status() { return this; }, json(b) { body = b; return this; } });
  assert.equal(body.ok, true);
  assert.equal(body.data[0].name, 'max_size');
});

test('GET /api/health-canary degrades cleanly when SQL is unavailable', async () => {
  const app = makeFakeApp();
  mountWeek6Routes(app, { getPool: async () => null });
  const route = app._routes.find((r) => r.method === 'GET' && r.path === '/api/health-canary');
  let status = 200; let body;
  await route.handlers[0](
    { query: {} },
    { status(s) { status = s; return this; }, json(b) { body = b; return this; } },
  );
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.sqlUnavailable, true);
  assert.deepEqual(body.data, []);
});

test('POST /api/symbol-overrides without auth → 503', async () => {
  delete process.env.DASHBOARD_ADMIN_TOKEN;
  const app = makeFakeApp();
  mountWeek6Routes(app, { getPool: async () => makeFakePool() });
  const route = app._routes.find((r) => r.method === 'POST' && r.path === '/api/symbol-overrides');
  let status; let body;
  const res = { status(s) { status = s; return this; }, json(b) { body = b; return this; } };
  route.handlers[0]({ headers: {}, body: {} }, res, () => { throw new Error('next called'); });
  assert.equal(status, 503);
});

test('POST /api/symbol-overrides with auth + missing fields → 400', async () => {
  process.env.DASHBOARD_ADMIN_TOKEN = 'sek';
  const app = makeFakeApp();
  mountWeek6Routes(app, { getPool: async () => makeFakePool() });
  const route = app._routes.find((r) => r.method === 'POST' && r.path === '/api/symbol-overrides');
  // auth handler passes through
  let nextCalled = false;
  route.handlers[0]({ headers: { authorization: 'Bearer sek' } }, {}, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  // body handler with missing fields
  let status; let body;
  await route.handlers[1](
    { body: {} },
    { status(s) { status = s; return this; }, json(b) { body = b; return this; } },
  );
  assert.equal(status, 400);
  assert.match(body.error, /symbol.*chain.*action/);
  delete process.env.DASHBOARD_ADMIN_TOKEN;
});
