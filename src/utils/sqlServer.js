'use strict';

const sql = require('mssql');

let poolPromise = null;
let schemaEnsured = false;
const sqlBackoff = { nextRetryAfterMs: 0, currentDelayMs: 1000 };
let lastStatus = {
  enabled: false,
  connected: false,
  schemaReady: false,
  databaseName: null,
  databaseExplicit: false,
  lastError: null,
  lastCheckedAt: null,
};

function isSqlEnabled() {
  return String(process.env.SQL_ENABLED || '').toLowerCase() === 'true';
}

function getConnectionString() {
  return String(process.env.SQL_CONNECTION_STRING || '').trim();
}

function hasExplicitDatabase(connectionString = getConnectionString()) {
  return /(?:^|;)\s*(database|initial catalog)\s*=/i.test(String(connectionString || ''));
}

function updateStatus(patch = {}) {
  lastStatus = {
    ...lastStatus,
    enabled: isSqlEnabled(),
    lastCheckedAt: new Date().toISOString(),
    ...patch,
  };
}

function getSqlStatus() {
  return { ...lastStatus };
}

async function getPool(logger = console) {
  if (!isSqlEnabled()) {
    updateStatus({
      connected: false,
      schemaReady: false,
      databaseExplicit: hasExplicitDatabase(),
      lastError: null,
    });
    return null;
  }

  const conn = getConnectionString();
  if (!conn) {
    const lastError = 'SQL_ENABLED=true but SQL_CONNECTION_STRING is empty';
    logger.warn('[SQL] SQL_ENABLED=true but SQL_CONNECTION_STRING is empty; SQL features disabled.');
    updateStatus({
      connected: false,
      schemaReady: false,
      databaseExplicit: false,
      lastError,
    });
    return null;
  }

  if (!poolPromise) {
    if (Date.now() < sqlBackoff.nextRetryAfterMs) {
      const waitSec = Math.ceil((sqlBackoff.nextRetryAfterMs - Date.now()) / 1000);
      logger.debug(`[SQL] Reconnect suppressed by backoff — retrying in ~${waitSec}s`);
      return null;
    }

    poolPromise = sql.connect(conn).then((pool) => {
      sqlBackoff.currentDelayMs = 1000;
      sqlBackoff.nextRetryAfterMs = 0;
      return pool;
    }).catch((err) => {
      poolPromise = null;
      schemaEnsured = false;
      sqlBackoff.nextRetryAfterMs = Date.now() + sqlBackoff.currentDelayMs;
      sqlBackoff.currentDelayMs = Math.min(sqlBackoff.currentDelayMs * 2, 60_000);
      logger.warn(`[SQL] Connection failed (next retry in ${sqlBackoff.currentDelayMs / 1000}s): ${err.message}`);
      updateStatus({
        connected: false,
        schemaReady: false,
        databaseExplicit: hasExplicitDatabase(conn),
        lastError: err.message,
      });
      throw err;
    });
  }

  const pool = await poolPromise;
  let databaseName = null;
  try {
    const res = await pool.request().query('SELECT DB_NAME() AS database_name');
    databaseName = res.recordset?.[0]?.database_name || null;
  } catch {
    databaseName = null;
  }

  updateStatus({
    connected: true,
    databaseName,
    databaseExplicit: hasExplicitDatabase(conn),
    lastError: null,
  });
  return pool;
}

