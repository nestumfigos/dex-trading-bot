'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getPool, ensureSchema, sql } = require('../src/utils/sqlServer');
const { SqlTelemetry } = require('../src/utils/sqlTelemetry');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const PAPER_ROOT = process.env.PAPER_WORKTREE_PATH || path.resolve(PROJECT_ROOT, '..', 'dex-trading-bot-paper');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readJsonIfExists(filePath, fallback = null) {
  try {
    return readJson(filePath);
  } catch {
    return fallback;
  }
}

function readJsonlIfExists(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function guidFromText(text) {
  const hex = crypto.createHash('md5').update(String(text)).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function toDate(value) {
  const date = new Date(value || Date.now());
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function mergeSharedMemory(memories = []) {
  const merged = {
    version: 2,
    tradeLessons: [],
    strategyDiscoveries: [],
    tokenBlacklist: {},
    tokenPreferences: {},
    evolutionOutcomes: [],
    knowledgeBase: [],
  };

  const lessonMap = new Map();
  const discoveryMap = new Map();
  const knowledgeMap = new Map();

  for (const memory of memories) {
    if (!memory || typeof memory !== 'object') continue;

    for (const item of Array.isArray(memory.tradeLessons) ? memory.tradeLessons : []) {
      const id = String(item?.id || `${item?.symbol || 'x'}:${item?.ts || 0}`);
      const prev = lessonMap.get(id);
      if (!prev || Number(item?.ts || 0) >= Number(prev?.ts || 0)) lessonMap.set(id, item);
    }
    for (const item of Array.isArray(memory.strategyDiscoveries) ? memory.strategyDiscoveries : []) {
      const id = String(item?.id || `${item?.theme || 'x'}:${item?.ts || 0}`);
      const prev = discoveryMap.get(id);
      if (!prev || Number(item?.ts || 0) >= Number(prev?.ts || 0)) discoveryMap.set(id, item);
    }
    for (const item of Array.isArray(memory.knowledgeBase) ? memory.knowledgeBase : []) {
      const id = `${item?.category || 'general'}:${item?.insight || ''}:${item?.ts || 0}`;
      if (!knowledgeMap.has(id)) knowledgeMap.set(id, item);
    }

    for (const [symbol, entry] of Object.entries(memory.tokenBlacklist || {})) {
      const prev = merged.tokenBlacklist[symbol];
      if (!prev || Number(entry?.addedAt || 0) >= Number(prev?.addedAt || 0)) merged.tokenBlacklist[symbol] = entry;
    }
    for (const [symbol, entry] of Object.entries(memory.tokenPreferences || {})) {
      const prev = merged.tokenPreferences[symbol];
      if (!prev || Number(entry?.addedAt || 0) >= Number(prev?.addedAt || 0)) merged.tokenPreferences[symbol] = entry;
    }

    merged.evolutionOutcomes.push(...(Array.isArray(memory.evolutionOutcomes) ? memory.evolutionOutcomes : []));
  }

  merged.tradeLessons = Array.from(lessonMap.values()).sort((a, b) => Number(b?.ts || 0) - Number(a?.ts || 0));
  merged.strategyDiscoveries = Array.from(discoveryMap.values()).sort((a, b) => Number(b?.ts || 0) - Number(a?.ts || 0));
  merged.knowledgeBase = Array.from(knowledgeMap.values()).sort((a, b) => Number(b?.ts || 0) - Number(a?.ts || 0));
  merged.evolutionOutcomes = merged.evolutionOutcomes
    .sort((a, b) => Number(b?.ts || 0) - Number(a?.ts || 0))
    .slice(0, 200);
  return merged;
}

async function clearProfileTables(tx, profile) {
  const deletes = [
    'DELETE FROM dbo.bot_trade_ledger WHERE bot_profile = @bot_profile',
    'DELETE FROM dbo.bot_pnl_history WHERE bot_profile = @bot_profile',
    'DELETE FROM dbo.position_snapshots WHERE position_id IN (SELECT position_id FROM dbo.positions WHERE bot_profile = @bot_profile)',
    'DELETE FROM dbo.positions WHERE bot_profile = @bot_profile',
    'DELETE FROM dbo.bot_state_snapshots WHERE bot_profile = @bot_profile',
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
  for (const queryText of deletes) {
    const req = new sql.Request(tx);
    req.input('bot_profile', sql.NVarChar(20), profile);
    await req.query(queryText);
  }
}

async function backfillProfile(pool, profile, rootDir, sharedMemory) {
  const statePath = path.join(rootDir, 'data', 'state.json');
  const marketStatePath = path.join(rootDir, 'data', 'marketState.json');
  const memoryPath = path.join(rootDir, 'data', 'agent-memory.json');
  const evolutionPath = path.join(rootDir, 'data', 'self-evolution-history.jsonl');

  const state = readJson(statePath);
  const marketState = readJsonIfExists(marketStatePath, {});
  const memory = readJsonIfExists(memoryPath, {});
  const selfEvolutionHistory = readJsonlIfExists(evolutionPath);
  const portfolio = state.portfolio || {};

  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    await clearProfileTables(tx, profile);

    const trades = Array.isArray(portfolio.trades) ? portfolio.trades : [];
    for (let index = 0; index < trades.length; index += 1) {
      const trade = trades[index];
      const tradeId = guidFromText(`${profile}:trade:${trade?.timestamp || index}:${trade?.symbol || ''}:${trade?.type || ''}:${trade?.txid || index}`);

      const tradeReq = new sql.Request(tx);
      tradeReq.input('trade_id', sql.UniqueIdentifier, tradeId);
      tradeReq.input('bot_profile', sql.NVarChar(20), profile);
      tradeReq.input('ts', sql.DateTime2(3), toDate(trade?.timestamp));
      tradeReq.input('trade_type', sql.NVarChar(20), String(trade?.type || 'UNKNOWN').slice(0, 20));
      tradeReq.input('symbol', sql.NVarChar(40), trade?.symbol ? String(trade.symbol).slice(0, 40) : null);
      tradeReq.input('chain', sql.NVarChar(30), trade?.chain ? String(trade.chain).slice(0, 30) : null);
      tradeReq.input('chain_key', sql.NVarChar(30), trade?.chainKey ? String(trade.chainKey).slice(0, 30) : null);
      tradeReq.input('strategy', sql.NVarChar(30), trade?.strategy ? String(trade.strategy).slice(0, 30) : null);
      tradeReq.input('address', sql.NVarChar(120), trade?.address ? String(trade.address).slice(0, 120) : null);
      tradeReq.input('price', sql.Float, Number.isFinite(Number(trade?.price)) ? Number(trade.price) : null);
      tradeReq.input('quantity', sql.Float, Number.isFinite(Number(trade?.quantity)) ? Number(trade.quantity) : null);
      tradeReq.input('value_usd', sql.Float, Number.isFinite(Number(trade?.valueUsd)) ? Number(trade.valueUsd) : null);
      tradeReq.input('pnl_usd', sql.Float, Number.isFinite(Number(trade?.pnl)) ? Number(trade.pnl) : null);
      tradeReq.input('txid', sql.NVarChar(200), trade?.txid ? String(trade.txid).slice(0, 200) : null);
      tradeReq.input('signal_source', sql.NVarChar(80), trade?.signalSource ? String(trade.signalSource).slice(0, 80) : null);
      tradeReq.input('reason', sql.NVarChar(200), trade?.reason ? String(trade.reason).slice(0, 200) : null);
      tradeReq.input('raw_trade_json', sql.NVarChar(sql.MAX), JSON.stringify(trade));
      await tradeReq.query(`
INSERT INTO dbo.bot_trade_ledger(
  trade_id, bot_profile, ts, trade_type, symbol, chain, chain_key, strategy, address, price, quantity, value_usd, pnl_usd, txid, signal_source, reason, raw_trade_json
)
VALUES (
  @trade_id, @bot_profile, @ts, @trade_type, @symbol, @chain, @chain_key, @strategy, @address, @price, @quantity, @value_usd, @pnl_usd, @txid, @signal_source, @reason, @raw_trade_json
)
`);
    }

    const pnlHistory = Array.isArray(portfolio.pnlHistory) ? portfolio.pnlHistory : [];
    for (let index = 0; index < pnlHistory.length; index += 1) {
      const point = pnlHistory[index];
      const req = new sql.Request(tx);
      req.input('pnl_point_id', sql.UniqueIdentifier, guidFromText(`${profile}:pnl:${point?.timestamp || index}:${index}`));
      req.input('bot_profile', sql.NVarChar(20), profile);
      req.input('ts', sql.DateTime2(3), toDate(point?.timestamp));
      req.input('cash', sql.Float, Number.isFinite(Number(point?.cash)) ? Number(point.cash) : null);
      req.input('equity', sql.Float, Number.isFinite(Number(point?.equity)) ? Number(point.equity) : null);
      req.input('total_pnl', sql.Float, Number.isFinite(Number(point?.totalPnl)) ? Number(point.totalPnl) : null);
      req.input('unrealized_pnl', sql.Float, Number.isFinite(Number(point?.unrealizedPnl)) ? Number(point.unrealizedPnl) : null);
      req.input('reason', sql.NVarChar(80), point?.reason ? String(point.reason).slice(0, 80) : null);
      await req.query(`
INSERT INTO dbo.bot_pnl_history(
  pnl_point_id, bot_profile, ts, cash, equity, total_pnl, unrealized_pnl, reason
)
VALUES (
  @pnl_point_id, @bot_profile, @ts, @cash, @equity, @total_pnl, @unrealized_pnl, @reason
)
`);
    }

    for (const [key, position] of Object.entries(portfolio.positions || {})) {
      const positionId = guidFromText(`${profile}:position:${key}`);
      const req = new sql.Request(tx);
      req.input('position_id', sql.UniqueIdentifier, positionId);
      req.input('run_id', sql.UniqueIdentifier, null);
      req.input('bot_profile', sql.NVarChar(20), profile);
      req.input('chain', sql.NVarChar(30), position?.chain ? String(position.chain).slice(0, 30) : null);
      req.input('chain_key', sql.NVarChar(30), position?.chainKey ? String(position.chainKey).slice(0, 30) : null);
      req.input('symbol', sql.NVarChar(40), position?.symbol ? String(position.symbol).slice(0, 40) : null);
      req.input('address', sql.NVarChar(120), position?.address ? String(position.address).slice(0, 120) : null);
      req.input('strategy', sql.NVarChar(30), position?.strategy ? String(position.strategy).slice(0, 30) : null);
      req.input('opened_at', sql.DateTime2(3), toDate(position?.openedAt));
      req.input('entry_price', sql.Float, Number.isFinite(Number(position?.entryPrice)) ? Number(position.entryPrice) : null);
      req.input('entry_usd', sql.Float, Number.isFinite(Number(position?.costBasisUsd || position?.initialSizeUsd)) ? Number(position.costBasisUsd || position.initialSizeUsd) : null);
      req.input('tags_json', sql.NVarChar(sql.MAX), JSON.stringify(position));
      await req.query(`
INSERT INTO dbo.positions(position_id, run_id, bot_profile, chain, chain_key, symbol, address, strategy, opened_at, entry_price, entry_usd, tags_json)
VALUES (@position_id, @run_id, @bot_profile, @chain, @chain_key, @symbol, @address, @strategy, @opened_at, @entry_price, @entry_usd, @tags_json)
`);

      const snapReq = new sql.Request(tx);
      snapReq.input('snapshot_id', sql.UniqueIdentifier, guidFromText(`${profile}:position-snap:${key}`));
      snapReq.input('position_id', sql.UniqueIdentifier, positionId);
      snapReq.input('ts', sql.DateTime2(3), toDate(position?.lastSeenAt || position?.openedAt));
      snapReq.input('price', sql.Float, Number.isFinite(Number(position?.currentPrice)) ? Number(position.currentPrice) : null);
      snapReq.input('unrealized_pnl_usd', sql.Float, Number.isFinite(Number(position?.realizedPnl)) ? Number(position.realizedPnl) : null);
      snapReq.input('highest_price', sql.Float, Number.isFinite(Number(position?.highestPrice)) ? Number(position.highestPrice) : null);
      snapReq.input('trailing_stop', sql.Float, Number.isFinite(Number(position?.trailingStop)) ? Number(position.trailingStop) : null);
      snapReq.input('risk_state_json', sql.NVarChar(sql.MAX), JSON.stringify({
        stopLoss: position?.stopLoss || null,
        takeProfit: position?.takeProfit || null,
        triggerTimeframe: position?.triggerTimeframe || null,
      }));
      await snapReq.query(`
INSERT INTO dbo.position_snapshots(snapshot_id, position_id, ts, price, unrealized_pnl_usd, highest_price, trailing_stop, risk_state_json)
VALUES (@snapshot_id, @position_id, @ts, @price, @unrealized_pnl_usd, @highest_price, @trailing_stop, @risk_state_json)
`);
    }

    const snapshotReq = new sql.Request(tx);
    snapshotReq.input('snapshot_id', sql.UniqueIdentifier, guidFromText(`${profile}:backfill-snapshot`));
    snapshotReq.input('run_id', sql.UniqueIdentifier, null);
    snapshotReq.input('bot_profile', sql.NVarChar(20), profile);
    snapshotReq.input('snapshot_kind', sql.NVarChar(30), 'backfill');
    snapshotReq.input('ts', sql.DateTime2(3), new Date());
    snapshotReq.input('state_json', sql.NVarChar(sql.MAX), JSON.stringify(state));
    snapshotReq.input('market_state_json', sql.NVarChar(sql.MAX), JSON.stringify(marketState));
    snapshotReq.input('stats_json', sql.NVarChar(sql.MAX), JSON.stringify({
      backfilledAt: new Date().toISOString(),
      sourceRoot: rootDir,
      trades: trades.length,
      positions: Object.keys(portfolio.positions || {}).length,
      pnlHistory: pnlHistory.length,
    }));
    await snapshotReq.query(`
INSERT INTO dbo.bot_state_snapshots(snapshot_id, run_id, bot_profile, snapshot_kind, ts, state_json, market_state_json, stats_json)
VALUES (@snapshot_id, @run_id, @bot_profile, @snapshot_kind, @ts, @state_json, @market_state_json, @stats_json)
`);

    const runReq = new sql.Request(tx);
    runReq.input('run_id', sql.UniqueIdentifier, guidFromText(`${profile}:backfill-run`));
    runReq.input('bot_profile', sql.NVarChar(20), profile);
    runReq.input('host', sql.NVarChar(120), 'backfill');
    runReq.input('pid', sql.Int, process.pid);
    runReq.input('git_sha', sql.NVarChar(80), 'backfill');
    runReq.input('config_hash', sql.NVarChar(80), 'backfill');
    runReq.input('meta_json', sql.NVarChar(sql.MAX), JSON.stringify({ sourceRoot: rootDir, importedAt: new Date().toISOString() }));
    await runReq.query(`
MERGE dbo.bot_runs WITH (HOLDLOCK) AS t
USING (SELECT @run_id AS run_id) AS s
ON t.run_id = s.run_id
WHEN MATCHED THEN
  UPDATE SET bot_profile=@bot_profile, host=@host, pid=@pid, git_sha=@git_sha, config_hash=@config_hash, meta_json=@meta_json, started_at=SYSUTCDATETIME()
WHEN NOT MATCHED THEN
  INSERT (run_id, bot_profile, host, pid, git_sha, config_hash, meta_json, started_at)
  VALUES (@run_id, @bot_profile, @host, @pid, @git_sha, @config_hash, @meta_json, SYSUTCDATETIME());
`);

    await tx.commit();

    const telemetry = new SqlTelemetry({ logger: console, botProfile: profile });
    await telemetry.syncQueryableState({
      memoryScope: 'shared',
      learning: portfolio.learning || {},
      agentMemory: sharedMemory,
      strategyBrain: portfolio.learning?.strategyBrain || {},
      intelligence: portfolio.intelligence || null,
      selfEvolutionHistory,
    });

    return {
      profile,
      trades: trades.length,
      positions: Object.keys(portfolio.positions || {}).length,
      pnlHistory: pnlHistory.length,
      discoveries: (memory.strategyDiscoveries || []).length,
    };
  } catch (error) {
    await tx.rollback().catch(() => {});
    throw error;
  }
}

(async () => {
  process.env.SQL_ENABLED = 'true';
  const pool = await getPool(console);
  if (!pool) throw new Error('SQL pool unavailable');
  await ensureSchema(console);

  const liveMemory = readJsonIfExists(path.join(PROJECT_ROOT, 'data', 'agent-memory.json'), {});
  const paperMemory = readJsonIfExists(path.join(PAPER_ROOT, 'data', 'agent-memory.json'), {});
  const sharedMemory = mergeSharedMemory([liveMemory, paperMemory]);

  const live = await backfillProfile(pool, 'live', PROJECT_ROOT, sharedMemory);
  const paper = await backfillProfile(pool, 'paper', PAPER_ROOT, sharedMemory);

  console.log('[SQL] Backfill complete');
  console.log(JSON.stringify({ live, paper }, null, 2));
  await pool.close();
})().catch((error) => {
  console.error('[SQL] Backfill failed', error);
  process.exit(1);
});
