'use strict';

/**
 * Week 6 Dashboard Extensions.
 *
 * New API endpoints reading from the Week 3/4/5 tables. Mounted into the main
 * dashboard via `mountWeek6Routes(app, deps)`.
 *
 *   GET    /api/rejections                — trade_rejections query
 *   GET    /api/evolution-history         — evolution_history query
 *   GET    /api/ai-decisions              — ai_decisions paginated
 *   GET    /api/ai-decisions/cost         — provider cost rollup (last 24h)
 *   GET    /api/symbol-overrides          — current overrides
 *   POST   /api/symbol-overrides          — upsert (auth required)
 *   DELETE /api/symbol-overrides/:id      — soft delete (auth required)
 *   GET    /api/health-canary             — recent health_checks
 *   GET    /api/ml-models                 — ml_model_versions
 *   GET    /api/backtest-runs             — recent backtest_runs
 *
 * All read endpoints return JSON {ok, data, count, error?}.
 * All write endpoints require Bearer token matching DASHBOARD_ADMIN_TOKEN.
 */

// W16.4: parse the leading number from a free-form value_observed string
// (e.g. "70.4 USD", "1.2s", "85%"). Returns NaN when not numeric.
function parseFirstNumber(s) {
  if (s === null || s === undefined) return NaN;
  const m = String(s).match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : NaN;
}

function sigmaStats(values) {
  const vs = (Array.isArray(values) ? values : []).filter(Number.isFinite);
  if (vs.length < 5) return null;
  const mean = vs.reduce((a, b) => a + b, 0) / vs.length;
  const variance = vs.reduce((a, b) => a + (b - mean) ** 2, 0) / vs.length;
  const stdev = Math.sqrt(variance);
  return { count: vs.length, mean: Number(mean.toFixed(4)), stdev: Number(stdev.toFixed(4)) };
}

function requireAdmin(req, res, next) {
  const expected = process.env.DASHBOARD_ADMIN_TOKEN;
  if (!expected) {
    return res.status(503).json({ ok: false, error: 'DASHBOARD_ADMIN_TOKEN not configured; refusing write' });
  }
  const auth = String(req.headers.authorization || '');
  const match = auth.match(/^Bearer\s+(.+)$/);
  if (!match || match[1] !== expected) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  next();
}

function parseLimit(req, defaultLimit = 50, max = 500) {
  const n = Number(req.query.limit);
  if (!Number.isFinite(n) || n <= 0) return defaultLimit;
  return Math.min(n, max);
}

function clampHours(req, defaultHours = 24, max = 168) {
  const n = Number(req.query.hours);
  if (!Number.isFinite(n) || n <= 0) return defaultHours;
  return Math.min(n, max);
}

function jsonErr(res, err) {
  return res.status(500).json({ ok: false, error: String(err?.message || err) });
}

async function withPool(getPool, fn, res) {
  try {
    const pool = await getPool();
    if (!pool) return res.status(503).json({ ok: false, error: 'SQL pool unavailable' });
    return await fn(pool);
  } catch (e) { return jsonErr(res, e); }
}

