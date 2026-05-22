 'use strict';
 
 const os = require('os');
 const crypto = require('crypto');
 const { getPool, ensureSchema, sql } = require('./sqlServer');
 
 function uuid() {
   return typeof crypto.randomUUID === 'function'
     ? crypto.randomUUID()
     : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
 }
 
function safeJson(value, maxLen = 4000, options = {}) {
  if (value === undefined) return null;
  const strict = Boolean(options && options.strict);
  let str;
  try {
    str = JSON.stringify(value);
  } catch {
    if (strict) {
      const err = new Error('safeJson: value not serializable');
      err.code = 'SAFE_JSON_UNSERIALIZABLE';
      throw err;
    }
    return null;
  }
  if (typeof str !== 'string') return null;
  if (str.length <= maxLen) return str;
  if (strict) {
    const err = new Error(`safeJson: serialized payload (${str.length}) exceeds SQL limit (${maxLen})`);
    err.code = 'SAFE_JSON_TRUNCATED';
    err.size = str.length;
    err.limit = maxLen;
    throw err;
  }
  // Non-strict: emit a self-describing marker so downstream parsers know the
  // payload was truncated rather than silently losing the JSON tail.
  const marker = JSON.stringify({
    _truncated: true,
    _originalSize: str.length,
    _limit: maxLen,
    _preview: str.slice(0, Math.max(0, maxLen - 120)),
  });
  // If even the marker is too large, fall back to a minimal one.
  if (marker.length > maxLen) {
    return JSON.stringify({ _truncated: true, _originalSize: str.length, _limit: maxLen });
  }
  return marker;
}

function parseSqlJson(raw, columnName = 'json', logger = console) {
  if (raw === null || raw === undefined || raw === '') {
    return { ok: false, value: null, reason: 'empty' };
  }
  let parsed;
  try {
    parsed = JSON.parse(String(raw));
  } catch (error) {
    logger?.warn?.(`[SQL] ${columnName} parse failed: ${error?.message || error}`);
    return { ok: false, value: null, reason: 'invalid_json', error: error?.message || String(error) };
  }
  if (parsed && typeof parsed === 'object' && parsed._truncated === true) {
    logger?.warn?.(`[SQL] ${columnName} was truncated (original size ${parsed._originalSize})`);
    return { ok: false, value: parsed, reason: 'truncated' };
  }
  return { ok: true, value: parsed };
}

function toDateOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