function getSchemaDdl() {
  return `
IF OBJECT_ID('dbo.bot_kv', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.bot_kv (
    [k] NVARCHAR(200) NOT NULL PRIMARY KEY,
    [v] NVARCHAR(MAX) NULL,
    [updated_at] DATETIME2(3) NOT NULL CONSTRAINT DF_bot_kv_updated_at DEFAULT (SYSUTCDATETIME()),
    [ver] ROWVERSION NOT NULL
  );
END;

IF OBJECT_ID('dbo.bot_locks', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.bot_locks (
    [resource] NVARCHAR(200) NOT NULL PRIMARY KEY,
    [owner] NVARCHAR(80) NOT NULL,
    [acquired_at] DATETIME2(3) NOT NULL CONSTRAINT DF_bot_locks_acquired_at DEFAULT (SYSUTCDATETIME()),
    [expires_at] DATETIME2(3) NOT NULL,
    [updated_at] DATETIME2(3) NOT NULL CONSTRAINT DF_bot_locks_updated_at DEFAULT (SYSUTCDATETIME())
  );
END;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_bot_locks_expires_at' AND object_id = OBJECT_ID('dbo.bot_locks'))
BEGIN
  CREATE INDEX IX_bot_locks_expires_at ON dbo.bot_locks(expires_at);
END;

IF OBJECT_ID('dbo.bot_runs', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.bot_runs (
    run_id UNIQUEIDENTIFIER NOT NULL PRIMARY KEY,
    bot_profile NVARCHAR(20) NOT NULL,
    host NVARCHAR(120) NULL,
    pid INT NULL,
    git_sha NVARCHAR(80) NULL,
    config_hash NVARCHAR(80) NULL,
    meta_json NVARCHAR(MAX) NULL,
    started_at DATETIME2(3) NOT NULL CONSTRAINT DF_bot_runs_started_at DEFAULT (SYSUTCDATETIME()),
    ended_at DATETIME2(3) NULL,
    exit_reason NVARCHAR(200) NULL
  );
END;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_bot_runs_started_at' AND object_id = OBJECT_ID('dbo.bot_runs'))
BEGIN
  CREATE INDEX IX_bot_runs_started_at ON dbo.bot_runs(started_at DESC);
END;

IF OBJECT_ID('dbo.signals', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.signals (
    signal_id UNIQUEIDENTIFIER NOT NULL PRIMARY KEY,
    run_id UNIQUEIDENTIFIER NULL,
    ts DATETIME2(3) NOT NULL,
    bot_profile NVARCHAR(20) NOT NULL,
    chain NVARCHAR(30) NULL,
    chain_key NVARCHAR(30) NULL,
    symbol NVARCHAR(40) NULL,
    address NVARCHAR(120) NULL,
    strategy NVARCHAR(30) NULL,
    final_signal NVARCHAR(30) NULL,
    technical_signal NVARCHAR(30) NULL,
    signal_source NVARCHAR(80) NULL,
    confidence FLOAT NULL,
    ai_confidence FLOAT NULL,
    ai_reason NVARCHAR(400) NULL,
    risk_flags_json NVARCHAR(MAX) NULL,
    features_json NVARCHAR(MAX) NULL,
    gate_json NVARCHAR(MAX) NULL,
    reject_reasons_json NVARCHAR(MAX) NULL
  );
END;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_signals_ts' AND object_id = OBJECT_ID('dbo.signals'))
BEGIN
  CREATE INDEX IX_signals_ts ON dbo.signals(ts DESC);
END;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_signals_chain_strategy_signal' AND object_id = OBJECT_ID('dbo.signals'))
BEGIN
  CREATE INDEX IX_signals_chain_strategy_signal ON dbo.signals(chain_key, strategy, final_signal, ts DESC);
END;

IF OBJECT_ID('dbo.orders', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.orders (
    order_id UNIQUEIDENTIFIER NOT NULL PRIMARY KEY,
    run_id UNIQUEIDENTIFIER NULL,
    ts DATETIME2(3) NOT NULL,
    bot_profile NVARCHAR(20) NOT NULL,
    chain NVARCHAR(30) NULL,
    chain_key NVARCHAR(30) NULL,
    symbol NVARCHAR(40) NULL,
    address NVARCHAR(120) NULL,
    side NVARCHAR(10) NOT NULL,
    strategy NVARCHAR(30) NULL,
    requested_quote_usd FLOAT NULL,
    requested_base_qty FLOAT NULL,
    expected_price FLOAT NULL,
    status NVARCHAR(30) NOT NULL,
    reason NVARCHAR(200) NULL,
    error_text NVARCHAR(800) NULL,
    client_order_key NVARCHAR(120) NULL,
    metadata_json NVARCHAR(MAX) NULL
  );
END;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_orders_run_ts' AND object_id = OBJECT_ID('dbo.orders'))
BEGIN
  CREATE INDEX IX_orders_run_ts ON dbo.orders(run_id, ts DESC);
END;

IF OBJECT_ID('dbo.fills', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.fills (
    fill_id UNIQUEIDENTIFIER NOT NULL PRIMARY KEY,
    order_id UNIQUEIDENTIFIER NOT NULL,
    ts DATETIME2(3) NOT NULL,
    txid_or_exchange_id NVARCHAR(200) NULL,
    filled_base_qty FLOAT NULL,
    filled_quote_usd FLOAT NULL,
    avg_price FLOAT NULL,
    fee_usd FLOAT NULL,
    slippage_bps FLOAT NULL,
    block_number BIGINT NULL,
    confirmations INT NULL,
    raw_receipt_json NVARCHAR(MAX) NULL
  );
END;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_fills_order_ts' AND object_id = OBJECT_ID('dbo.fills'))
BEGIN
  CREATE INDEX IX_fills_order_ts ON dbo.fills(order_id, ts DESC);
END;

IF OBJECT_ID('dbo.positions', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.positions (
    position_id UNIQUEIDENTIFIER NOT NULL PRIMARY KEY,
    run_id UNIQUEIDENTIFIER NULL,
    bot_profile NVARCHAR(20) NOT NULL,
    chain NVARCHAR(30) NULL,
    chain_key NVARCHAR(30) NULL,
    symbol NVARCHAR(40) NULL,
    address NVARCHAR(120) NULL,
    strategy NVARCHAR(30) NULL,
    opened_at DATETIME2(3) NOT NULL,
    closed_at DATETIME2(3) NULL,
    entry_price FLOAT NULL,
    entry_usd FLOAT NULL,
    exit_price FLOAT NULL,
    exit_usd FLOAT NULL,
    pnl_usd FLOAT NULL,
    pnl_pct FLOAT NULL,
    exit_reason NVARCHAR(200) NULL,
    tags_json NVARCHAR(MAX) NULL
  );
END;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_positions_run_opened' AND object_id = OBJECT_ID('dbo.positions'))
BEGIN
  CREATE INDEX IX_positions_run_opened ON dbo.positions(run_id, opened_at DESC);
END;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_positions_open_chain' AND object_id = OBJECT_ID('dbo.positions'))
BEGIN
  CREATE INDEX IX_positions_open_chain ON dbo.positions(chain_key, strategy, closed_at, opened_at DESC);
END;

IF OBJECT_ID('dbo.position_snapshots', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.position_snapshots (
    snapshot_id UNIQUEIDENTIFIER NOT NULL PRIMARY KEY,
    position_id UNIQUEIDENTIFIER NOT NULL,
    ts DATETIME2(3) NOT NULL,
    price FLOAT NULL,
    unrealized_pnl_usd FLOAT NULL,
    highest_price FLOAT NULL,
    trailing_stop FLOAT NULL,
    risk_state_json NVARCHAR(MAX) NULL
  );
END;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_position_snapshots_position_ts' AND object_id = OBJECT_ID('dbo.position_snapshots'))
BEGIN
  CREATE INDEX IX_position_snapshots_position_ts ON dbo.position_snapshots(position_id, ts DESC);
END;

IF OBJECT_ID('dbo.ops_events', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.ops_events (
    event_id UNIQUEIDENTIFIER NOT NULL PRIMARY KEY,
    run_id UNIQUEIDENTIFIER NULL,
    bot_profile NVARCHAR(20) NOT NULL,
    ts DATETIME2(3) NOT NULL,
    severity NVARCHAR(12) NOT NULL,
    category NVARCHAR(40) NOT NULL,
    name NVARCHAR(80) NOT NULL,
    chain_key NVARCHAR(30) NULL,
    symbol NVARCHAR(40) NULL,
    duration_ms INT NULL,
    context_json NVARCHAR(MAX) NULL,
    message NVARCHAR(800) NULL
  );
END;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_ops_events_ts' AND object_id = OBJECT_ID('dbo.ops_events'))
BEGIN
  CREATE INDEX IX_ops_events_ts ON dbo.ops_events(ts DESC);
END;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_ops_events_severity_category' AND object_id = OBJECT_ID('dbo.ops_events'))
BEGIN
  CREATE INDEX IX_ops_events_severity_category ON dbo.ops_events(severity, category, ts DESC);
END;

IF OBJECT_ID('dbo.bot_state_snapshots', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.bot_state_snapshots (
    snapshot_id UNIQUEIDENTIFIER NOT NULL PRIMARY KEY,
    run_id UNIQUEIDENTIFIER NULL,
    bot_profile NVARCHAR(20) NOT NULL,
    snapshot_kind NVARCHAR(30) NOT NULL,
    ts DATETIME2(3) NOT NULL CONSTRAINT DF_bot_state_snapshots_ts DEFAULT (SYSUTCDATETIME()),
    state_json NVARCHAR(MAX) NOT NULL,
    market_state_json NVARCHAR(MAX) NULL,
    stats_json NVARCHAR(MAX) NULL
  );
END;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_bot_state_snapshots_profile_kind_ts' AND object_id = OBJECT_ID('dbo.bot_state_snapshots'))
BEGIN
  CREATE INDEX IX_bot_state_snapshots_profile_kind_ts ON dbo.bot_state_snapshots(bot_profile, snapshot_kind, ts DESC);
END;

IF OBJECT_ID('dbo.bot_trade_ledger', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.bot_trade_ledger (
    trade_id UNIQUEIDENTIFIER NOT NULL PRIMARY KEY,
    bot_profile NVARCHAR(20) NOT NULL,
    ts DATETIME2(3) NOT NULL,
    trade_type NVARCHAR(20) NOT NULL,
    symbol NVARCHAR(40) NULL,
    chain NVARCHAR(30) NULL,
    chain_key NVARCHAR(30) NULL,
    strategy NVARCHAR(30) NULL,
    address NVARCHAR(120) NULL,
    price FLOAT NULL,
    quantity FLOAT NULL,
    value_usd FLOAT NULL,
    pnl_usd FLOAT NULL,
    txid NVARCHAR(200) NULL,
    signal_source NVARCHAR(80) NULL,
    reason NVARCHAR(200) NULL,
    exit_category NVARCHAR(60) NULL,
    setup_type NVARCHAR(40) NULL,
    raw_trade_json NVARCHAR(MAX) NULL
  );
END;
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.bot_trade_ledger') AND name = 'exit_category')
BEGIN
  ALTER TABLE dbo.bot_trade_ledger ADD exit_category NVARCHAR(60) NULL;
END;
IF COL_LENGTH('dbo.bot_trade_ledger', 'setup_type') IS NULL
BEGIN
  ALTER TABLE dbo.bot_trade_ledger ADD setup_type NVARCHAR(40) NULL;
END;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_bot_trade_ledger_profile_ts' AND object_id = OBJECT_ID('dbo.bot_trade_ledger'))
BEGIN
  CREATE INDEX IX_bot_trade_ledger_profile_ts ON dbo.bot_trade_ledger(bot_profile, ts DESC);
END;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_bot_trade_ledger_symbol_chain_ts' AND object_id = OBJECT_ID('dbo.bot_trade_ledger'))
BEGIN
  CREATE INDEX IX_bot_trade_ledger_symbol_chain_ts ON dbo.bot_trade_ledger(symbol, chain_key, ts DESC);
END;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_bot_trade_ledger_setup_type_ts' AND object_id = OBJECT_ID('dbo.bot_trade_ledger'))
BEGIN
  CREATE INDEX IX_bot_trade_ledger_setup_type_ts
    ON dbo.bot_trade_ledger(bot_profile, setup_type, ts DESC)
    INCLUDE (trade_type, symbol, chain_key, strategy, pnl_usd)
    WHERE setup_type IS NOT NULL;
END;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_ops_events_run' AND object_id = OBJECT_ID('dbo.ops_events'))
BEGIN
  CREATE INDEX IX_ops_events_run ON dbo.ops_events(run_id, ts DESC);
END;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_decision_log_run' AND object_id = OBJECT_ID('dbo.decision_log'))
BEGIN
  CREATE INDEX IX_decision_log_run ON dbo.decision_log(run_id, ts DESC);
END;

IF OBJECT_ID('dbo.bot_pnl_history', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.bot_pnl_history (
    pnl_point_id UNIQUEIDENTIFIER NOT NULL PRIMARY KEY,
    bot_profile NVARCHAR(20) NOT NULL,
    ts DATETIME2(3) NOT NULL,
    cash FLOAT NULL,
    equity FLOAT NULL,
    total_pnl FLOAT NULL,
    unrealized_pnl FLOAT NULL,
    reason NVARCHAR(80) NULL
  );
END;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_bot_pnl_history_profile_ts' AND object_id = OBJECT_ID('dbo.bot_pnl_history'))
BEGIN
  CREATE INDEX IX_bot_pnl_history_profile_ts ON dbo.bot_pnl_history(bot_profile, ts DESC);
END;

IF OBJECT_ID('dbo.decision_log', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.decision_log (
    decision_id UNIQUEIDENTIFIER NOT NULL PRIMARY KEY,
    run_id UNIQUEIDENTIFIER NULL,
    bot_profile NVARCHAR(20) NOT NULL,
    ts DATETIME2(3) NOT NULL,
    chain NVARCHAR(30) NULL,
    chain_key NVARCHAR(30) NULL,
    symbol NVARCHAR(40) NULL,
    address NVARCHAR(120) NULL,
    strategy NVARCHAR(30) NULL,
    signal_source NVARCHAR(80) NULL,
    decision_stage NVARCHAR(30) NOT NULL,
    proposal_json NVARCHAR(MAX) NULL,
    risk_json NVARCHAR(MAX) NULL,
    approval_json NVARCHAR(MAX) NULL,
    final_action NVARCHAR(30) NULL,
    approved BIT NOT NULL CONSTRAINT DF_decision_log_approved DEFAULT (0),
    confidence FLOAT NULL,
    ai_confidence FLOAT NULL,
    reason NVARCHAR(800) NULL,
    order_id UNIQUEIDENTIFIER NULL,
    position_id UNIQUEIDENTIFIER NULL,
    status NVARCHAR(30) NULL
  );
END;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_decision_log_profile_ts' AND object_id = OBJECT_ID('dbo.decision_log'))
BEGIN
  CREATE INDEX IX_decision_log_profile_ts ON dbo.decision_log(bot_profile, ts DESC);
END;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_decision_log_symbol_stage' AND object_id = OBJECT_ID('dbo.decision_log'))
BEGIN
  CREATE INDEX IX_decision_log_symbol_stage ON dbo.decision_log(chain_key, symbol, decision_stage, ts DESC);
END;

IF OBJECT_ID('dbo.decision_reflections', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.decision_reflections (
    reflection_id UNIQUEIDENTIFIER NOT NULL PRIMARY KEY,
    decision_id UNIQUEIDENTIFIER NULL,
    bot_profile NVARCHAR(20) NOT NULL,
    ts DATETIME2(3) NOT NULL,
    chain_key NVARCHAR(30) NULL,
    symbol NVARCHAR(40) NULL,
    strategy NVARCHAR(30) NULL,
    outcome NVARCHAR(20) NULL,
    pnl_usd FLOAT NULL,
    pnl_pct FLOAT NULL,
    hold_duration_hours FLOAT NULL,
    reflection_json NVARCHAR(MAX) NULL,
    summary NVARCHAR(MAX) NULL
  );
END;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_decision_reflections_profile_ts' AND object_id = OBJECT_ID('dbo.decision_reflections'))
BEGIN
  CREATE INDEX IX_decision_reflections_profile_ts ON dbo.decision_reflections(bot_profile, ts DESC);
END;
IF COL_LENGTH('dbo.decision_log', 'strategy_version_id') IS NULL
BEGIN
  ALTER TABLE dbo.decision_log ADD strategy_version_id NVARCHAR(80) NULL;
END;
IF COL_LENGTH('dbo.decision_log', 'regime_label') IS NULL
BEGIN
  ALTER TABLE dbo.decision_log ADD regime_label NVARCHAR(40) NULL;
END;
IF COL_LENGTH('dbo.decision_log', 'promotion_stage') IS NULL
BEGIN
  ALTER TABLE dbo.decision_log ADD promotion_stage NVARCHAR(30) NULL;
END;
IF COL_LENGTH('dbo.decision_reflections', 'strategy_version_id') IS NULL
BEGIN
  ALTER TABLE dbo.decision_reflections ADD strategy_version_id NVARCHAR(80) NULL;
END;
IF COL_LENGTH('dbo.decision_reflections', 'regime_label') IS NULL
BEGIN
  ALTER TABLE dbo.decision_reflections ADD regime_label NVARCHAR(40) NULL;
END;

IF OBJECT_ID('dbo.strategy_versions', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.strategy_versions (
    version_id NVARCHAR(80) NOT NULL PRIMARY KEY,
    version_hash NVARCHAR(80) NOT NULL,
    bot_profile NVARCHAR(20) NOT NULL,
    source_profile NVARCHAR(20) NULL,
    stage NVARCHAR(30) NOT NULL,
    created_at DATETIME2(3) NOT NULL CONSTRAINT DF_strategy_versions_created_at DEFAULT (SYSUTCDATETIME()),
    approved_at DATETIME2(3) NULL,
    activated_at DATETIME2(3) NULL,
    rollback_at DATETIME2(3) NULL,
    candidate_id NVARCHAR(80) NULL,
    config_hash NVARCHAR(80) NULL,
    code_hash NVARCHAR(80) NULL,
    parent_version_id NVARCHAR(80) NULL,
    metadata_json NVARCHAR(MAX) NULL
  );
END;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_strategy_versions_profile_stage' AND object_id = OBJECT_ID('dbo.strategy_versions'))
BEGIN
  CREATE INDEX IX_strategy_versions_profile_stage ON dbo.strategy_versions(bot_profile, stage, created_at DESC);
END;

IF OBJECT_ID('dbo.promotion_events', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.promotion_events (
    event_id UNIQUEIDENTIFIER NOT NULL PRIMARY KEY,
    version_id NVARCHAR(80) NOT NULL,
    bot_profile NVARCHAR(20) NOT NULL,
    ts DATETIME2(3) NOT NULL,
    event_type NVARCHAR(40) NOT NULL,
    stage NVARCHAR(30) NULL,
    status NVARCHAR(30) NULL,
    discrepancy_score FLOAT NULL,
    promotion_confidence FLOAT NULL,
    approval_required BIT NOT NULL CONSTRAINT DF_promotion_events_approval_required DEFAULT (0),
    approved_by NVARCHAR(80) NULL,
    notes NVARCHAR(800) NULL,
    context_json NVARCHAR(MAX) NULL
  );
END;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_promotion_events_version_ts' AND object_id = OBJECT_ID('dbo.promotion_events'))
BEGIN
  CREATE INDEX IX_promotion_events_version_ts ON dbo.promotion_events(version_id, ts DESC);
END;

IF OBJECT_ID('dbo.learning_bad_token_memory', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.learning_bad_token_memory (
    bot_profile NVARCHAR(20) NOT NULL,
    token_key NVARCHAR(160) NOT NULL,
    chain_key NVARCHAR(30) NULL,
    symbol NVARCHAR(40) NULL,
    address NVARCHAR(120) NULL,
    strikes INT NULL,
    hard_ban BIT NOT NULL CONSTRAINT DF_learning_bad_token_memory_hard_ban DEFAULT (0),
    first_seen DATETIME2(3) NULL,
    last_seen DATETIME2(3) NULL,
    ban_until DATETIME2(3) NULL,
    last_reason NVARCHAR(240) NULL,
    reasons_json NVARCHAR(MAX) NULL,
    updated_at DATETIME2(3) NOT NULL CONSTRAINT DF_learning_bad_token_memory_updated_at DEFAULT (SYSUTCDATETIME()),
    CONSTRAINT PK_learning_bad_token_memory PRIMARY KEY (bot_profile, token_key)
  );
END;

IF OBJECT_ID('dbo.learning_sleeve_performance', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.learning_sleeve_performance (
    bot_profile NVARCHAR(20) NOT NULL,
    sleeve_key NVARCHAR(120) NOT NULL,
    chain_key NVARCHAR(30) NULL,
    strategy NVARCHAR(30) NULL,
    recent_win_rate_pct FLOAT NULL,
    size_multiplier FLOAT NULL,
    total_closed INT NULL,
    wins INT NULL,
    losses INT NULL,
    outcomes_json NVARCHAR(MAX) NULL,
    last_updated DATETIME2(3) NULL,
    CONSTRAINT PK_learning_sleeve_performance PRIMARY KEY (bot_profile, sleeve_key)
  );
END;

IF OBJECT_ID('dbo.learning_brain_profiles', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.learning_brain_profiles (
    bot_profile NVARCHAR(20) NOT NULL,
    profile_key NVARCHAR(160) NOT NULL,
    chain_key NVARCHAR(30) NULL,
    strategy NVARCHAR(30) NULL,
    lane NVARCHAR(40) NULL,
    trigger_name NVARCHAR(40) NULL,
    samples INT NULL,
    wins INT NULL,
    losses INT NULL,
    total_pnl FLOAT NULL,
    recent_win_rate_pct FLOAT NULL,
    avg_recent_pnl_usd FLOAT NULL,
    recent_outcomes_json NVARCHAR(MAX) NULL,
    recent_pnl_json NVARCHAR(MAX) NULL,
    last_updated DATETIME2(3) NULL,
    CONSTRAINT PK_learning_brain_profiles PRIMARY KEY (bot_profile, profile_key)
  );
END;

IF OBJECT_ID('dbo.strategy_brain_profiles', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.strategy_brain_profiles (
    bot_profile NVARCHAR(20) NOT NULL,
    profile_key NVARCHAR(160) NOT NULL,
    chain_key NVARCHAR(30) NULL,
    strategy NVARCHAR(30) NULL,
    archetype NVARCHAR(80) NULL,
    samples INT NULL,
    wins INT NULL,
    losses INT NULL,
    total_pnl FLOAT NULL,
    recent_win_rate_pct FLOAT NULL,
    recent_outcomes_json NVARCHAR(MAX) NULL,
    recent_pnl_json NVARCHAR(MAX) NULL,
    updated_at DATETIME2(3) NULL,
    CONSTRAINT PK_strategy_brain_profiles PRIMARY KEY (bot_profile, profile_key)
  );
END;

IF OBJECT_ID('dbo.strategy_brain_adjustments', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.strategy_brain_adjustments (
    bot_profile NVARCHAR(20) NOT NULL,
    adjustment_key NVARCHAR(120) NOT NULL,
    chain_key NVARCHAR(30) NULL,
    strategy NVARCHAR(30) NULL,
    rsi_buy_threshold_delta FLOAT NULL,
    rsi_buy_max_threshold_delta FLOAT NULL,
    volume_spike_multiplier_delta FLOAT NULL,
    min_price_change_24h_pct_all_delta FLOAT NULL,
    max_price_change_24h_pct_all_delta FLOAT NULL,
    updated_at DATETIME2(3) NULL,
    CONSTRAINT PK_strategy_brain_adjustments PRIMARY KEY (bot_profile, adjustment_key)
  );
END;

IF OBJECT_ID('dbo.strategy_brain_mutations', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.strategy_brain_mutations (
    mutation_id UNIQUEIDENTIFIER NOT NULL PRIMARY KEY,
    bot_profile NVARCHAR(20) NOT NULL,
    ts DATETIME2(3) NOT NULL,
    adjustment_key NVARCHAR(120) NULL,
    source_profile NVARCHAR(160) NULL,
    recent_win_rate_pct FLOAT NULL,
    adjustment_json NVARCHAR(MAX) NULL
  );
END;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_strategy_brain_mutations_profile_ts' AND object_id = OBJECT_ID('dbo.strategy_brain_mutations'))
BEGIN
  CREATE INDEX IX_strategy_brain_mutations_profile_ts ON dbo.strategy_brain_mutations(bot_profile, ts DESC);
END;

IF OBJECT_ID('dbo.strategy_brain_known_archetypes', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.strategy_brain_known_archetypes (
    bot_profile NVARCHAR(20) NOT NULL,
    archetype NVARCHAR(80) NOT NULL,
    CONSTRAINT PK_strategy_brain_known_archetypes PRIMARY KEY (bot_profile, archetype)
  );
END;

IF OBJECT_ID('dbo.intelligence_reports', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.intelligence_reports (
    report_id UNIQUEIDENTIFIER NOT NULL PRIMARY KEY,
    bot_profile NVARCHAR(20) NOT NULL,
    ts DATETIME2(3) NOT NULL,
    run_count INT NULL,
    synthesized_by NVARCHAR(80) NULL,
    macro_sentiment NVARCHAR(30) NULL,
    sentiment_score FLOAT NULL,
    summary NVARCHAR(MAX) NULL,
    report_json NVARCHAR(MAX) NULL
  );
END;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_intelligence_reports_profile_ts' AND object_id = OBJECT_ID('dbo.intelligence_reports'))
BEGIN
  CREATE INDEX IX_intelligence_reports_profile_ts ON dbo.intelligence_reports(bot_profile, ts DESC);
END;

IF OBJECT_ID('dbo.agent_trade_lessons', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.agent_trade_lessons (
    lesson_id NVARCHAR(80) NOT NULL PRIMARY KEY,
    memory_scope NVARCHAR(40) NOT NULL,
    ts DATETIME2(3) NOT NULL,
    symbol NVARCHAR(40) NULL,
    chain_key NVARCHAR(30) NULL,
    strategy NVARCHAR(30) NULL,
    outcome NVARCHAR(12) NULL,
    pnl_usd FLOAT NULL,
    pnl_pct FLOAT NULL,
    reason NVARCHAR(400) NULL,
    lesson_text NVARCHAR(MAX) NULL,
    hit_count INT NULL,
    entry_conditions_json NVARCHAR(MAX) NULL
  );
END;

IF COL_LENGTH('dbo.agent_trade_lessons', 'bot_profile') IS NULL
BEGIN
  ALTER TABLE dbo.agent_trade_lessons ADD bot_profile NVARCHAR(20) NULL;
END;

IF OBJECT_ID('dbo.agent_strategy_discoveries', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.agent_strategy_discoveries (
    discovery_id NVARCHAR(80) NOT NULL PRIMARY KEY,
    memory_scope NVARCHAR(40) NOT NULL,
    ts DATETIME2(3) NOT NULL,
    source NVARCHAR(120) NULL,
    theme NVARCHAR(120) NULL,
    sector NVARCHAR(120) NULL,
    insight NVARCHAR(MAX) NULL,
    proposed_action NVARCHAR(MAX) NULL,
    urgency NVARCHAR(12) NULL,
    applied BIT NOT NULL CONSTRAINT DF_agent_strategy_discoveries_applied DEFAULT (0),
    applied_at DATETIME2(3) NULL
  );
END;

IF OBJECT_ID('dbo.agent_token_blacklist', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.agent_token_blacklist (
    memory_scope NVARCHAR(40) NOT NULL,
    symbol NVARCHAR(40) NOT NULL,
    reason NVARCHAR(400) NULL,
    source NVARCHAR(80) NULL,
    added_at DATETIME2(3) NULL,
    expires_at DATETIME2(3) NULL,
    CONSTRAINT PK_agent_token_blacklist PRIMARY KEY (memory_scope, symbol)
  );
END;

IF OBJECT_ID('dbo.agent_token_preferences', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.agent_token_preferences (
    memory_scope NVARCHAR(40) NOT NULL,
    symbol NVARCHAR(40) NOT NULL,
    boost FLOAT NULL,
    reason NVARCHAR(400) NULL,
    research_summary NVARCHAR(MAX) NULL,
    added_at DATETIME2(3) NULL,
    expires_at DATETIME2(3) NULL,
    CONSTRAINT PK_agent_token_preferences PRIMARY KEY (memory_scope, symbol)
  );
END;

IF OBJECT_ID('dbo.agent_evolution_outcomes', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.agent_evolution_outcomes (
    outcome_id UNIQUEIDENTIFIER NOT NULL PRIMARY KEY,
    memory_scope NVARCHAR(40) NOT NULL,
    ts DATETIME2(3) NOT NULL,
    patch_summary NVARCHAR(400) NULL,
    pf_before FLOAT NULL,
    pf_after FLOAT NULL,
    wr_before FLOAT NULL,
    wr_after FLOAT NULL,
    verdict NVARCHAR(40) NULL
  );
END;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_agent_evolution_outcomes_scope_ts' AND object_id = OBJECT_ID('dbo.agent_evolution_outcomes'))
BEGIN
  CREATE INDEX IX_agent_evolution_outcomes_scope_ts ON dbo.agent_evolution_outcomes(memory_scope, ts DESC);
END;

IF OBJECT_ID('dbo.agent_knowledge_base', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.agent_knowledge_base (
    knowledge_id UNIQUEIDENTIFIER NOT NULL PRIMARY KEY,
    memory_scope NVARCHAR(40) NOT NULL,
    ts DATETIME2(3) NOT NULL,
    category NVARCHAR(80) NULL,
    insight NVARCHAR(MAX) NULL,
    source NVARCHAR(120) NULL,
    confidence FLOAT NULL
  );
END;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_agent_knowledge_base_scope_ts' AND object_id = OBJECT_ID('dbo.agent_knowledge_base'))
BEGIN
  CREATE INDEX IX_agent_knowledge_base_scope_ts ON dbo.agent_knowledge_base(memory_scope, ts DESC);
END;

IF OBJECT_ID('dbo.self_evolution_history', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.self_evolution_history (
    history_id UNIQUEIDENTIFIER NOT NULL PRIMARY KEY,
    bot_profile NVARCHAR(20) NOT NULL,
    ts DATETIME2(3) NOT NULL,
    status NVARCHAR(40) NULL,
    summary NVARCHAR(MAX) NULL,
    reason NVARCHAR(MAX) NULL,
    proposal_path NVARCHAR(400) NULL,
    raw_entry_json NVARCHAR(MAX) NULL
  );
END;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_self_evolution_history_profile_ts' AND object_id = OBJECT_ID('dbo.self_evolution_history'))
BEGIN
  CREATE INDEX IX_self_evolution_history_profile_ts ON dbo.self_evolution_history(bot_profile, ts DESC);
END;

EXEC('
CREATE OR ALTER VIEW dbo.vw_profile_summary AS
WITH trade_stats AS (
  SELECT
    bot_profile,
    COUNT(*) AS trade_count,
    SUM(CASE WHEN trade_type = ''SELL'' THEN 1 ELSE 0 END) AS sell_count,
    SUM(CASE WHEN trade_type = ''BUY'' THEN 1 ELSE 0 END) AS buy_count,
    SUM(CASE WHEN trade_type = ''SELL_FAILED'' THEN 1 ELSE 0 END) AS sell_failed_count,
    SUM(CASE WHEN pnl_usd > 0 THEN 1 ELSE 0 END) AS win_count,
    SUM(CASE WHEN pnl_usd < 0 THEN 1 ELSE 0 END) AS loss_count,
    SUM(COALESCE(pnl_usd, 0)) AS realized_pnl_usd,
    MAX(ts) AS last_trade_at
  FROM dbo.bot_trade_ledger
  GROUP BY bot_profile
),
position_stats AS (
  SELECT
    bot_profile,
    COUNT(*) AS open_positions,
    SUM(COALESCE(entry_usd, 0)) AS open_cost_basis_usd,
    MAX(opened_at) AS last_position_opened_at
  FROM dbo.positions
  WHERE closed_at IS NULL
  GROUP BY bot_profile
),
pnl_stats AS (
  SELECT
    bot_profile,
    MAX(ts) AS last_pnl_at,
    MAX(CASE WHEN rn = 1 THEN cash END) AS latest_cash,
    MAX(CASE WHEN rn = 1 THEN equity END) AS latest_equity,
    MAX(CASE WHEN rn = 1 THEN total_pnl END) AS latest_total_pnl,
    MAX(CASE WHEN rn = 1 THEN unrealized_pnl END) AS latest_unrealized_pnl
  FROM (
    SELECT *,
      ROW_NUMBER() OVER (PARTITION BY bot_profile ORDER BY ts DESC) AS rn
    FROM dbo.bot_pnl_history
  ) x
  GROUP BY bot_profile
),
run_stats AS (
  SELECT
    bot_profile,
    COUNT(*) AS run_count,
    MAX(started_at) AS last_run_started_at
  FROM dbo.bot_runs
  GROUP BY bot_profile
)
SELECT
  p.bot_profile,
  COALESCE(r.run_count, 0) AS run_count,
  r.last_run_started_at,
  COALESCE(t.trade_count, 0) AS trade_count,
  COALESCE(t.buy_count, 0) AS buy_count,
  COALESCE(t.sell_count, 0) AS sell_count,
  COALESCE(t.sell_failed_count, 0) AS sell_failed_count,
  COALESCE(t.win_count, 0) AS win_count,
  COALESCE(t.loss_count, 0) AS loss_count,
  CASE WHEN COALESCE(t.win_count, 0) + COALESCE(t.loss_count, 0) > 0
    THEN (CAST(t.win_count AS FLOAT) / CAST(t.win_count + t.loss_count AS FLOAT)) * 100
    ELSE NULL
  END AS win_rate_pct,
  COALESCE(t.realized_pnl_usd, 0) AS realized_pnl_usd,
  t.last_trade_at,
  COALESCE(ps.open_positions, 0) AS open_positions,
  COALESCE(ps.open_cost_basis_usd, 0) AS open_cost_basis_usd,
  ps.last_position_opened_at,
  pnl.latest_cash,
  pnl.latest_equity,
  pnl.latest_total_pnl,
  pnl.latest_unrealized_pnl,
  pnl.last_pnl_at
FROM (
  SELECT DISTINCT bot_profile FROM dbo.bot_runs
  UNION SELECT DISTINCT bot_profile FROM dbo.bot_trade_ledger
  UNION SELECT DISTINCT bot_profile FROM dbo.positions
  UNION SELECT DISTINCT bot_profile FROM dbo.bot_pnl_history
) p
LEFT JOIN run_stats r ON r.bot_profile = p.bot_profile
LEFT JOIN trade_stats t ON t.bot_profile = p.bot_profile
LEFT JOIN position_stats ps ON ps.bot_profile = p.bot_profile
LEFT JOIN pnl_stats pnl ON pnl.bot_profile = p.bot_profile;
');

EXEC('
CREATE OR ALTER VIEW dbo.vw_learning_summary AS
SELECT
  profiles.bot_profile,
  COALESCE(bad.bad_token_count, 0) AS bad_token_count,
  COALESCE(sleeves.sleeve_count, 0) AS sleeve_count,
  COALESCE(brains.learning_brain_profile_count, 0) AS learning_brain_profile_count,
  COALESCE(strat.strategy_brain_profile_count, 0) AS strategy_brain_profile_count,
  COALESCE(mut.strategy_brain_mutation_count, 0) AS strategy_brain_mutation_count,
  sleeves.avg_sleeve_win_rate_pct,
  sleeves.avg_size_multiplier,
  brains.avg_learning_brain_win_rate_pct,
  strat.avg_strategy_brain_win_rate_pct
FROM (
  SELECT DISTINCT bot_profile FROM dbo.learning_sleeve_performance
  UNION SELECT DISTINCT bot_profile FROM dbo.learning_brain_profiles
  UNION SELECT DISTINCT bot_profile FROM dbo.strategy_brain_profiles
  UNION SELECT DISTINCT bot_profile FROM dbo.learning_bad_token_memory
) profiles
LEFT JOIN (
  SELECT bot_profile, COUNT(*) AS bad_token_count
  FROM dbo.learning_bad_token_memory
  GROUP BY bot_profile
) bad ON bad.bot_profile = profiles.bot_profile
LEFT JOIN (
  SELECT bot_profile,
         COUNT(*) AS sleeve_count,
         AVG(recent_win_rate_pct) AS avg_sleeve_win_rate_pct,
         AVG(size_multiplier) AS avg_size_multiplier
  FROM dbo.learning_sleeve_performance
  GROUP BY bot_profile
) sleeves ON sleeves.bot_profile = profiles.bot_profile
LEFT JOIN (
  SELECT bot_profile,
         COUNT(*) AS learning_brain_profile_count,
         AVG(recent_win_rate_pct) AS avg_learning_brain_win_rate_pct
  FROM dbo.learning_brain_profiles
  GROUP BY bot_profile
) brains ON brains.bot_profile = profiles.bot_profile
LEFT JOIN (
  SELECT bot_profile,
         COUNT(*) AS strategy_brain_profile_count,
         AVG(recent_win_rate_pct) AS avg_strategy_brain_win_rate_pct
  FROM dbo.strategy_brain_profiles
  GROUP BY bot_profile
) strat ON strat.bot_profile = profiles.bot_profile
LEFT JOIN (
  SELECT bot_profile, COUNT(*) AS strategy_brain_mutation_count
  FROM dbo.strategy_brain_mutations
  GROUP BY bot_profile
) mut ON mut.bot_profile = profiles.bot_profile;
');

EXEC('
CREATE OR ALTER VIEW dbo.vw_latest_intelligence AS
WITH ranked AS (
  SELECT *,
    ROW_NUMBER() OVER (PARTITION BY bot_profile ORDER BY ts DESC) AS rn
  FROM dbo.intelligence_reports
)
SELECT
  bot_profile,
  ts,
  run_count,
  synthesized_by,
  macro_sentiment,
  sentiment_score,
  summary
FROM ranked
WHERE rn = 1;
');

EXEC('
CREATE OR ALTER VIEW dbo.vw_self_evolution_summary AS
SELECT
  bot_profile,
  COUNT(*) AS total_events,
  SUM(CASE WHEN status = ''applied'' THEN 1 ELSE 0 END) AS applied_count,
  SUM(CASE WHEN status = ''failed'' THEN 1 ELSE 0 END) AS failed_count,
  SUM(CASE WHEN status = ''proposed'' THEN 1 ELSE 0 END) AS proposed_count,
  SUM(CASE WHEN status = ''noop'' THEN 1 ELSE 0 END) AS noop_count,
  MAX(ts) AS last_event_at
FROM dbo.self_evolution_history
GROUP BY bot_profile;
');

EXEC('
CREATE OR ALTER VIEW dbo.vw_agent_memory_summary AS
SELECT
  scopes.memory_scope,
  COALESCE(lessons.lesson_count, 0) AS lesson_count,
  COALESCE(discoveries.discovery_count, 0) AS discovery_count,
  COALESCE(blacklist.blacklist_count, 0) AS blacklist_count,
  COALESCE(prefs.preference_count, 0) AS preference_count,
  COALESCE(knowledge.knowledge_count, 0) AS knowledge_count,
  COALESCE(evo.evolution_outcome_count, 0) AS evolution_outcome_count
FROM (
  SELECT DISTINCT memory_scope FROM dbo.agent_trade_lessons
  UNION SELECT DISTINCT memory_scope FROM dbo.agent_strategy_discoveries
  UNION SELECT DISTINCT memory_scope FROM dbo.agent_token_blacklist
  UNION SELECT DISTINCT memory_scope FROM dbo.agent_token_preferences
  UNION SELECT DISTINCT memory_scope FROM dbo.agent_knowledge_base
  UNION SELECT DISTINCT memory_scope FROM dbo.agent_evolution_outcomes
) scopes
LEFT JOIN (
  SELECT memory_scope, COUNT(*) AS lesson_count
  FROM dbo.agent_trade_lessons
  GROUP BY memory_scope
) lessons ON lessons.memory_scope = scopes.memory_scope
LEFT JOIN (
  SELECT memory_scope, COUNT(*) AS discovery_count
  FROM dbo.agent_strategy_discoveries
  GROUP BY memory_scope
) discoveries ON discoveries.memory_scope = scopes.memory_scope
LEFT JOIN (
  SELECT memory_scope, COUNT(*) AS blacklist_count
  FROM dbo.agent_token_blacklist
  GROUP BY memory_scope
) blacklist ON blacklist.memory_scope = scopes.memory_scope
LEFT JOIN (
  SELECT memory_scope, COUNT(*) AS preference_count
  FROM dbo.agent_token_preferences
  GROUP BY memory_scope
) prefs ON prefs.memory_scope = scopes.memory_scope
LEFT JOIN (
  SELECT memory_scope, COUNT(*) AS knowledge_count
  FROM dbo.agent_knowledge_base
  GROUP BY memory_scope
) knowledge ON knowledge.memory_scope = scopes.memory_scope
LEFT JOIN (
  SELECT memory_scope, COUNT(*) AS evolution_outcome_count
  FROM dbo.agent_evolution_outcomes
  GROUP BY memory_scope
) evo ON evo.memory_scope = scopes.memory_scope;
');

EXEC('
CREATE OR ALTER VIEW dbo.vw_chain_summary AS
SELECT
  bot_profile,
  COALESCE(chain_key, ''unknown'') AS chain_key,
  SUM(CASE WHEN trade_type = ''SELL'' THEN 1 ELSE 0 END) AS closed_trade_count,
  SUM(CASE WHEN trade_type = ''BUY'' THEN 1 ELSE 0 END) AS buy_count,
  SUM(CASE WHEN trade_type = ''SELL'' THEN 1 ELSE 0 END) AS sell_count,
  SUM(CASE WHEN trade_type = ''SELL_FAILED'' THEN 1 ELSE 0 END) AS sell_failed_count,
  SUM(CASE WHEN pnl_usd > 0 THEN 1 ELSE 0 END) AS win_count,
  SUM(CASE WHEN pnl_usd < 0 THEN 1 ELSE 0 END) AS loss_count,
  SUM(COALESCE(pnl_usd, 0)) AS realized_pnl_usd,
  MAX(ts) AS last_trade_at
FROM dbo.bot_trade_ledger
GROUP BY bot_profile, COALESCE(chain_key, ''unknown'');
');

EXEC('
CREATE OR ALTER VIEW dbo.vw_strategy_summary AS
SELECT
  bot_profile,
  COALESCE(strategy, ''unknown'') AS strategy,
  SUM(CASE WHEN trade_type = ''SELL'' THEN 1 ELSE 0 END) AS closed_trade_count,
  SUM(CASE WHEN trade_type = ''BUY'' THEN 1 ELSE 0 END) AS buy_count,
  SUM(CASE WHEN trade_type = ''SELL'' THEN 1 ELSE 0 END) AS sell_count,
  SUM(CASE WHEN trade_type = ''SELL_FAILED'' THEN 1 ELSE 0 END) AS sell_failed_count,
  SUM(CASE WHEN pnl_usd > 0 THEN 1 ELSE 0 END) AS win_count,
  SUM(CASE WHEN pnl_usd < 0 THEN 1 ELSE 0 END) AS loss_count,
  CASE WHEN SUM(CASE WHEN pnl_usd > 0 THEN 1 ELSE 0 END) + SUM(CASE WHEN pnl_usd < 0 THEN 1 ELSE 0 END) > 0
    THEN (
      CAST(SUM(CASE WHEN pnl_usd > 0 THEN 1 ELSE 0 END) AS FLOAT)
      / CAST(SUM(CASE WHEN pnl_usd > 0 THEN 1 ELSE 0 END) + SUM(CASE WHEN pnl_usd < 0 THEN 1 ELSE 0 END) AS FLOAT)
    ) * 100
    ELSE NULL
  END AS win_rate_pct,
  SUM(COALESCE(pnl_usd, 0)) AS realized_pnl_usd,
  MAX(ts) AS last_trade_at
FROM dbo.bot_trade_ledger
GROUP BY bot_profile, COALESCE(strategy, ''unknown'');
');

EXEC('
CREATE OR ALTER VIEW dbo.vw_latest_open_positions AS
SELECT
  p.bot_profile,
  p.position_id,
  p.chain,
  p.chain_key,
  p.symbol,
  p.address,
  p.strategy,
  p.opened_at,
  p.entry_price,
  p.entry_usd,
  p.tags_json,
  s.ts AS last_snapshot_at,
  s.price AS latest_price,
  s.unrealized_pnl_usd,
  s.highest_price,
  s.trailing_stop,
  s.risk_state_json
FROM dbo.positions p
OUTER APPLY (
  SELECT TOP 1 *
  FROM dbo.position_snapshots s
  WHERE s.position_id = p.position_id
  ORDER BY s.ts DESC
) s
WHERE p.closed_at IS NULL;
');

EXEC('
CREATE OR ALTER VIEW dbo.vw_latest_agent_lessons AS
WITH ranked AS (
  SELECT *,
    ROW_NUMBER() OVER (PARTITION BY memory_scope ORDER BY ts DESC, lesson_id DESC) AS rn
  FROM dbo.agent_trade_lessons
)
SELECT
  memory_scope,
  lesson_id,
  ts,
  symbol,
  chain_key,
  strategy,
  outcome,
  pnl_usd,
  pnl_pct,
  reason,
  lesson_text,
  hit_count
FROM ranked
WHERE rn <= 25;
');

EXEC('
CREATE OR ALTER VIEW dbo.vw_latest_agent_discoveries AS
WITH ranked AS (
  SELECT *,
    ROW_NUMBER() OVER (PARTITION BY memory_scope ORDER BY ts DESC, discovery_id DESC) AS rn
  FROM dbo.agent_strategy_discoveries
)
SELECT
  memory_scope,
  discovery_id,
  ts,
  source,
  theme,
  sector,
  insight,
  proposed_action,
  urgency,
  applied,
  applied_at
FROM ranked
WHERE rn <= 25;
');

EXEC('
CREATE OR ALTER VIEW dbo.vw_live_vs_paper AS
SELECT
  COALESCE(l.metric, p.metric) AS metric,
  l.metric_value AS live_value,
  p.metric_value AS paper_value
FROM (
  SELECT
    ''trade_count'' AS metric,
    CAST(trade_count AS FLOAT) AS metric_value
  FROM dbo.vw_profile_summary
  WHERE bot_profile = ''live''
  UNION ALL SELECT ''win_rate_pct'', win_rate_pct FROM dbo.vw_profile_summary WHERE bot_profile = ''live''
  UNION ALL SELECT ''realized_pnl_usd'', realized_pnl_usd FROM dbo.vw_profile_summary WHERE bot_profile = ''live''
  UNION ALL SELECT ''open_positions'', CAST(open_positions AS FLOAT) FROM dbo.vw_profile_summary WHERE bot_profile = ''live''
  UNION ALL SELECT ''latest_equity'', latest_equity FROM dbo.vw_profile_summary WHERE bot_profile = ''live''
  UNION ALL SELECT ''bad_token_count'', CAST(bad_token_count AS FLOAT) FROM dbo.vw_learning_summary WHERE bot_profile = ''live''
  UNION ALL SELECT ''avg_sleeve_win_rate_pct'', avg_sleeve_win_rate_pct FROM dbo.vw_learning_summary WHERE bot_profile = ''live''
  UNION ALL SELECT ''strategy_brain_profile_count'', CAST(strategy_brain_profile_count AS FLOAT) FROM dbo.vw_learning_summary WHERE bot_profile = ''live''
) l
FULL OUTER JOIN (
  SELECT
    ''trade_count'' AS metric,
    CAST(trade_count AS FLOAT) AS metric_value
  FROM dbo.vw_profile_summary
  WHERE bot_profile = ''paper''
  UNION ALL SELECT ''win_rate_pct'', win_rate_pct FROM dbo.vw_profile_summary WHERE bot_profile = ''paper''
  UNION ALL SELECT ''realized_pnl_usd'', realized_pnl_usd FROM dbo.vw_profile_summary WHERE bot_profile = ''paper''
  UNION ALL SELECT ''open_positions'', CAST(open_positions AS FLOAT) FROM dbo.vw_profile_summary WHERE bot_profile = ''paper''
  UNION ALL SELECT ''latest_equity'', latest_equity FROM dbo.vw_profile_summary WHERE bot_profile = ''paper''
  UNION ALL SELECT ''bad_token_count'', CAST(bad_token_count AS FLOAT) FROM dbo.vw_learning_summary WHERE bot_profile = ''paper''
  UNION ALL SELECT ''avg_sleeve_win_rate_pct'', avg_sleeve_win_rate_pct FROM dbo.vw_learning_summary WHERE bot_profile = ''paper''
  UNION ALL SELECT ''strategy_brain_profile_count'', CAST(strategy_brain_profile_count AS FLOAT) FROM dbo.vw_learning_summary WHERE bot_profile = ''paper''
) p
  ON p.metric = l.metric;
');

EXEC('
CREATE OR ALTER VIEW dbo.vw_decision_quality_summary AS
WITH reflection_stats AS (
  SELECT
    bot_profile,
    COUNT(*) AS reflection_count,
    SUM(CASE WHEN pnl_usd > 0 THEN 1 ELSE 0 END) AS reflected_wins,
    SUM(CASE WHEN pnl_usd < 0 THEN 1 ELSE 0 END) AS reflected_losses,
    AVG(pnl_usd) AS avg_reflected_pnl_usd,
    AVG(pnl_pct) AS avg_reflected_pnl_pct
  FROM dbo.decision_reflections
  GROUP BY bot_profile
),
decision_stats AS (
  SELECT
    bot_profile,
    COUNT(*) AS total_decisions,
    SUM(CASE WHEN approved = 1 THEN 1 ELSE 0 END) AS approved_count,
    SUM(CASE WHEN approved = 0 THEN 1 ELSE 0 END) AS rejected_count,
    SUM(CASE WHEN final_action = ''BUY'' THEN 1 ELSE 0 END) AS buy_action_count,
    SUM(CASE WHEN final_action = ''HOLD'' THEN 1 ELSE 0 END) AS hold_action_count,
    SUM(CASE WHEN final_action = ''REJECT'' THEN 1 ELSE 0 END) AS reject_action_count,
    MAX(ts) AS last_decision_at
  FROM dbo.decision_log
  WHERE decision_stage IN (''approval'', ''execution'')
  GROUP BY bot_profile
)
SELECT
  p.bot_profile,
  COALESCE(d.total_decisions, 0) AS total_decisions,
  COALESCE(d.approved_count, 0) AS approved_count,
  COALESCE(d.rejected_count, 0) AS rejected_count,
  COALESCE(d.buy_action_count, 0) AS buy_action_count,
  COALESCE(d.hold_action_count, 0) AS hold_action_count,
  COALESCE(d.reject_action_count, 0) AS reject_action_count,
  d.last_decision_at,
  COALESCE(r.reflection_count, 0) AS reflection_count,
  COALESCE(r.reflected_wins, 0) AS reflected_wins,
  COALESCE(r.reflected_losses, 0) AS reflected_losses,
  r.avg_reflected_pnl_usd,
  r.avg_reflected_pnl_pct
FROM (
  SELECT DISTINCT bot_profile FROM dbo.decision_log
  UNION
  SELECT DISTINCT bot_profile FROM dbo.decision_reflections
) p
LEFT JOIN decision_stats d ON d.bot_profile = p.bot_profile
LEFT JOIN reflection_stats r ON r.bot_profile = p.bot_profile;
');

EXEC('
CREATE OR ALTER VIEW dbo.vw_strategy_versions_latest AS
WITH ranked AS (
  SELECT *,
    ROW_NUMBER() OVER (PARTITION BY bot_profile ORDER BY created_at DESC, version_id DESC) AS rn
  FROM dbo.strategy_versions
)
SELECT
  version_id,
  version_hash,
  bot_profile,
  source_profile,
  stage,
  created_at,
  approved_at,
  activated_at,
  rollback_at,
  candidate_id,
  parent_version_id,
  metadata_json
FROM ranked
WHERE rn <= 25;
');

EXEC('
CREATE OR ALTER VIEW dbo.vw_promotion_summary AS
SELECT
  bot_profile,
  COUNT(*) AS total_events,
  SUM(CASE WHEN status = ''approved'' THEN 1 ELSE 0 END) AS approved_count,
  SUM(CASE WHEN status = ''pending_manual_approval'' THEN 1 ELSE 0 END) AS pending_manual_approval_count,
  SUM(CASE WHEN status = ''promoted'' THEN 1 ELSE 0 END) AS promoted_count,
  SUM(CASE WHEN status = ''rolled_back'' THEN 1 ELSE 0 END) AS rolled_back_count,
  AVG(discrepancy_score) AS avg_discrepancy_score,
  AVG(promotion_confidence) AS avg_promotion_confidence,
  MAX(ts) AS last_event_at
FROM dbo.promotion_events
GROUP BY bot_profile;
');

EXEC('
CREATE OR ALTER VIEW dbo.vw_latest_decisions AS
WITH ranked AS (
  SELECT *,
    ROW_NUMBER() OVER (PARTITION BY bot_profile ORDER BY ts DESC, decision_id DESC) AS rn
  FROM dbo.decision_log
  WHERE decision_stage IN (''approval'', ''execution'')
)
SELECT
  decision_id,
  bot_profile,
  ts,
  chain_key,
  symbol,
  strategy,
  signal_source,
  decision_stage,
  final_action,
  approved,
  confidence,
  ai_confidence,
  reason,
  status
FROM ranked
WHERE rn <= 50;
');

EXEC('
CREATE OR ALTER VIEW dbo.vw_agent_lesson_contributions AS
SELECT
  COALESCE(bot_profile, ''unknown'') AS bot_profile,
  memory_scope,
  COUNT(*) AS lesson_count,
  SUM(CASE WHEN outcome = ''win'' THEN 1 ELSE 0 END) AS win_lessons,
  SUM(CASE WHEN outcome = ''loss'' THEN 1 ELSE 0 END) AS loss_lessons,
  AVG(pnl_usd) AS avg_lesson_pnl_usd,
  MAX(ts) AS last_lesson_at
FROM dbo.agent_trade_lessons
GROUP BY COALESCE(bot_profile, ''unknown''), memory_scope;
');
`;
}