function mountWeek6Routes(app, { getPool, logger }) {
  if (!app || typeof app.get !== 'function') {
    throw new Error('mountWeek6Routes: app must be an Express-compatible router');
  }

  // ─── /api/rejections ────────────────────────────────────────────────────
  app.get('/api/rejections', async (req, res) => {
    return withPool(getPool, async (pool) => {
      const limit = parseLimit(req, 50, 500);
      const hours = clampHours(req, 24);
      const symbol = req.query.symbol ? String(req.query.symbol).toUpperCase() : null;
      const gate   = req.query.gate ? String(req.query.gate) : null;
      const since  = new Date(Date.now() - hours * 3_600_000).toISOString();

      const r = pool.request();
      r.input('since', since); r.input('limit', limit);
      let q = `SELECT TOP (@limit) id, rejected_at, scope, side, symbol, chain, gate, severity, reason, requested_size_usd
                 FROM dbo.trade_rejections
                WHERE rejected_at >= @since`;
      if (symbol) { r.input('symbol', symbol); q += ' AND symbol = @symbol'; }
      if (gate)   { r.input('gate',   gate);   q += ' AND gate = @gate'; }
      q += ' ORDER BY rejected_at DESC';
      const result = await r.query(q);
      res.json({ ok: true, count: result.recordset.length, data: result.recordset });
    }, res);
  });

  // ─── /api/evolution-history ─────────────────────────────────────────────
  app.get('/api/evolution-history', async (req, res) => {
    return withPool(getPool, async (pool) => {
      const limit = parseLimit(req, 100, 500);
      const decision = req.query.decision ? String(req.query.decision) : null;
      const r = pool.request();
      r.input('limit', limit);
      let q = `SELECT TOP (@limit) id, decided_at, scope, strategy, patch_id, patch_summary, decision, decided_by,
                       pre_win_rate, post_win_rate, causal_delta_winrate, causal_delta_pnl, measured_at
                 FROM dbo.evolution_history`;
      if (decision) { r.input('decision', decision); q += ' WHERE decision = @decision'; }
      q += ' ORDER BY decided_at DESC';
      const result = await r.query(q);
      res.json({ ok: true, count: result.recordset.length, data: result.recordset });
    }, res);
  });

  // ─── /api/ai-decisions ──────────────────────────────────────────────────
  app.get('/api/ai-decisions', async (req, res) => {
    return withPool(getPool, async (pool) => {
      const limit = parseLimit(req, 50, 500);
      const hours = clampHours(req, 24);
      const provider = req.query.provider ? String(req.query.provider) : null;
      const symbol = req.query.symbol ? String(req.query.symbol).toUpperCase() : null;
      const since = new Date(Date.now() - hours * 3_600_000).toISOString();

      const r = pool.request();
      r.input('since', since); r.input('limit', limit);
      let q = `SELECT TOP (@limit) id, decided_at, scope, provider, model, purpose, symbol, chain,
                       cost_usd, latency_ms, success, error_code, signal, confidence
                 FROM dbo.ai_decisions
                WHERE decided_at >= @since`;
      if (provider) { r.input('provider', provider); q += ' AND provider = @provider'; }
      if (symbol)   { r.input('symbol',   symbol);   q += ' AND symbol = @symbol'; }
      q += ' ORDER BY decided_at DESC';
      const result = await r.query(q);
      res.json({ ok: true, count: result.recordset.length, data: result.recordset });
    }, res);
  });

  // ─── /api/ai-decisions/cost ─────────────────────────────────────────────
  app.get('/api/ai-decisions/cost', async (req, res) => {
    return withPool(getPool, async (pool) => {
      const hours = clampHours(req, 24);
      const since = new Date(Date.now() - hours * 3_600_000).toISOString();
      const r = pool.request();
      r.input('since', since);
      const result = await r.query(`
        SELECT provider,
               COUNT(*) AS call_count,
               SUM(CAST(success AS INT)) AS success_count,
               SUM(ISNULL(cost_usd, 0)) AS total_cost_usd,
               AVG(latency_ms) AS avg_latency_ms,
               SUM(CASE WHEN signal = 'BUY' THEN 1 ELSE 0 END) AS buy_count,
               SUM(CASE WHEN signal = 'HOLD' THEN 1 ELSE 0 END) AS hold_count,
               SUM(CASE WHEN signal = 'SELL' THEN 1 ELSE 0 END) AS sell_count
          FROM dbo.ai_decisions
         WHERE decided_at >= @since
         GROUP BY provider
         ORDER BY total_cost_usd DESC
      `);
      res.json({ ok: true, hours, count: result.recordset.length, data: result.recordset });
    }, res);
  });

  // ─── /api/symbol-overrides ──────────────────────────────────────────────
  app.get('/api/symbol-overrides', async (req, res) => {
    return withPool(getPool, async (pool) => {
      const includeInactive = req.query.includeInactive === 'true';
      const q = includeInactive
        ? `SELECT * FROM dbo.symbol_overrides ORDER BY created_at DESC`
        : `SELECT * FROM dbo.symbol_overrides WHERE active = 1 ORDER BY created_at DESC`;
      const result = await pool.request().query(q);
      res.json({ ok: true, count: result.recordset.length, data: result.recordset });
    }, res);
  });

  app.post('/api/symbol-overrides', requireAdmin, async (req, res) => {
    return withPool(getPool, async (pool) => {
      const { symbol, chain, scope = 'global', action, value, reason, expires_at } = req.body || {};
      if (!symbol || !chain || !action) {
        return res.status(400).json({ ok: false, error: 'symbol, chain, action required' });
      }
      const r = pool.request();
      r.input('symbol', String(symbol).toUpperCase());
      r.input('chain',  String(chain).toLowerCase());
      r.input('scope',  scope);
      r.input('action', action);
      r.input('value',  value == null ? null : String(value));
      r.input('reason', reason || null);
      r.input('expires_at', expires_at || null);
      r.input('source', 'dashboard');
      await r.query(`
        MERGE dbo.symbol_overrides AS tgt
        USING (SELECT @symbol AS symbol, @chain AS chain, @scope AS scope, @action AS action) src
           ON tgt.symbol = src.symbol AND tgt.chain = src.chain AND tgt.scope = src.scope AND tgt.action = src.action AND tgt.active = 1
        WHEN MATCHED THEN
          UPDATE SET value = @value, reason = @reason, expires_at = @expires_at, updated_at = SYSUTCDATETIME()
        WHEN NOT MATCHED THEN
          INSERT (symbol, chain, scope, action, value, reason, expires_at, active, source, created_at, updated_at)
          VALUES (@symbol, @chain, @scope, @action, @value, @reason, @expires_at, 1, @source, SYSUTCDATETIME(), SYSUTCDATETIME());
      `);
      logger?.info?.(`[dashboard] symbol_override upsert: ${symbol}/${chain}/${scope}/${action}`);
      res.json({ ok: true });
    }, res);
  });

  app.delete('/api/symbol-overrides/:id', requireAdmin, async (req, res) => {
    return withPool(getPool, async (pool) => {
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: 'invalid id' });
      const r = pool.request();
      r.input('id', id);
      await r.query(`UPDATE dbo.symbol_overrides SET active = 0, updated_at = SYSUTCDATETIME() WHERE id = @id`);
      logger?.info?.(`[dashboard] symbol_override soft-deleted id=${id}`);
      res.json({ ok: true });
    }, res);
  });

  // ─── /api/health-canary ────────────────────────────────────────────────
  app.get('/api/health-canary', async (req, res) => {
    return withPool(getPool, async (pool) => {
      const limit = parseLimit(req, 100, 500);
      const failuresOnly = req.query.failuresOnly === 'true';
      const r = pool.request();
      r.input('limit', limit);
      let q = `SELECT TOP (@limit) id, checked_at, scope, overall_status, check_name, status, value_observed, threshold, message, recovery_hint, duration_ms
                 FROM dbo.health_checks`;
      if (failuresOnly) q += " WHERE status = 'FAIL'";
      q += ' ORDER BY checked_at DESC';
      const result = await r.query(q);
      res.json({ ok: true, count: result.recordset.length, data: result.recordset });
    }, res);
  });

  // ─── /api/health-canary/sparklines (W16.4) ─────────────────────────────
  // Returns last N statuses per check_name + numeric 3-sigma stats on
  // value_observed when parseable. Dashboard renders colored-bar sparkline
  // and overlays a ⚠ badge when current value > mean + 3*stdev (sigma badge).
  app.get('/api/health-canary/sparklines', async (req, res) => {
    return withPool(getPool, async (pool) => {
      const perCheck = Math.max(5, Math.min(60, Number(req.query.perCheck) || 20));
      const result = await pool.request().input('perCheck', perCheck).query(`
        WITH ranked AS (
          SELECT check_name, status, checked_at, value_observed,
                 ROW_NUMBER() OVER (PARTITION BY check_name ORDER BY checked_at DESC) AS rn
            FROM dbo.health_checks
        )
        SELECT check_name, status, checked_at, value_observed
          FROM ranked
         WHERE rn <= @perCheck
         ORDER BY check_name, checked_at ASC
      `);
      const byCheck = {};
      for (const row of result.recordset) {
        const key = String(row.check_name);
        if (!byCheck[key]) byCheck[key] = { series: [], values: [] };
        const numericValue = parseFirstNumber(row.value_observed);
        byCheck[key].series.push({ t: row.checked_at, s: row.status, v: numericValue });
        if (Number.isFinite(numericValue)) byCheck[key].values.push(numericValue);
      }
      // Compute 3-sigma stats per check. `sigmaBadge=true` when latest sample
      // is > mean + 3*stdev (anomaly outside 99.7% of historical distribution).
      const out = {};
      for (const [check, agg] of Object.entries(byCheck)) {
        const stats = sigmaStats(agg.values);
        const latest = agg.series[agg.series.length - 1];
        const sigmaBadge = stats && Number.isFinite(latest?.v) && stats.stdev > 0
          && Math.abs(latest.v - stats.mean) > 3 * stats.stdev;
        out[check] = { series: agg.series, stats, sigmaBadge };
      }
      res.json({ ok: true, perCheck, data: out });
    }, res);
  });

  // ─── /api/ml-models ────────────────────────────────────────────────────
  app.get('/api/ml-models', async (req, res) => {
    return withPool(getPool, async (pool) => {
      const activeOnly = req.query.activeOnly === 'true';
      const q = activeOnly
        ? `SELECT * FROM dbo.ml_model_versions WHERE active = 1 ORDER BY name`
        : `SELECT * FROM dbo.ml_model_versions ORDER BY name, created_at DESC`;
      const result = await pool.request().query(q);
      res.json({ ok: true, count: result.recordset.length, data: result.recordset });
    }, res);
  });

  // ─── /api/backtest-runs ────────────────────────────────────────────────
  app.get('/api/backtest-runs', async (req, res) => {
    return withPool(getPool, async (pool) => {
      const limit = parseLimit(req, 50, 200);
      const patchId = req.query.patchId ? String(req.query.patchId) : null;
      const r = pool.request();
      r.input('limit', limit);
      let q = `SELECT TOP (@limit) id, run_id, started_at, finished_at, scope, strategy, status,
                       trade_count, win_rate, total_pnl_usd, sharpe_ratio, max_drawdown_pct, patch_id
                 FROM dbo.backtest_runs`;
      if (patchId) { r.input('patch_id', patchId); q += ' WHERE patch_id = @patch_id'; }
      q += ' ORDER BY started_at DESC';
      const result = await r.query(q);
      res.json({ ok: true, count: result.recordset.length, data: result.recordset });
    }, res);
  });

  // ─── /api/risk-rules — Week 11.7b CRUD ─────────────────────────────────
  app.get('/api/risk-rules', async (req, res) => {
    await withPool(async (pool) => {
      const scope = String(req.query.scope || '').toLowerCase();
      const r = pool.request();
      let q = `SELECT name, scope, severity, enabled, notes, updated_at FROM dbo.risk_rules`;
      if (scope) { r.input('scope', scope); q += ' WHERE scope IN (@scope, \'global\')'; }
      q += ' ORDER BY scope, name';
      const result = await r.query(q);
      res.json({ ok: true, count: result.recordset.length, data: result.recordset });
    }, res);
  });

  // B4.dash.10: tighten PATCH schema. Original code validated severity but
  // accepted arbitrary `scope` and arbitrarily-long `name`. Add scope
  // whitelist + name length cap + reject unknown body fields to prevent
  // mass-update via spoofed column names. SQL is already parameterized
  // (mssql .input) so this is defense-in-depth, not the primary control.
  const ALLOWED_RISK_RULE_SCOPES = ['live', 'paper', 'both'];
  const ALLOWED_RISK_RULE_FIELDS = new Set(['scope', 'enabled', 'severity', 'notes']);
  app.patch('/api/risk-rules/:name', requireAdmin, async (req, res) => {
    await withPool(async (pool) => {
      const name = String(req.params.name || '').trim();
      const scope = String(req.body?.scope || 'live').toLowerCase();
      const enabled = req.body?.enabled != null ? Boolean(req.body.enabled) : null;
      const severity = req.body?.severity ? String(req.body.severity).toLowerCase() : null;
      const notes = req.body?.notes ? String(req.body.notes).slice(0, 500) : null;
      if (!name || name.length > 64) return res.status(400).json({ ok: false, error: 'name required (max 64 chars)' });
      if (!ALLOWED_RISK_RULE_SCOPES.includes(scope)) {
        return res.status(400).json({ ok: false, error: `scope must be one of ${ALLOWED_RISK_RULE_SCOPES.join('|')}` });
      }
      if (severity && !['block', 'warn', 'log'].includes(severity)) {
        return res.status(400).json({ ok: false, error: 'severity must be block|warn|log' });
      }
      // Reject any body keys outside the allowed set so a spoofed payload
      // can't slip past us if a future SET clause picks up extras.
      const bodyKeys = req.body ? Object.keys(req.body) : [];
      const unknownKeys = bodyKeys.filter((k) => !ALLOWED_RISK_RULE_FIELDS.has(k));
      if (unknownKeys.length) {
        return res.status(400).json({ ok: false, error: `unknown fields: ${unknownKeys.join(', ')}` });
      }
      const sets = [];
      const r = pool.request();
      r.input('name', name);
      r.input('scope', scope);
      if (enabled != null) { r.input('enabled', enabled); sets.push('enabled = @enabled'); }
      if (severity) { r.input('severity', severity); sets.push('severity = @severity'); }
      if (notes != null) { r.input('notes', notes); sets.push('notes = @notes'); }
      if (!sets.length) return res.status(400).json({ ok: false, error: 'no fields to update' });
      sets.push('updated_at = SYSUTCDATETIME()');
      const result = await r.query(`
        UPDATE dbo.risk_rules SET ${sets.join(', ')}
         WHERE name = @name AND scope = @scope;
        SELECT name, scope, severity, enabled, notes, updated_at
          FROM dbo.risk_rules WHERE name = @name AND scope = @scope;
      `);
      const rowsAffected = result.rowsAffected?.[0] || 0;
      if (rowsAffected === 0) return res.status(404).json({ ok: false, error: 'rule not found' });
      res.json({ ok: true, data: result.recordset?.[0] || null });
    }, res);
  });

  return {
    endpoints: [
      'GET /api/rejections',
      'GET /api/evolution-history',
      'GET /api/ai-decisions',
      'GET /api/ai-decisions/cost',
      'GET /api/symbol-overrides',
      'POST /api/symbol-overrides (auth)',
      'DELETE /api/symbol-overrides/:id (auth)',
      'GET /api/health-canary',
      'GET /api/health-canary/sparklines',
      'GET /api/ml-models',
      'GET /api/backtest-runs',
      'GET /api/risk-rules',
      'PATCH /api/risk-rules/:name (auth)',
    ],
  };
}

module.exports = { mountWeek6Routes, requireAdmin, _internals: { parseLimit, clampHours } };