async function loadSharedAgentMemory(pool) {
  try {
    const req = pool.request();
    req.input('k', sql.NVarChar(200), 'agent-memory:shared');
    const res = await req.query('SELECT TOP 1 [v] FROM dbo.bot_kv WHERE [k] = @k');
    const raw = res.recordset?.[0]?.v;
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}
 
 class SqlTelemetry {
   constructor({ logger, botProfile } = {}) {
     this.logger = logger || console;
     this.botProfile = String(botProfile || process.env.BOT_PROFILE || (process.env.PAPER_TRADING === 'true' ? 'paper' : 'live')).toLowerCase();
     this.runId = null;
     this.host = os.hostname();
 
     this._queue = [];
     this._flushInFlight = false;
     this._timer = null;
 
     this.flushIntervalMs = Math.max(250, Number(process.env.SQL_TELEMETRY_FLUSH_MS || 1500));
     this.maxBatch = Math.max(10, Number(process.env.SQL_TELEMETRY_BATCH_SIZE || 50));
   }
 
   isEnabled() {
     return String(process.env.SQL_ENABLED || '').toLowerCase() === 'true';
   }
 
   start() {
     if (!this.isEnabled()) return;
     if (this._timer) return;
     this._timer = setInterval(() => this.flush().catch(() => {}), this.flushIntervalMs);
     this._timer.unref?.();
   }
 
   stop() {
     if (this._timer) clearInterval(this._timer);
     this._timer = null;
   }
 
   async startRun({ gitSha = null, configHash = null, meta = null } = {}) {
     if (!this.isEnabled()) return null;
     const pool = await getPool(this.logger);
     if (!pool) return null;
     await ensureSchema(this.logger);
     this.start();
 
     const runId = uuid();
     this.runId = runId;
     try {
       const req = pool.request();
       req.input('run_id', sql.UniqueIdentifier, runId);
       req.input('bot_profile', sql.NVarChar(20), this.botProfile);
       req.input('host', sql.NVarChar(120), this.host);
       req.input('pid', sql.Int, process.pid);
       req.input('git_sha', sql.NVarChar(80), gitSha ? String(gitSha).slice(0, 80) : null);
       req.input('config_hash', sql.NVarChar(80), configHash ? String(configHash).slice(0, 80) : null);
       req.input('meta_json', sql.NVarChar(sql.MAX), safeJson(meta, 20000));
       await req.query(`
 INSERT INTO dbo.bot_runs(run_id, bot_profile, host, pid, git_sha, config_hash, meta_json)
 VALUES (@run_id, @bot_profile, @host, @pid, @git_sha, @config_hash, @meta_json)
 `);
     } catch (e) {
       this.logger.warn(`[SQL] startRun failed: ${e.message}`);
     }
     return runId;
   }
 
  async endRun({ exitReason = null } = {}) {
     if (!this.isEnabled()) return;
     const pool = await getPool(this.logger);
     if (!pool || !this.runId) return;
     await ensureSchema(this.logger);
     try {
       const req = pool.request();
       req.input('run_id', sql.UniqueIdentifier, this.runId);
       req.input('exit_reason', sql.NVarChar(200), exitReason ? String(exitReason).slice(0, 200) : null);
       await req.query(`
 UPDATE dbo.bot_runs
 SET ended_at = SYSUTCDATETIME(),
     exit_reason = @exit_reason
 WHERE run_id = @run_id
 `);
     } catch (e) {
       this.logger.warn(`[SQL] endRun failed: ${e.message}`);
     }
   }
 
   enqueue(kind, payload) {
     if (!this.isEnabled()) return;
     this._queue.push({ kind, payload });
     if (this._queue.length >= this.maxBatch * 2) {
       // Backpressure: flush soon (best-effort)
       this.flush().catch(() => {});
     }
   }
 
   logSignal(snapshot, { gate = null, rejectReasons = null } = {}) {
     this.enqueue('signal', { snapshot, gate, rejectReasons });
   }
 
   logOrder(order) {
     this.enqueue('order', order);
   }
 
   logFill(fill) {
     this.enqueue('fill', fill);
   }
 
   logPositionOpen(pos) {
     this.enqueue('pos_open', pos);
   }
 
   logPositionSnapshot(snap) {
     this.enqueue('pos_snap', snap);
   }
 
  logPositionClose(close) {
    this.enqueue('pos_close', close);
  }

  logStateSnapshot(snapshot) {
    this.enqueue('state_snap', snapshot);
  }

  logTradeLedger(trade) {
    this.enqueue('trade_ledger', trade);
  }

  logPnlPoint(point) {
    this.enqueue('pnl_point', point);
  }

  logDecision(decision) {
    this.enqueue('decision', decision);
  }

  logDecisionReflection(reflection) {
    this.enqueue('decision_reflection', reflection);
  }

  logStrategyVersion(version) {
    this.enqueue('strategy_version', version);
  }

  logPromotionEvent(event) {
    this.enqueue('promotion_event', event);
  }

  logOpsEvent(evt) {
    this.enqueue('ops', evt);
  }
 
   async flush() {
     if (!this.isEnabled()) return;
     const pool = await getPool(this.logger);
     if (!pool) return;
     await ensureSchema(this.logger);
     return this.flushWithPool(pool);
   }

  async flushWithPool(pool) {
    if (!this.isEnabled()) return;
    if (this._flushInFlight) return;
    this._flushInFlight = true;
    try {
      while (this._queue.length) {
        const batch = this._queue.splice(0, this.maxBatch);
        try {
          for (const item of batch) {
            // eslint-disable-next-line no-await-in-loop
            await this._writeOne(pool, item);
          }
        } catch (e) {
          // Requeue the entire batch (preserve order) so nothing is silently dropped.
          this._queue.unshift(...batch);
          this.logger?.warn?.(`[SQL] flush batch failed (requeued ${batch.length}): ${e?.message || e}`);
          return;
        }
      }
    } finally {
      this._flushInFlight = false;
    }
  }
 
   async _writeOne(pool, { kind, payload }) {
     const runId = this.runId;
     if (kind === 'signal') {
       const { snapshot, gate, rejectReasons } = payload || {};
       if (!snapshot) return;
       const req = pool.request();
       req.input('signal_id', sql.UniqueIdentifier, uuid());
       req.input('run_id', sql.UniqueIdentifier, runId);
       req.input('ts', sql.DateTime2(3), new Date(snapshot.lastScannedAt || Date.now()));
       req.input('bot_profile', sql.NVarChar(20), this.botProfile);
       req.input('chain', sql.NVarChar(30), snapshot.chain || null);
       req.input('chain_key', sql.NVarChar(30), snapshot.chainKey || null);
       req.input('symbol', sql.NVarChar(40), snapshot.symbol || null);
       req.input('address', sql.NVarChar(120), snapshot.address || null);
       req.input('strategy', sql.NVarChar(30), snapshot.strategy || null);
       req.input('final_signal', sql.NVarChar(30), snapshot.finalSignal || null);
       req.input('technical_signal', sql.NVarChar(30), snapshot.technicalSignal || null);
       req.input('signal_source', sql.NVarChar(80), snapshot.signalSource || null);
       req.input('confidence', sql.Float, Number.isFinite(Number(snapshot.indicators?.confidence)) ? Number(snapshot.indicators.confidence) : null);
       req.input('ai_confidence', sql.Float, Number.isFinite(Number(snapshot.aiConfidence)) ? Number(snapshot.aiConfidence) : null);
       req.input('ai_reason', sql.NVarChar(400), snapshot.aiReason ? String(snapshot.aiReason).slice(0, 400) : null);
       req.input('risk_flags_json', sql.NVarChar(sql.MAX), safeJson(snapshot.riskFlags, 4000));
       req.input('features_json', sql.NVarChar(sql.MAX), safeJson(snapshot, 20000));
       req.input('gate_json', sql.NVarChar(sql.MAX), safeJson(gate, 12000));
       req.input('reject_reasons_json', sql.NVarChar(sql.MAX), safeJson(rejectReasons, 8000));
       await req.query(`
 INSERT INTO dbo.signals(
   signal_id, run_id, ts, bot_profile, chain, chain_key, symbol, address, strategy,
   final_signal, technical_signal, signal_source, confidence, ai_confidence, ai_reason,
   risk_flags_json, features_json, gate_json, reject_reasons_json
 )
 VALUES (
   @signal_id, @run_id, @ts, @bot_profile, @chain, @chain_key, @symbol, @address, @strategy,
   @final_signal, @technical_signal, @signal_source, @confidence, @ai_confidence, @ai_reason,
   @risk_flags_json, @features_json, @gate_json, @reject_reasons_json
 )
 `);
       return;
     }
 
     if (kind === 'order') {
       const o = payload || {};
       if (!o.order_id) return;
       const req = pool.request();
       req.input('order_id', sql.UniqueIdentifier, o.order_id);
       req.input('run_id', sql.UniqueIdentifier, runId);
       req.input('ts', sql.DateTime2(3), new Date(o.ts || Date.now()));
       req.input('bot_profile', sql.NVarChar(20), this.botProfile);
       req.input('chain', sql.NVarChar(30), o.chain || null);
       req.input('chain_key', sql.NVarChar(30), o.chain_key || null);
       req.input('symbol', sql.NVarChar(40), o.symbol || null);
       req.input('address', sql.NVarChar(120), o.address || null);
       req.input('side', sql.NVarChar(10), o.side || 'BUY');
       req.input('strategy', sql.NVarChar(30), o.strategy || null);
       req.input('requested_quote_usd', sql.Float, Number.isFinite(Number(o.requested_quote_usd)) ? Number(o.requested_quote_usd) : null);
       req.input('requested_base_qty', sql.Float, Number.isFinite(Number(o.requested_base_qty)) ? Number(o.requested_base_qty) : null);
       req.input('expected_price', sql.Float, Number.isFinite(Number(o.expected_price)) ? Number(o.expected_price) : null);
       req.input('status', sql.NVarChar(30), String(o.status || 'submitted').slice(0, 30));
       req.input('reason', sql.NVarChar(200), o.reason ? String(o.reason).slice(0, 200) : null);
       req.input('error_text', sql.NVarChar(800), o.error_text ? String(o.error_text).slice(0, 800) : null);
       req.input('client_order_key', sql.NVarChar(120), o.client_order_key ? String(o.client_order_key).slice(0, 120) : null);
       req.input('metadata_json', sql.NVarChar(sql.MAX), safeJson(o.metadata, 20000));
       await req.query(`
 MERGE dbo.orders WITH (HOLDLOCK) AS t
 USING (SELECT @order_id AS order_id) AS s
 ON t.order_id = s.order_id
 WHEN MATCHED THEN
   UPDATE SET status=@status, reason=@reason, error_text=@error_text, metadata_json=@metadata_json
 WHEN NOT MATCHED THEN
   INSERT (order_id, run_id, ts, bot_profile, chain, chain_key, symbol, address, side, strategy,
           requested_quote_usd, requested_base_qty, expected_price, status, reason, error_text, client_order_key, metadata_json)
   VALUES (@order_id, @run_id, @ts, @bot_profile, @chain, @chain_key, @symbol, @address, @side, @strategy,
           @requested_quote_usd, @requested_base_qty, @expected_price, @status, @reason, @error_text, @client_order_key, @metadata_json);
 `);
       return;
     }
 
     if (kind === 'fill') {
       const f = payload || {};
       if (!f.order_id) return;
       const req = pool.request();
       req.input('fill_id', sql.UniqueIdentifier, f.fill_id || uuid());
       req.input('order_id', sql.UniqueIdentifier, f.order_id);
       req.input('ts', sql.DateTime2(3), new Date(f.ts || Date.now()));
       req.input('txid', sql.NVarChar(200), f.txid_or_exchange_id ? String(f.txid_or_exchange_id).slice(0, 200) : null);
       req.input('filled_base_qty', sql.Float, Number.isFinite(Number(f.filled_base_qty)) ? Number(f.filled_base_qty) : null);
       req.input('filled_quote_usd', sql.Float, Number.isFinite(Number(f.filled_quote_usd)) ? Number(f.filled_quote_usd) : null);
       req.input('avg_price', sql.Float, Number.isFinite(Number(f.avg_price)) ? Number(f.avg_price) : null);
       req.input('fee_usd', sql.Float, Number.isFinite(Number(f.fee_usd)) ? Number(f.fee_usd) : null);
       req.input('slippage_bps', sql.Float, Number.isFinite(Number(f.slippage_bps)) ? Number(f.slippage_bps) : null);
       req.input('block_number', sql.BigInt, Number.isFinite(Number(f.block_number)) ? Number(f.block_number) : null);
       req.input('confirmations', sql.Int, Number.isFinite(Number(f.confirmations)) ? Number(f.confirmations) : null);
       req.input('raw_receipt_json', sql.NVarChar(sql.MAX), safeJson(f.raw_receipt, 20000));
       await req.query(`
 INSERT INTO dbo.fills(fill_id, order_id, ts, txid_or_exchange_id, filled_base_qty, filled_quote_usd, avg_price, fee_usd, slippage_bps, block_number, confirmations, raw_receipt_json)
 VALUES (@fill_id, @order_id, @ts, @txid, @filled_base_qty, @filled_quote_usd, @avg_price, @fee_usd, @slippage_bps, @block_number, @confirmations, @raw_receipt_json)
 `);
       return;
     }
 
     if (kind === 'pos_open') {
       const p = payload || {};
       if (!p.position_id) return;
       const req = pool.request();
       req.input('position_id', sql.UniqueIdentifier, p.position_id);
       req.input('run_id', sql.UniqueIdentifier, runId);
       req.input('bot_profile', sql.NVarChar(20), this.botProfile);
       req.input('chain', sql.NVarChar(30), p.chain || null);
       req.input('chain_key', sql.NVarChar(30), p.chain_key || null);
       req.input('symbol', sql.NVarChar(40), p.symbol || null);
       req.input('address', sql.NVarChar(120), p.address || null);
       req.input('strategy', sql.NVarChar(30), p.strategy || null);
       req.input('opened_at', sql.DateTime2(3), new Date(p.opened_at || Date.now()));
       req.input('entry_price', sql.Float, Number.isFinite(Number(p.entry_price)) ? Number(p.entry_price) : null);
       req.input('entry_usd', sql.Float, Number.isFinite(Number(p.entry_usd)) ? Number(p.entry_usd) : null);
       req.input('tags_json', sql.NVarChar(sql.MAX), safeJson(p.tags, 20000));
       await req.query(`
 INSERT INTO dbo.positions(position_id, run_id, bot_profile, chain, chain_key, symbol, address, strategy, opened_at, entry_price, entry_usd, tags_json)
 VALUES (@position_id, @run_id, @bot_profile, @chain, @chain_key, @symbol, @address, @strategy, @opened_at, @entry_price, @entry_usd, @tags_json)
 `);
       return;
     }
 
     if (kind === 'pos_snap') {
       const s = payload || {};
       if (!s.position_id) return;
       const req = pool.request();
       req.input('snapshot_id', sql.UniqueIdentifier, s.snapshot_id || uuid());
       req.input('position_id', sql.UniqueIdentifier, s.position_id);
       req.input('ts', sql.DateTime2(3), new Date(s.ts || Date.now()));
       req.input('price', sql.Float, Number.isFinite(Number(s.price)) ? Number(s.price) : null);
       req.input('unrealized_pnl_usd', sql.Float, Number.isFinite(Number(s.unrealized_pnl_usd)) ? Number(s.unrealized_pnl_usd) : null);
       req.input('highest_price', sql.Float, Number.isFinite(Number(s.highest_price)) ? Number(s.highest_price) : null);
       req.input('trailing_stop', sql.Float, Number.isFinite(Number(s.trailing_stop)) ? Number(s.trailing_stop) : null);
       req.input('risk_state_json', sql.NVarChar(sql.MAX), safeJson(s.risk_state, 20000));
       await req.query(`
 INSERT INTO dbo.position_snapshots(snapshot_id, position_id, ts, price, unrealized_pnl_usd, highest_price, trailing_stop, risk_state_json)
 VALUES (@snapshot_id, @position_id, @ts, @price, @unrealized_pnl_usd, @highest_price, @trailing_stop, @risk_state_json)
 `);
       return;
     }
 
     if (kind === 'pos_close') {
       const c = payload || {};
       if (!c.position_id) return;
       const req = pool.request();
       req.input('position_id', sql.UniqueIdentifier, c.position_id);
       req.input('closed_at', sql.DateTime2(3), new Date(c.closed_at || Date.now()));
       req.input('exit_price', sql.Float, Number.isFinite(Number(c.exit_price)) ? Number(c.exit_price) : null);
       req.input('exit_usd', sql.Float, Number.isFinite(Number(c.exit_usd)) ? Number(c.exit_usd) : null);
       req.input('pnl_usd', sql.Float, Number.isFinite(Number(c.pnl_usd)) ? Number(c.pnl_usd) : null);
       req.input('pnl_pct', sql.Float, Number.isFinite(Number(c.pnl_pct)) ? Number(c.pnl_pct) : null);
       req.input('exit_reason', sql.NVarChar(200), c.exit_reason ? String(c.exit_reason).slice(0, 200) : null);
       await req.query(`
 UPDATE dbo.positions
 SET closed_at=@closed_at,
     exit_price=@exit_price,
     exit_usd=@exit_usd,
     pnl_usd=@pnl_usd,
     pnl_pct=@pnl_pct,
     exit_reason=@exit_reason
 WHERE position_id=@position_id
 `);
       return;
     }
 
    if (kind === 'ops') {
      const e = payload || {};
      const req = pool.request();
       req.input('event_id', sql.UniqueIdentifier, e.event_id || uuid());
       req.input('run_id', sql.UniqueIdentifier, runId);
       req.input('bot_profile', sql.NVarChar(20), this.botProfile);
       req.input('ts', sql.DateTime2(3), new Date(e.ts || Date.now()));
       req.input('severity', sql.NVarChar(12), String(e.severity || 'info').slice(0, 12));
       req.input('category', sql.NVarChar(40), String(e.category || 'ops').slice(0, 40));
       req.input('name', sql.NVarChar(80), String(e.name || 'event').slice(0, 80));
       req.input('chain_key', sql.NVarChar(30), e.chain_key ? String(e.chain_key).slice(0, 30) : null);
       req.input('symbol', sql.NVarChar(40), e.symbol ? String(e.symbol).slice(0, 40) : null);
       req.input('duration_ms', sql.Int, Number.isFinite(Number(e.duration_ms)) ? Number(e.duration_ms) : null);
       req.input('context_json', sql.NVarChar(sql.MAX), safeJson(e.context, 20000));
       req.input('message', sql.NVarChar(800), e.message ? String(e.message).slice(0, 800) : null);
       await req.query(`
 INSERT INTO dbo.ops_events(event_id, run_id, bot_profile, ts, severity, category, name, chain_key, symbol, duration_ms, context_json, message)
 VALUES (@event_id, @run_id, @bot_profile, @ts, @severity, @category, @name, @chain_key, @symbol, @duration_ms, @context_json, @message)
 `);
      return;
    }

    if (kind === 'state_snap') {
      const s = payload || {};
      const req = pool.request();
      req.input('snapshot_id', sql.UniqueIdentifier, s.snapshot_id || uuid());
      req.input('run_id', sql.UniqueIdentifier, runId);
      req.input('bot_profile', sql.NVarChar(20), this.botProfile);
      req.input('snapshot_kind', sql.NVarChar(30), String(s.snapshot_kind || 'periodic').slice(0, 30));
      req.input('ts', sql.DateTime2(3), new Date(s.ts || Date.now()));
      req.input('state_json', sql.NVarChar(sql.MAX), safeJson(s.state, 200000));
      req.input('market_state_json', sql.NVarChar(sql.MAX), safeJson(s.market_state, 200000));
      req.input('stats_json', sql.NVarChar(sql.MAX), safeJson(s.stats, 40000));
      await req.query(`
 INSERT INTO dbo.bot_state_snapshots(snapshot_id, run_id, bot_profile, snapshot_kind, ts, state_json, market_state_json, stats_json)
 VALUES (@snapshot_id, @run_id, @bot_profile, @snapshot_kind, @ts, @state_json, @market_state_json, @stats_json)
 `);
      return;
    }

    if (kind === 'trade_ledger') {
      const t = payload || {};
      const setupType = t.setupType || t.setup_type || t.details?.setupType || null;
      const req = pool.request();
      req.input('trade_id', sql.UniqueIdentifier, t.trade_id || uuid());
      req.input('bot_profile', sql.NVarChar(20), this.botProfile);
      req.input('ts', sql.DateTime2(3), new Date(t.timestamp || t.ts || Date.now()));
      req.input('trade_type', sql.NVarChar(20), String(t.type || 'UNKNOWN').slice(0, 20));
      req.input('symbol', sql.NVarChar(40), t.symbol ? String(t.symbol).slice(0, 40) : null);
      req.input('chain', sql.NVarChar(30), t.chain ? String(t.chain).slice(0, 30) : null);
      req.input('chain_key', sql.NVarChar(30), t.chainKey ? String(t.chainKey).slice(0, 30) : null);
      req.input('strategy', sql.NVarChar(30), t.strategy ? String(t.strategy).slice(0, 30) : null);
      req.input('address', sql.NVarChar(120), t.address ? String(t.address).slice(0, 120) : null);
      req.input('price', sql.Float, Number.isFinite(Number(t.price)) ? Number(t.price) : null);
      req.input('quantity', sql.Float, Number.isFinite(Number(t.quantity)) ? Number(t.quantity) : null);
      req.input('value_usd', sql.Float, Number.isFinite(Number(t.valueUsd)) ? Number(t.valueUsd) : null);
      req.input('pnl_usd', sql.Float, Number.isFinite(Number(t.pnl)) ? Number(t.pnl) : null);
      req.input('txid', sql.NVarChar(200), t.txid ? String(t.txid).slice(0, 200) : null);
      req.input('signal_source', sql.NVarChar(80), t.signalSource ? String(t.signalSource).slice(0, 80) : null);
      req.input('reason', sql.NVarChar(200), t.reason ? String(t.reason).slice(0, 200) : null);
      req.input('setup_type', sql.NVarChar(40), setupType ? String(setupType).slice(0, 40) : null);
      req.input('raw_trade_json', sql.NVarChar(sql.MAX), safeJson(t, 20000));
      await req.query(`
 INSERT INTO dbo.bot_trade_ledger(
   trade_id, bot_profile, ts, trade_type, symbol, chain, chain_key, strategy, address, price, quantity, value_usd, pnl_usd, txid, signal_source, reason, setup_type, raw_trade_json
 )
 VALUES (
   @trade_id, @bot_profile, @ts, @trade_type, @symbol, @chain, @chain_key, @strategy, @address, @price, @quantity, @value_usd, @pnl_usd, @txid, @signal_source, @reason, @setup_type, @raw_trade_json
 )
 `);
      return;
    }

    if (kind === 'pnl_point') {
      const p = payload || {};
      const req = pool.request();
      req.input('pnl_point_id', sql.UniqueIdentifier, p.pnl_point_id || uuid());
      req.input('bot_profile', sql.NVarChar(20), this.botProfile);
      req.input('ts', sql.DateTime2(3), new Date(p.timestamp || p.ts || Date.now()));
      req.input('cash', sql.Float, Number.isFinite(Number(p.cash)) ? Number(p.cash) : null);
      req.input('equity', sql.Float, Number.isFinite(Number(p.equity)) ? Number(p.equity) : null);
      req.input('total_pnl', sql.Float, Number.isFinite(Number(p.totalPnl)) ? Number(p.totalPnl) : null);
      req.input('unrealized_pnl', sql.Float, Number.isFinite(Number(p.unrealizedPnl)) ? Number(p.unrealizedPnl) : null);
      req.input('reason', sql.NVarChar(80), p.reason ? String(p.reason).slice(0, 80) : null);
      await req.query(`
 INSERT INTO dbo.bot_pnl_history(
   pnl_point_id, bot_profile, ts, cash, equity, total_pnl, unrealized_pnl, reason
 )
 VALUES (
   @pnl_point_id, @bot_profile, @ts, @cash, @equity, @total_pnl, @unrealized_pnl, @reason
 )
 `);
      return;
    }

    if (kind === 'decision') {
      const d = payload || {};
      const req = pool.request();
      req.input('decision_id', sql.UniqueIdentifier, d.decision_id || uuid());
      req.input('run_id', sql.UniqueIdentifier, runId);
      req.input('bot_profile', sql.NVarChar(20), this.botProfile);
      req.input('ts', sql.DateTime2(3), new Date(d.ts || Date.now()));
      req.input('chain', sql.NVarChar(30), d.chain ? String(d.chain).slice(0, 30) : null);
      req.input('chain_key', sql.NVarChar(30), d.chain_key ? String(d.chain_key).slice(0, 30) : null);
      req.input('symbol', sql.NVarChar(40), d.symbol ? String(d.symbol).slice(0, 40) : null);
      req.input('address', sql.NVarChar(120), d.address ? String(d.address).slice(0, 120) : null);
      req.input('strategy', sql.NVarChar(30), d.strategy ? String(d.strategy).slice(0, 30) : null);
      req.input('signal_source', sql.NVarChar(80), d.signal_source ? String(d.signal_source).slice(0, 80) : null);
      req.input('decision_stage', sql.NVarChar(30), String(d.decision_stage || 'approval').slice(0, 30));
      req.input('proposal_json', sql.NVarChar(sql.MAX), safeJson(d.proposal_json ?? d.proposal, 40000));
      req.input('risk_json', sql.NVarChar(sql.MAX), safeJson(d.risk_json ?? d.risk, 30000));
      req.input('approval_json', sql.NVarChar(sql.MAX), safeJson(d.approval_json ?? d.approval, 30000));
      req.input('final_action', sql.NVarChar(30), d.final_action ? String(d.final_action).slice(0, 30) : null);
      req.input('approved', sql.Bit, Boolean(d.approved));
      req.input('confidence', sql.Float, Number.isFinite(Number(d.confidence)) ? Number(d.confidence) : null);
      req.input('ai_confidence', sql.Float, Number.isFinite(Number(d.ai_confidence)) ? Number(d.ai_confidence) : null);
      req.input('reason', sql.NVarChar(800), d.reason ? String(d.reason).slice(0, 800) : null);
      req.input('order_id', sql.UniqueIdentifier, d.order_id || null);
      req.input('position_id', sql.UniqueIdentifier, d.position_id || null);
      req.input('status', sql.NVarChar(30), d.status ? String(d.status).slice(0, 30) : null);
      req.input('strategy_version_id', sql.NVarChar(80), d.strategy_version_id ? String(d.strategy_version_id).slice(0, 80) : null);
      req.input('regime_label', sql.NVarChar(40), d.regime_label ? String(d.regime_label).slice(0, 40) : null);
      req.input('promotion_stage', sql.NVarChar(30), d.promotion_stage ? String(d.promotion_stage).slice(0, 30) : null);
      await req.query(`
INSERT INTO dbo.decision_log(
  decision_id, run_id, bot_profile, ts, chain, chain_key, symbol, address, strategy, signal_source,
  decision_stage, proposal_json, risk_json, approval_json, final_action, approved, confidence,
  ai_confidence, reason, order_id, position_id, status, strategy_version_id, regime_label, promotion_stage
)
VALUES (
  @decision_id, @run_id, @bot_profile, @ts, @chain, @chain_key, @symbol, @address, @strategy, @signal_source,
  @decision_stage, @proposal_json, @risk_json, @approval_json, @final_action, @approved, @confidence,
  @ai_confidence, @reason, @order_id, @position_id, @status, @strategy_version_id, @regime_label, @promotion_stage
)
`);
      return;
    }

    if (kind === 'decision_reflection') {
      const r = payload || {};
      const req = pool.request();
      req.input('reflection_id', sql.UniqueIdentifier, r.reflection_id || uuid());
      req.input('decision_id', sql.UniqueIdentifier, r.decision_id || null);
      req.input('bot_profile', sql.NVarChar(20), this.botProfile);
      req.input('ts', sql.DateTime2(3), new Date(r.ts || Date.now()));
      req.input('chain_key', sql.NVarChar(30), r.chain_key ? String(r.chain_key).slice(0, 30) : null);
      req.input('symbol', sql.NVarChar(40), r.symbol ? String(r.symbol).slice(0, 40) : null);
      req.input('strategy', sql.NVarChar(30), r.strategy ? String(r.strategy).slice(0, 30) : null);
      req.input('outcome', sql.NVarChar(20), r.outcome ? String(r.outcome).slice(0, 20) : null);
      req.input('pnl_usd', sql.Float, Number.isFinite(Number(r.pnl_usd)) ? Number(r.pnl_usd) : null);
      req.input('pnl_pct', sql.Float, Number.isFinite(Number(r.pnl_pct)) ? Number(r.pnl_pct) : null);
      req.input('hold_duration_hours', sql.Float, Number.isFinite(Number(r.hold_duration_hours)) ? Number(r.hold_duration_hours) : null);
      req.input('reflection_json', sql.NVarChar(sql.MAX), safeJson(r.reflection_json ?? r.reflection, 30000));
      req.input('summary', sql.NVarChar(sql.MAX), r.summary ? String(r.summary) : null);
      req.input('strategy_version_id', sql.NVarChar(80), r.strategy_version_id ? String(r.strategy_version_id).slice(0, 80) : null);
      req.input('regime_label', sql.NVarChar(40), r.regime_label ? String(r.regime_label).slice(0, 40) : null);
      await req.query(`
INSERT INTO dbo.decision_reflections(
  reflection_id, decision_id, bot_profile, ts, chain_key, symbol, strategy, outcome, pnl_usd, pnl_pct,
  hold_duration_hours, reflection_json, summary, strategy_version_id, regime_label
)
VALUES (
  @reflection_id, @decision_id, @bot_profile, @ts, @chain_key, @symbol, @strategy, @outcome, @pnl_usd, @pnl_pct,
  @hold_duration_hours, @reflection_json, @summary, @strategy_version_id, @regime_label
)
`);
      return;
    }

    if (kind === 'strategy_version') {
      const v = payload || {};
      if (!v.version_id) return;
      const req = pool.request();
      req.input('version_id', sql.NVarChar(80), String(v.version_id).slice(0, 80));
      req.input('version_hash', sql.NVarChar(80), String(v.version_hash || '').slice(0, 80));
      req.input('bot_profile', sql.NVarChar(20), String(v.bot_profile || this.botProfile).slice(0, 20));
      req.input('source_profile', sql.NVarChar(20), v.source_profile ? String(v.source_profile).slice(0, 20) : null);
      req.input('stage', sql.NVarChar(30), String(v.stage || 'paper_candidate').slice(0, 30));
      req.input('created_at', sql.DateTime2(3), new Date(v.created_at || Date.now()));
      req.input('approved_at', sql.DateTime2(3), toDateOrNull(v.approved_at));
      req.input('activated_at', sql.DateTime2(3), toDateOrNull(v.activated_at));
      req.input('rollback_at', sql.DateTime2(3), toDateOrNull(v.rollback_at));
      req.input('candidate_id', sql.NVarChar(80), v.candidate_id ? String(v.candidate_id).slice(0, 80) : null);
      req.input('config_hash', sql.NVarChar(80), v.config_hash ? String(v.config_hash).slice(0, 80) : null);
      req.input('code_hash', sql.NVarChar(80), v.code_hash ? String(v.code_hash).slice(0, 80) : null);
      req.input('parent_version_id', sql.NVarChar(80), v.parent_version_id ? String(v.parent_version_id).slice(0, 80) : null);
      req.input('metadata_json', sql.NVarChar(sql.MAX), safeJson(v.metadata || v.metadata_json, 20000));
      await req.query(`
MERGE dbo.strategy_versions WITH (HOLDLOCK) AS t
USING (SELECT @version_id AS version_id) AS s
ON t.version_id = s.version_id
WHEN MATCHED THEN
  UPDATE SET version_hash=@version_hash, stage=@stage, approved_at=COALESCE(@approved_at, t.approved_at),
             activated_at=COALESCE(@activated_at, t.activated_at), rollback_at=COALESCE(@rollback_at, t.rollback_at),
             metadata_json=@metadata_json
WHEN NOT MATCHED THEN
  INSERT(version_id, version_hash, bot_profile, source_profile, stage, created_at, approved_at, activated_at, rollback_at, candidate_id, config_hash, code_hash, parent_version_id, metadata_json)
  VALUES(@version_id, @version_hash, @bot_profile, @source_profile, @stage, @created_at, @approved_at, @activated_at, @rollback_at, @candidate_id, @config_hash, @code_hash, @parent_version_id, @metadata_json);
`);
      return;
    }

    if (kind === 'promotion_event') {
      const e = payload || {};
      if (!e.version_id) return;
      const req = pool.request();
      req.input('event_id', sql.UniqueIdentifier, e.event_id || uuid());
      req.input('version_id', sql.NVarChar(80), String(e.version_id).slice(0, 80));
      req.input('bot_profile', sql.NVarChar(20), String(e.bot_profile || this.botProfile).slice(0, 20));
      req.input('ts', sql.DateTime2(3), new Date(e.ts || Date.now()));
      req.input('event_type', sql.NVarChar(40), String(e.event_type || 'promotion').slice(0, 40));
      req.input('stage', sql.NVarChar(30), e.stage ? String(e.stage).slice(0, 30) : null);
      req.input('status', sql.NVarChar(30), e.status ? String(e.status).slice(0, 30) : null);
      req.input('discrepancy_score', sql.Float, Number.isFinite(Number(e.discrepancy_score)) ? Number(e.discrepancy_score) : null);
      req.input('promotion_confidence', sql.Float, Number.isFinite(Number(e.promotion_confidence)) ? Number(e.promotion_confidence) : null);
      req.input('approval_required', sql.Bit, Boolean(e.approval_required));
      req.input('approved_by', sql.NVarChar(80), e.approved_by ? String(e.approved_by).slice(0, 80) : null);
      req.input('notes', sql.NVarChar(800), e.notes ? String(e.notes).slice(0, 800) : null);
      req.input('context_json', sql.NVarChar(sql.MAX), safeJson(e.context || e.context_json, 20000));
      await req.query(`
INSERT INTO dbo.promotion_events(event_id, version_id, bot_profile, ts, event_type, stage, status, discrepancy_score, promotion_confidence, approval_required, approved_by, notes, context_json)
VALUES(@event_id, @version_id, @bot_profile, @ts, @event_type, @stage, @status, @discrepancy_score, @promotion_confidence, @approval_required, @approved_by, @notes, @context_json)
`);
    }
  }

  async getLatestStateSnapshot({ snapshotKind = null } = {}) {
    if (!this.isEnabled()) return { ok: false, reason: 'sql_disabled' };
    const pool = await getPool(this.logger);
    if (!pool) return { ok: false, reason: 'no_pool' };
    await ensureSchema(this.logger);

    const req = pool.request();
    req.input('bot_profile', sql.NVarChar(20), this.botProfile);
    if (snapshotKind) {
      req.input('snapshot_kind', sql.NVarChar(30), String(snapshotKind).slice(0, 30));
    }
    const whereKind = snapshotKind ? 'AND snapshot_kind = @snapshot_kind' : '';
    const res = await req.query(`
SELECT TOP 1 snapshot_id, run_id, bot_profile, snapshot_kind, ts, state_json, market_state_json, stats_json
FROM dbo.bot_state_snapshots
WHERE bot_profile = @bot_profile
  ${whereKind}
ORDER BY ts DESC
`);
    const row = res.recordset?.[0];
    if (!row) return { ok: true, found: false };

    let state = null;
    let marketState = null;
    let stats = null;
    try { state = row.state_json ? JSON.parse(row.state_json) : null; } catch {}
    try { marketState = row.market_state_json ? JSON.parse(row.market_state_json) : null; } catch {}
    try { stats = row.stats_json ? JSON.parse(row.stats_json) : null; } catch {}

    return {
      ok: true,
      found: true,
      snapshotId: row.snapshot_id,
      runId: row.run_id,
      botProfile: row.bot_profile,
      snapshotKind: row.snapshot_kind,
      ts: row.ts,
      state,
      marketState,
      stats,
    };
  }

  async syncQueryableState(payload = {}) {
    if (!this.isEnabled()) return { ok: false, reason: 'sql_disabled' };
    const pool = await getPool(this.logger);
    if (!pool) return { ok: false, reason: 'no_pool' };
    await ensureSchema(this.logger);

    const tx = new sql.Transaction(pool);
    await tx.begin();
    try {
      const botProfile = this.botProfile;
      const memoryScope = String(payload.memoryScope || 'shared').slice(0, 40);
      const learning = payload.learning && typeof payload.learning === 'object' ? payload.learning : {};
      let agentMemory = payload.agentMemory && typeof payload.agentMemory === 'object' ? payload.agentMemory : {};
      const strategyBrain = payload.strategyBrain && typeof payload.strategyBrain === 'object' ? payload.strategyBrain : {};
      const intelligence = payload.intelligence && typeof payload.intelligence === 'object' ? payload.intelligence : null;
      const selfEvolutionHistory = Array.isArray(payload.selfEvolutionHistory) ? payload.selfEvolutionHistory : [];

      if (memoryScope === 'shared') {
        const sharedAgentMemory = await loadSharedAgentMemory(pool);
        if (sharedAgentMemory && typeof sharedAgentMemory === 'object') {
          agentMemory = sharedAgentMemory;
        }
      }

      const deleteByProfile = [
        'DELETE FROM dbo.learning_bad_token_memory WHERE bot_profile = @bot_profile',
        'DELETE FROM dbo.learning_sleeve_performance WHERE bot_profile = @bot_profile',
        'DELETE FROM dbo.learning_brain_profiles WHERE bot_profile = @bot_profile',
        'DELETE FROM dbo.strategy_brain_profiles WHERE bot_profile = @bot_profile',
        'DELETE FROM dbo.strategy_brain_adjustments WHERE bot_profile = @bot_profile',
        'DELETE FROM dbo.strategy_brain_mutations WHERE bot_profile = @bot_profile',
        'DELETE FROM dbo.strategy_brain_known_archetypes WHERE bot_profile = @bot_profile',
        'DELETE FROM dbo.intelligence_reports WHERE bot_profile = @bot_profile',
        'DELETE FROM dbo.self_evolution_history WHERE bot_profile = @bot_profile',
      ];
      const deleteByScope = [
        'DELETE FROM dbo.agent_trade_lessons WHERE memory_scope = @memory_scope',
        'DELETE FROM dbo.agent_strategy_discoveries WHERE memory_scope = @memory_scope',
        'DELETE FROM dbo.agent_token_blacklist WHERE memory_scope = @memory_scope',
        'DELETE FROM dbo.agent_token_preferences WHERE memory_scope = @memory_scope',
        'DELETE FROM dbo.agent_evolution_outcomes WHERE memory_scope = @memory_scope',
        'DELETE FROM dbo.agent_knowledge_base WHERE memory_scope = @memory_scope',
      ];

      for (const queryText of deleteByProfile) {
        const req = new sql.Request(tx);
        req.input('bot_profile', sql.NVarChar(20), botProfile);
        await req.query(queryText);
      }
      for (const queryText of deleteByScope) {
        const req = new sql.Request(tx);
        req.input('memory_scope', sql.NVarChar(40), memoryScope);
        await req.query(queryText);
      }

      for (const [tokenKey, record] of Object.entries(learning.badTokenMemory || {})) {
        const req = new sql.Request(tx);
        req.input('bot_profile', sql.NVarChar(20), botProfile);
        req.input('token_key', sql.NVarChar(160), String(tokenKey).slice(0, 160));
        req.input('chain_key', sql.NVarChar(30), record?.chainKey ? String(record.chainKey).slice(0, 30) : null);
        req.input('symbol', sql.NVarChar(40), record?.symbol ? String(record.symbol).slice(0, 40) : null);
        req.input('address', sql.NVarChar(120), record?.address ? String(record.address).slice(0, 120) : null);
        req.input('strikes', sql.Int, Number.isFinite(Number(record?.strikes)) ? Number(record.strikes) : null);
        req.input('hard_ban', sql.Bit, Boolean(record?.hardBan));
        req.input('first_seen', sql.DateTime2(3), toDateOrNull(record?.firstSeen));
        req.input('last_seen', sql.DateTime2(3), toDateOrNull(record?.lastSeen));
        req.input('ban_until', sql.DateTime2(3), toDateOrNull(record?.banUntil));
        req.input('last_reason', sql.NVarChar(240), record?.lastReason ? String(record.lastReason).slice(0, 240) : null);
        req.input('reasons_json', sql.NVarChar(sql.MAX), safeJson(record?.reasons, 8000));
        await req.query('INSERT INTO dbo.learning_bad_token_memory(bot_profile, token_key, chain_key, symbol, address, strikes, hard_ban, first_seen, last_seen, ban_until, last_reason, reasons_json) VALUES (@bot_profile, @token_key, @chain_key, @symbol, @address, @strikes, @hard_ban, @first_seen, @last_seen, @ban_until, @last_reason, @reasons_json)');
      }

      for (const [sleeveKey, sleeve] of Object.entries(learning.sleevePerformance || {})) {
        const parts = String(sleeveKey).split(':');
        const req = new sql.Request(tx);
        req.input('bot_profile', sql.NVarChar(20), botProfile);
        req.input('sleeve_key', sql.NVarChar(120), String(sleeveKey).slice(0, 120));
        req.input('chain_key', sql.NVarChar(30), parts[0] ? String(parts[0]).slice(0, 30) : null);
        req.input('strategy', sql.NVarChar(30), parts[1] ? String(parts[1]).slice(0, 30) : null);
        req.input('recent_win_rate_pct', sql.Float, Number.isFinite(Number(sleeve?.recentWinRatePct)) ? Number(sleeve.recentWinRatePct) : null);
        req.input('size_multiplier', sql.Float, Number.isFinite(Number(sleeve?.sizeMultiplier)) ? Number(sleeve.sizeMultiplier) : null);
        req.input('total_closed', sql.Int, Number.isFinite(Number(sleeve?.totalClosed)) ? Number(sleeve.totalClosed) : null);
        req.input('wins', sql.Int, Number.isFinite(Number(sleeve?.wins)) ? Number(sleeve.wins) : null);
        req.input('losses', sql.Int, Number.isFinite(Number(sleeve?.losses)) ? Number(sleeve.losses) : null);
        req.input('outcomes_json', sql.NVarChar(sql.MAX), safeJson(sleeve?.outcomes, 8000));
        req.input('last_updated', sql.DateTime2(3), toDateOrNull(sleeve?.lastUpdated));
        await req.query('INSERT INTO dbo.learning_sleeve_performance(bot_profile, sleeve_key, chain_key, strategy, recent_win_rate_pct, size_multiplier, total_closed, wins, losses, outcomes_json, last_updated) VALUES (@bot_profile, @sleeve_key, @chain_key, @strategy, @recent_win_rate_pct, @size_multiplier, @total_closed, @wins, @losses, @outcomes_json, @last_updated)');
      }

      for (const [profileKey, profile] of Object.entries(learning.brainProfiles || {})) {
        const req = new sql.Request(tx);
        req.input('bot_profile', sql.NVarChar(20), botProfile);
        req.input('profile_key', sql.NVarChar(160), String(profileKey).slice(0, 160));
        req.input('chain_key', sql.NVarChar(30), profile?.chainKey ? String(profile.chainKey).slice(0, 30) : null);
        req.input('strategy', sql.NVarChar(30), profile?.strategy ? String(profile.strategy).slice(0, 30) : null);
        req.input('lane', sql.NVarChar(40), profile?.lane ? String(profile.lane).slice(0, 40) : null);
        req.input('trigger_name', sql.NVarChar(40), profile?.trigger ? String(profile.trigger).slice(0, 40) : null);
        req.input('samples', sql.Int, Number.isFinite(Number(profile?.samples)) ? Number(profile.samples) : null);
        req.input('wins', sql.Int, Number.isFinite(Number(profile?.wins)) ? Number(profile.wins) : null);
        req.input('losses', sql.Int, Number.isFinite(Number(profile?.losses)) ? Number(profile.losses) : null);
        req.input('total_pnl', sql.Float, Number.isFinite(Number(profile?.totalPnl)) ? Number(profile.totalPnl) : null);
        req.input('recent_win_rate_pct', sql.Float, Number.isFinite(Number(profile?.recentWinRatePct)) ? Number(profile.recentWinRatePct) : null);
        req.input('avg_recent_pnl_usd', sql.Float, Number.isFinite(Number(profile?.avgRecentPnlUsd)) ? Number(profile.avgRecentPnlUsd) : null);
        req.input('recent_outcomes_json', sql.NVarChar(sql.MAX), safeJson(profile?.recentOutcomes, 8000));
        req.input('recent_pnl_json', sql.NVarChar(sql.MAX), safeJson(profile?.recentPnl, 8000));
        req.input('last_updated', sql.DateTime2(3), toDateOrNull(profile?.lastUpdated));
        await req.query('INSERT INTO dbo.learning_brain_profiles(bot_profile, profile_key, chain_key, strategy, lane, trigger_name, samples, wins, losses, total_pnl, recent_win_rate_pct, avg_recent_pnl_usd, recent_outcomes_json, recent_pnl_json, last_updated) VALUES (@bot_profile, @profile_key, @chain_key, @strategy, @lane, @trigger_name, @samples, @wins, @losses, @total_pnl, @recent_win_rate_pct, @avg_recent_pnl_usd, @recent_outcomes_json, @recent_pnl_json, @last_updated)');
      }

      for (const [profileKey, profile] of Object.entries(strategyBrain.profiles || {})) {
        const parts = String(profileKey).split(':');
        const req = new sql.Request(tx);
        req.input('bot_profile', sql.NVarChar(20), botProfile);
        req.input('profile_key', sql.NVarChar(160), String(profileKey).slice(0, 160));
        req.input('chain_key', sql.NVarChar(30), parts[0] ? String(parts[0]).slice(0, 30) : null);
        req.input('strategy', sql.NVarChar(30), parts[1] ? String(parts[1]).slice(0, 30) : null);
        req.input('archetype', sql.NVarChar(80), parts.slice(2).join(':').slice(0, 80) || null);
        req.input('samples', sql.Int, Number.isFinite(Number(profile?.samples)) ? Number(profile.samples) : null);
        req.input('wins', sql.Int, Number.isFinite(Number(profile?.wins)) ? Number(profile.wins) : null);
        req.input('losses', sql.Int, Number.isFinite(Number(profile?.losses)) ? Number(profile.losses) : null);
        req.input('total_pnl', sql.Float, Number.isFinite(Number(profile?.totalPnl)) ? Number(profile.totalPnl) : null);
        req.input('recent_win_rate_pct', sql.Float, Number.isFinite(Number(profile?.recentWinRatePct)) ? Number(profile.recentWinRatePct) : null);
        req.input('recent_outcomes_json', sql.NVarChar(sql.MAX), safeJson(profile?.recentOutcomes, 8000));
        req.input('recent_pnl_json', sql.NVarChar(sql.MAX), safeJson(profile?.recentPnl, 8000));
        req.input('updated_at', sql.DateTime2(3), toDateOrNull(profile?.updatedAt));
        await req.query('INSERT INTO dbo.strategy_brain_profiles(bot_profile, profile_key, chain_key, strategy, archetype, samples, wins, losses, total_pnl, recent_win_rate_pct, recent_outcomes_json, recent_pnl_json, updated_at) VALUES (@bot_profile, @profile_key, @chain_key, @strategy, @archetype, @samples, @wins, @losses, @total_pnl, @recent_win_rate_pct, @recent_outcomes_json, @recent_pnl_json, @updated_at)');
      }

      for (const [adjustmentKey, adjustment] of Object.entries(strategyBrain.adjustments || {})) {
        const parts = String(adjustmentKey).split(':');
        const req = new sql.Request(tx);
        req.input('bot_profile', sql.NVarChar(20), botProfile);
        req.input('adjustment_key', sql.NVarChar(120), String(adjustmentKey).slice(0, 120));
        req.input('chain_key', sql.NVarChar(30), parts[0] ? String(parts[0]).slice(0, 30) : null);
        req.input('strategy', sql.NVarChar(30), parts[1] ? String(parts[1]).slice(0, 30) : null);
        req.input('rsi_buy_threshold_delta', sql.Float, Number.isFinite(Number(adjustment?.rsiBuyThresholdDelta)) ? Number(adjustment.rsiBuyThresholdDelta) : null);
        req.input('rsi_buy_max_threshold_delta', sql.Float, Number.isFinite(Number(adjustment?.rsiBuyMaxThresholdDelta)) ? Number(adjustment.rsiBuyMaxThresholdDelta) : null);
        req.input('volume_spike_multiplier_delta', sql.Float, Number.isFinite(Number(adjustment?.volumeSpikeMultiplierDelta)) ? Number(adjustment.volumeSpikeMultiplierDelta) : null);
        req.input('min_price_change_24h_pct_all_delta', sql.Float, Number.isFinite(Number(adjustment?.minPriceChange24hPctAllDelta)) ? Number(adjustment.minPriceChange24hPctAllDelta) : null);
        req.input('max_price_change_24h_pct_all_delta', sql.Float, Number.isFinite(Number(adjustment?.maxPriceChange24hPctAllDelta)) ? Number(adjustment.maxPriceChange24hPctAllDelta) : null);
        req.input('updated_at', sql.DateTime2(3), toDateOrNull(adjustment?.updatedAt));
        await req.query('INSERT INTO dbo.strategy_brain_adjustments(bot_profile, adjustment_key, chain_key, strategy, rsi_buy_threshold_delta, rsi_buy_max_threshold_delta, volume_spike_multiplier_delta, min_price_change_24h_pct_all_delta, max_price_change_24h_pct_all_delta, updated_at) VALUES (@bot_profile, @adjustment_key, @chain_key, @strategy, @rsi_buy_threshold_delta, @rsi_buy_max_threshold_delta, @volume_spike_multiplier_delta, @min_price_change_24h_pct_all_delta, @max_price_change_24h_pct_all_delta, @updated_at)');
      }

      for (const mutation of Array.isArray(strategyBrain.mutations) ? strategyBrain.mutations : []) {
        const req = new sql.Request(tx);
        req.input('mutation_id', sql.UniqueIdentifier, uuid());
        req.input('bot_profile', sql.NVarChar(20), botProfile);
        req.input('ts', sql.DateTime2(3), toDateOrNull(mutation?.timestamp) || new Date());
        req.input('adjustment_key', sql.NVarChar(120), mutation?.key ? String(mutation.key).slice(0, 120) : null);
        req.input('source_profile', sql.NVarChar(160), mutation?.sourceProfile ? String(mutation.sourceProfile).slice(0, 160) : null);
        req.input('recent_win_rate_pct', sql.Float, Number.isFinite(Number(mutation?.recentWinRatePct)) ? Number(mutation.recentWinRatePct) : null);
        req.input('adjustment_json', sql.NVarChar(sql.MAX), safeJson(mutation?.adjustment, 8000));
        await req.query('INSERT INTO dbo.strategy_brain_mutations(mutation_id, bot_profile, ts, adjustment_key, source_profile, recent_win_rate_pct, adjustment_json) VALUES (@mutation_id, @bot_profile, @ts, @adjustment_key, @source_profile, @recent_win_rate_pct, @adjustment_json)');
      }

      for (const archetype of Array.isArray(strategyBrain.knownArchetypes) ? strategyBrain.knownArchetypes : []) {
        const req = new sql.Request(tx);
        req.input('bot_profile', sql.NVarChar(20), botProfile);
        req.input('archetype', sql.NVarChar(80), String(archetype).slice(0, 80));
        await req.query('INSERT INTO dbo.strategy_brain_known_archetypes(bot_profile, archetype) VALUES (@bot_profile, @archetype)');
      }

      if (intelligence && intelligence.report) {
        const report = intelligence.report;
        const req = new sql.Request(tx);
        req.input('report_id', sql.UniqueIdentifier, uuid());
        req.input('bot_profile', sql.NVarChar(20), botProfile);
        req.input('ts', sql.DateTime2(3), toDateOrNull(intelligence.lastRunAt || report?._generatedAt) || new Date());
        req.input('run_count', sql.Int, Number.isFinite(Number(intelligence.runCount)) ? Number(intelligence.runCount) : null);
        req.input('synthesized_by', sql.NVarChar(80), report?._synthesizedBy ? String(report._synthesizedBy).slice(0, 80) : null);
        req.input('macro_sentiment', sql.NVarChar(30), report?.macroSentiment ? String(report.macroSentiment).slice(0, 30) : null);
        req.input('sentiment_score', sql.Float, Number.isFinite(Number(report?.sentimentScore)) ? Number(report.sentimentScore) : null);
        req.input('summary', sql.NVarChar(sql.MAX), report?.summary ? String(report.summary) : null);
        req.input('report_json', sql.NVarChar(sql.MAX), safeJson(report, 200000));
        await req.query('INSERT INTO dbo.intelligence_reports(report_id, bot_profile, ts, run_count, synthesized_by, macro_sentiment, sentiment_score, summary, report_json) VALUES (@report_id, @bot_profile, @ts, @run_count, @synthesized_by, @macro_sentiment, @sentiment_score, @summary, @report_json)');
      }

      for (const lesson of Array.isArray(agentMemory.tradeLessons) ? agentMemory.tradeLessons : []) {
        const req = new sql.Request(tx);
        req.input('lesson_id', sql.NVarChar(80), String(lesson?.id || '').slice(0, 80));
        req.input('memory_scope', sql.NVarChar(40), memoryScope);
        req.input('ts', sql.DateTime2(3), toDateOrNull(lesson?.ts) || new Date());
        req.input('symbol', sql.NVarChar(40), lesson?.symbol ? String(lesson.symbol).slice(0, 40) : null);
        req.input('chain_key', sql.NVarChar(30), lesson?.chain ? String(lesson.chain).slice(0, 30) : null);
        req.input('strategy', sql.NVarChar(30), lesson?.strategy ? String(lesson.strategy).slice(0, 30) : null);
        req.input('outcome', sql.NVarChar(12), lesson?.outcome ? String(lesson.outcome).slice(0, 12) : null);
        req.input('pnl_usd', sql.Float, Number.isFinite(Number(lesson?.pnlUsd)) ? Number(lesson.pnlUsd) : null);
        req.input('pnl_pct', sql.Float, Number.isFinite(Number(lesson?.pnlPct)) ? Number(lesson.pnlPct) : null);
        req.input('reason', sql.NVarChar(400), lesson?.reason ? String(lesson.reason).slice(0, 400) : null);
        req.input('lesson_text', sql.NVarChar(sql.MAX), lesson?.lesson ? String(lesson.lesson) : null);
        req.input('hit_count', sql.Int, Number.isFinite(Number(lesson?.hitCount)) ? Number(lesson.hitCount) : null);
        req.input('entry_conditions_json', sql.NVarChar(sql.MAX), safeJson(lesson?.entryConditions, 20000));
        req.input('bot_profile', sql.NVarChar(20), lesson?.botProfile ? String(lesson.botProfile).slice(0, 20) : null);
        await req.query('INSERT INTO dbo.agent_trade_lessons(lesson_id, memory_scope, ts, symbol, chain_key, strategy, outcome, pnl_usd, pnl_pct, reason, lesson_text, hit_count, entry_conditions_json, bot_profile) VALUES (@lesson_id, @memory_scope, @ts, @symbol, @chain_key, @strategy, @outcome, @pnl_usd, @pnl_pct, @reason, @lesson_text, @hit_count, @entry_conditions_json, @bot_profile)');
      }

      for (const discovery of Array.isArray(agentMemory.strategyDiscoveries) ? agentMemory.strategyDiscoveries : []) {
        const req = new sql.Request(tx);
        req.input('discovery_id', sql.NVarChar(80), String(discovery?.id || '').slice(0, 80));
        req.input('memory_scope', sql.NVarChar(40), memoryScope);
        req.input('ts', sql.DateTime2(3), toDateOrNull(discovery?.ts) || new Date());
        req.input('source', sql.NVarChar(120), discovery?.source ? String(discovery.source).slice(0, 120) : null);
        req.input('theme', sql.NVarChar(120), discovery?.theme ? String(discovery.theme).slice(0, 120) : null);
        req.input('sector', sql.NVarChar(120), discovery?.sector ? String(discovery.sector).slice(0, 120) : null);
        req.input('insight', sql.NVarChar(sql.MAX), discovery?.insight ? String(discovery.insight) : null);
        req.input('proposed_action', sql.NVarChar(sql.MAX), discovery?.proposedAction ? String(discovery.proposedAction) : null);
        req.input('urgency', sql.NVarChar(12), discovery?.urgency ? String(discovery.urgency).slice(0, 12) : null);
        req.input('applied', sql.Bit, Boolean(discovery?.applied));
        req.input('applied_at', sql.DateTime2(3), toDateOrNull(discovery?.appliedAt));
        await req.query('INSERT INTO dbo.agent_strategy_discoveries(discovery_id, memory_scope, ts, source, theme, sector, insight, proposed_action, urgency, applied, applied_at) VALUES (@discovery_id, @memory_scope, @ts, @source, @theme, @sector, @insight, @proposed_action, @urgency, @applied, @applied_at)');
      }

      for (const [symbol, entry] of Object.entries(agentMemory.tokenBlacklist || {})) {
        const req = new sql.Request(tx);
        req.input('memory_scope', sql.NVarChar(40), memoryScope);
        req.input('symbol', sql.NVarChar(40), String(symbol).slice(0, 40));
        req.input('reason', sql.NVarChar(400), entry?.reason ? String(entry.reason).slice(0, 400) : null);
        req.input('source', sql.NVarChar(80), entry?.source ? String(entry.source).slice(0, 80) : null);
        req.input('added_at', sql.DateTime2(3), toDateOrNull(entry?.addedAt));
        req.input('expires_at', sql.DateTime2(3), toDateOrNull(entry?.expiresAt));
        await req.query('INSERT INTO dbo.agent_token_blacklist(memory_scope, symbol, reason, source, added_at, expires_at) VALUES (@memory_scope, @symbol, @reason, @source, @added_at, @expires_at)');
      }

      for (const [symbol, entry] of Object.entries(agentMemory.tokenPreferences || {})) {
        const req = new sql.Request(tx);
        req.input('memory_scope', sql.NVarChar(40), memoryScope);
        req.input('symbol', sql.NVarChar(40), String(symbol).slice(0, 40));
        req.input('boost', sql.Float, Number.isFinite(Number(entry?.boost)) ? Number(entry.boost) : null);
        req.input('reason', sql.NVarChar(400), entry?.reason ? String(entry.reason).slice(0, 400) : null);
        req.input('research_summary', sql.NVarChar(sql.MAX), entry?.researchSummary ? String(entry.researchSummary) : null);
        req.input('added_at', sql.DateTime2(3), toDateOrNull(entry?.addedAt));
        req.input('expires_at', sql.DateTime2(3), toDateOrNull(entry?.expiresAt));
        await req.query('INSERT INTO dbo.agent_token_preferences(memory_scope, symbol, boost, reason, research_summary, added_at, expires_at) VALUES (@memory_scope, @symbol, @boost, @reason, @research_summary, @added_at, @expires_at)');
      }

      for (const outcome of Array.isArray(agentMemory.evolutionOutcomes) ? agentMemory.evolutionOutcomes : []) {
        const req = new sql.Request(tx);
        req.input('outcome_id', sql.UniqueIdentifier, uuid());
        req.input('memory_scope', sql.NVarChar(40), memoryScope);
        req.input('ts', sql.DateTime2(3), toDateOrNull(outcome?.ts) || new Date());
        req.input('patch_summary', sql.NVarChar(400), outcome?.patchSummary ? String(outcome.patchSummary).slice(0, 400) : null);
        req.input('pf_before', sql.Float, Number.isFinite(Number(outcome?.pfBefore)) ? Number(outcome.pfBefore) : null);
        req.input('pf_after', sql.Float, Number.isFinite(Number(outcome?.pfAfter)) ? Number(outcome.pfAfter) : null);
        req.input('wr_before', sql.Float, Number.isFinite(Number(outcome?.wrBefore)) ? Number(outcome.wrBefore) : null);
        req.input('wr_after', sql.Float, Number.isFinite(Number(outcome?.wrAfter)) ? Number(outcome.wrAfter) : null);
        req.input('verdict', sql.NVarChar(40), outcome?.verdict ? String(outcome.verdict).slice(0, 40) : null);
        await req.query('INSERT INTO dbo.agent_evolution_outcomes(outcome_id, memory_scope, ts, patch_summary, pf_before, pf_after, wr_before, wr_after, verdict) VALUES (@outcome_id, @memory_scope, @ts, @patch_summary, @pf_before, @pf_after, @wr_before, @wr_after, @verdict)');
      }

      for (const knowledge of Array.isArray(agentMemory.knowledgeBase) ? agentMemory.knowledgeBase : []) {
        const req = new sql.Request(tx);
        req.input('knowledge_id', sql.UniqueIdentifier, uuid());
        req.input('memory_scope', sql.NVarChar(40), memoryScope);
        req.input('ts', sql.DateTime2(3), toDateOrNull(knowledge?.ts) || new Date());
        req.input('category', sql.NVarChar(80), knowledge?.category ? String(knowledge.category).slice(0, 80) : null);
        req.input('insight', sql.NVarChar(sql.MAX), knowledge?.insight ? String(knowledge.insight) : null);
        req.input('source', sql.NVarChar(120), knowledge?.source ? String(knowledge.source).slice(0, 120) : null);
        req.input('confidence', sql.Float, Number.isFinite(Number(knowledge?.confidence)) ? Number(knowledge.confidence) : null);
        await req.query('INSERT INTO dbo.agent_knowledge_base(knowledge_id, memory_scope, ts, category, insight, source, confidence) VALUES (@knowledge_id, @memory_scope, @ts, @category, @insight, @source, @confidence)');
      }

      for (const entry of selfEvolutionHistory) {
        const req = new sql.Request(tx);
        req.input('history_id', sql.UniqueIdentifier, uuid());
        req.input('bot_profile', sql.NVarChar(20), botProfile);
        req.input('ts', sql.DateTime2(3), toDateOrNull(entry?.ts) || new Date());
        req.input('status', sql.NVarChar(40), entry?.status ? String(entry.status).slice(0, 40) : null);
        req.input('summary', sql.NVarChar(sql.MAX), entry?.summary ? String(entry.summary) : null);
        req.input('reason', sql.NVarChar(sql.MAX), entry?.reason ? String(entry.reason) : null);
        req.input('proposal_path', sql.NVarChar(400), entry?.proposalPath ? String(entry.proposalPath).slice(0, 400) : null);
        req.input('raw_entry_json', sql.NVarChar(sql.MAX), safeJson(entry, 20000));
        await req.query('INSERT INTO dbo.self_evolution_history(history_id, bot_profile, ts, status, summary, reason, proposal_path, raw_entry_json) VALUES (@history_id, @bot_profile, @ts, @status, @summary, @reason, @proposal_path, @raw_entry_json)');
      }

      await tx.commit();
      return { ok: true };
    } catch (error) {
      await tx.rollback().catch((rollbackErr) => this.logger.warn(`[SQL] syncQueryableState rollback failed: ${rollbackErr?.message || rollbackErr}`));
      this.logger.warn(`[SQL] syncQueryableState failed: ${error.message}`);
      return { ok: false, reason: error.message };
    }
  }
}
 
 module.exports = { SqlTelemetry, uuid, safeJson, parseSqlJson };