async function ensureSchema(logger = console) {
  if (schemaEnsured) return true;
  const pool = await getPool(logger);
  if (!pool) return false;

  try {
    await pool.request().batch(getSchemaDdl());
    schemaEnsured = true;
  } catch (schemaErr) {
    logger.warn(`[SQL] ensureSchema failed: ${schemaErr.message}`);
    return false;
  }
  updateStatus({
    connected: true,
    schemaReady: true,
    lastError: null,
  });
  logger.info('[SQL] Schema ensured.');
  return true;
}

async function runSelfTest(logger = console) {
  if (!isSqlEnabled()) {
    updateStatus({
      connected: false,
      schemaReady: false,
      databaseExplicit: hasExplicitDatabase(),
      lastError: null,
    });
    return { ok: true, enabled: false, reason: 'sql_disabled' };
  }

  try {
    const pool = await getPool(logger);
    if (!pool) {
      return { ok: false, enabled: true, reason: 'no_pool', status: getSqlStatus() };
    }
    await ensureSchema(logger);
    const res = await pool.request().query('SELECT 1 AS ok, DB_NAME() AS database_name, SYSUTCDATETIME() AS checked_at');
    const row = res.recordset?.[0] || {};
    updateStatus({
      connected: true,
      schemaReady: true,
      databaseName: row.database_name || lastStatus.databaseName || null,
      databaseExplicit: hasExplicitDatabase(),
      lastError: null,
    });
    return { ok: true, enabled: true, status: getSqlStatus() };
  } catch (error) {
    updateStatus({
      connected: false,
      schemaReady: false,
      databaseExplicit: hasExplicitDatabase(),
      lastError: error.message,
    });
    logger.warn(`[SQL] Self-test failed: ${error.message}`);
    return { ok: false, enabled: true, reason: error.message, status: getSqlStatus() };
  }
}

module.exports = {
  isSqlEnabled,
  getConnectionString,
  hasExplicitDatabase,
  getPool,
  ensureSchema,
  getSqlStatus,
  runSelfTest,
  sql,
};
