-- V2 control-plane foundation: cross-bot events, perps SQL telemetry,
-- portfolio risk snapshots, replay evidence, and unified dashboard views.

IF NOT EXISTS (
  SELECT 1 FROM sys.tables WHERE name = 'trading_events' AND schema_id = SCHEMA_ID('dbo')
)
BEGIN
  CREATE TABLE dbo.trading_events (
    event_id UNIQUEIDENTIFIER NOT NULL CONSTRAINT DF_trading_events_event_id DEFAULT NEWID() PRIMARY KEY,
    event_name NVARCHAR(120) NOT NULL,
    bot_profile NVARCHAR(20) NOT NULL,
    strategy NVARCHAR(80) NULL,
    symbol NVARCHAR(80) NULL,
    severity NVARCHAR(16) NOT NULL CONSTRAINT DF_trading_events_severity DEFAULT ('info'),
    occurred_at DATETIME2(3) NOT NULL CONSTRAINT DF_trading_events_occurred_at DEFAULT SYSUTCDATETIME(),
    correlation_id NVARCHAR(120) NULL,
    payload_json NVARCHAR(MAX) NULL
  );
END;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_trading_events_profile_time' AND object_id = OBJECT_ID('dbo.trading_events'))
BEGIN
  CREATE INDEX IX_trading_events_profile_time ON dbo.trading_events(bot_profile, occurred_at DESC);
END;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_trading_events_name_time' AND object_id = OBJECT_ID('dbo.trading_events'))
BEGIN
  CREATE INDEX IX_trading_events_name_time ON dbo.trading_events(event_name, occurred_at DESC);
END;

IF NOT EXISTS (
  SELECT 1 FROM sys.tables WHERE name = 'perps_signals' AND schema_id = SCHEMA_ID('dbo')
)
BEGIN
  CREATE TABLE dbo.perps_signals (
    signal_id NVARCHAR(160) NOT NULL PRIMARY KEY,
    bot_profile NVARCHAR(20) NOT NULL CONSTRAINT DF_perps_signals_profile DEFAULT ('paper_perps'),
    ts DATETIME2(3) NOT NULL CONSTRAINT DF_perps_signals_ts DEFAULT SYSUTCDATETIME(),
    symbol NVARCHAR(80) NULL,
    strategy NVARCHAR(80) NULL,
    action NVARCHAR(40) NULL,
    side NVARCHAR(16) NULL,
    setup NVARCHAR(80) NULL,
    accepted BIT NOT NULL CONSTRAINT DF_perps_signals_accepted DEFAULT (0),
    shadow BIT NOT NULL CONSTRAINT DF_perps_signals_shadow DEFAULT (0),
    reasons_json NVARCHAR(MAX) NULL,
    details_json NVARCHAR(MAX) NULL
  );
END;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_perps_signals_profile_ts' AND object_id = OBJECT_ID('dbo.perps_signals'))
BEGIN
  CREATE INDEX IX_perps_signals_profile_ts ON dbo.perps_signals(bot_profile, ts DESC);
END;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_perps_signals_strategy_action' AND object_id = OBJECT_ID('dbo.perps_signals'))
BEGIN
  CREATE INDEX IX_perps_signals_strategy_action ON dbo.perps_signals(strategy, action, accepted, ts DESC);
END;

IF NOT EXISTS (
  SELECT 1 FROM sys.tables WHERE name = 'perps_trades' AND schema_id = SCHEMA_ID('dbo')
)
BEGIN
  CREATE TABLE dbo.perps_trades (
    trade_id NVARCHAR(180) NOT NULL PRIMARY KEY,
    position_id NVARCHAR(180) NULL,
    lifecycle_id NVARCHAR(180) NULL,
    signal_id NVARCHAR(180) NULL,
    bot_profile NVARCHAR(20) NOT NULL CONSTRAINT DF_perps_trades_profile DEFAULT ('paper_perps'),
    ts DATETIME2(3) NOT NULL CONSTRAINT DF_perps_trades_ts DEFAULT SYSUTCDATETIME(),
    symbol NVARCHAR(80) NULL,
    strategy NVARCHAR(80) NULL,
    setup NVARCHAR(80) NULL,
    side NVARCHAR(16) NULL,
    trade_type NVARCHAR(32) NULL,
    reduce_only BIT NULL,
    notional_usd FLOAT NULL,
    entry_price FLOAT NULL,
    exit_price FLOAT NULL,
    leverage FLOAT NULL,
    margin_mode NVARCHAR(24) NULL,
    gross_pnl_usd FLOAT NULL,
    pnl_usd FLOAT NULL,
    funding_usd FLOAT NULL,
    fee_usd FLOAT NULL,
    slippage_usd FLOAT NULL,
    liquidation_buffer_multiple FLOAT NULL,
    reason NVARCHAR(200) NULL,
    raw_trade_json NVARCHAR(MAX) NULL
  );
END;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_perps_trades_profile_ts' AND object_id = OBJECT_ID('dbo.perps_trades'))
BEGIN
  CREATE INDEX IX_perps_trades_profile_ts ON dbo.perps_trades(bot_profile, ts DESC);
END;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_perps_trades_symbol_strategy' AND object_id = OBJECT_ID('dbo.perps_trades'))
BEGIN
  CREATE INDEX IX_perps_trades_symbol_strategy ON dbo.perps_trades(symbol, strategy, ts DESC);
END;

IF NOT EXISTS (
  SELECT 1 FROM sys.tables WHERE name = 'perps_positions' AND schema_id = SCHEMA_ID('dbo')
)
BEGIN
  CREATE TABLE dbo.perps_positions (
    position_id NVARCHAR(180) NOT NULL PRIMARY KEY,
    lifecycle_id NVARCHAR(180) NULL,
    signal_id NVARCHAR(180) NULL,
    bot_profile NVARCHAR(20) NOT NULL CONSTRAINT DF_perps_positions_profile DEFAULT ('paper_perps'),
    status NVARCHAR(24) NOT NULL CONSTRAINT DF_perps_positions_status DEFAULT ('open'),
    opened_at DATETIME2(3) NULL,
    updated_at DATETIME2(3) NOT NULL CONSTRAINT DF_perps_positions_updated_at DEFAULT SYSUTCDATETIME(),
    closed_at DATETIME2(3) NULL,
    symbol NVARCHAR(80) NULL,
    strategy NVARCHAR(80) NULL,
    setup NVARCHAR(80) NULL,
    side NVARCHAR(16) NULL,
    entry_price FLOAT NULL,
    stop_price FLOAT NULL,
    liquidation_price FLOAT NULL,
    leverage FLOAT NULL,
    margin_mode NVARCHAR(24) NULL,
    notional_usd FLOAT NULL,
    remaining_notional_usd FLOAT NULL,
    risk_usd FLOAT NULL,
    liquidation_buffer_multiple FLOAT NULL,
    raw_position_json NVARCHAR(MAX) NULL
  );
END;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_perps_positions_profile_status' AND object_id = OBJECT_ID('dbo.perps_positions'))
BEGIN
  CREATE INDEX IX_perps_positions_profile_status ON dbo.perps_positions(bot_profile, status, updated_at DESC);
END;

IF NOT EXISTS (
  SELECT 1 FROM sys.tables WHERE name = 'perps_state_snapshots' AND schema_id = SCHEMA_ID('dbo')
)
BEGIN
  CREATE TABLE dbo.perps_state_snapshots (
    snapshot_id UNIQUEIDENTIFIER NOT NULL CONSTRAINT DF_perps_state_snapshots_id DEFAULT NEWID() PRIMARY KEY,
    bot_profile NVARCHAR(20) NOT NULL CONSTRAINT DF_perps_state_snapshots_profile DEFAULT ('paper_perps'),
    revision BIGINT NULL,
    ts DATETIME2(3) NOT NULL CONSTRAINT DF_perps_state_snapshots_ts DEFAULT SYSUTCDATETIME(),
    state_json NVARCHAR(MAX) NOT NULL
  );
END;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_perps_state_snapshots_profile_ts' AND object_id = OBJECT_ID('dbo.perps_state_snapshots'))
BEGIN
  CREATE INDEX IX_perps_state_snapshots_profile_ts ON dbo.perps_state_snapshots(bot_profile, ts DESC);
END;

IF NOT EXISTS (
  SELECT 1 FROM sys.tables WHERE name = 'perps_admission_snapshots' AND schema_id = SCHEMA_ID('dbo')
)
BEGIN
  CREATE TABLE dbo.perps_admission_snapshots (
    snapshot_id UNIQUEIDENTIFIER NOT NULL CONSTRAINT DF_perps_admission_snapshots_id DEFAULT NEWID() PRIMARY KEY,
    bot_profile NVARCHAR(20) NOT NULL CONSTRAINT DF_perps_admission_snapshots_profile DEFAULT ('paper_perps'),
    ts DATETIME2(3) NOT NULL CONSTRAINT DF_perps_admission_snapshots_ts DEFAULT SYSUTCDATETIME(),
    required BIT NULL,
    allow_new_entries BIT NULL,
    variant_id NVARCHAR(80) NULL,
    reasons_json NVARCHAR(MAX) NULL,
    status_json NVARCHAR(MAX) NULL
  );
END;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_perps_admission_snapshots_profile_ts' AND object_id = OBJECT_ID('dbo.perps_admission_snapshots'))
BEGIN
  CREATE INDEX IX_perps_admission_snapshots_profile_ts ON dbo.perps_admission_snapshots(bot_profile, ts DESC);
END;

IF NOT EXISTS (
  SELECT 1 FROM sys.tables WHERE name = 'portfolio_exposure_snapshots' AND schema_id = SCHEMA_ID('dbo')
)
BEGIN
  CREATE TABLE dbo.portfolio_exposure_snapshots (
    snapshot_id UNIQUEIDENTIFIER NOT NULL CONSTRAINT DF_portfolio_exposure_snapshots_id DEFAULT NEWID() PRIMARY KEY,
    bot_profile NVARCHAR(20) NOT NULL,
    ts DATETIME2(3) NOT NULL CONSTRAINT DF_portfolio_exposure_snapshots_ts DEFAULT SYSUTCDATETIME(),
    market_type NVARCHAR(20) NULL,
    symbol NVARCHAR(80) NULL,
    strategy NVARCHAR(80) NULL,
    exposure_usd FLOAT NULL,
    notional_usd FLOAT NULL,
    risk_usd FLOAT NULL,
    leverage FLOAT NULL,
    correlation_bucket NVARCHAR(80) NULL,
    details_json NVARCHAR(MAX) NULL
  );
END;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_portfolio_exposure_snapshots_profile_ts' AND object_id = OBJECT_ID('dbo.portfolio_exposure_snapshots'))
BEGIN
  CREATE INDEX IX_portfolio_exposure_snapshots_profile_ts ON dbo.portfolio_exposure_snapshots(bot_profile, ts DESC);
END;

IF NOT EXISTS (
  SELECT 1 FROM sys.tables WHERE name = 'correlation_snapshots' AND schema_id = SCHEMA_ID('dbo')
)
BEGIN
  CREATE TABLE dbo.correlation_snapshots (
    snapshot_id UNIQUEIDENTIFIER NOT NULL CONSTRAINT DF_correlation_snapshots_id DEFAULT NEWID() PRIMARY KEY,
    bot_profile NVARCHAR(20) NOT NULL,
    ts DATETIME2(3) NOT NULL CONSTRAINT DF_correlation_snapshots_ts DEFAULT SYSUTCDATETIME(),
    asset_a NVARCHAR(80) NOT NULL,
    asset_b NVARCHAR(80) NOT NULL,
    correlation FLOAT NULL,
    lookback_minutes INT NULL,
    source NVARCHAR(80) NULL,
    details_json NVARCHAR(MAX) NULL
  );
END;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_correlation_snapshots_profile_ts' AND object_id = OBJECT_ID('dbo.correlation_snapshots'))
BEGIN
  CREATE INDEX IX_correlation_snapshots_profile_ts ON dbo.correlation_snapshots(bot_profile, ts DESC);
END;

IF NOT EXISTS (
  SELECT 1 FROM sys.tables WHERE name = 'replay_runs' AND schema_id = SCHEMA_ID('dbo')
)
BEGIN
  CREATE TABLE dbo.replay_runs (
    replay_run_id UNIQUEIDENTIFIER NOT NULL CONSTRAINT DF_replay_runs_id DEFAULT NEWID() PRIMARY KEY,
    bot_profile NVARCHAR(20) NOT NULL,
    strategy NVARCHAR(80) NOT NULL,
    started_at DATETIME2(3) NOT NULL CONSTRAINT DF_replay_runs_started_at DEFAULT SYSUTCDATETIME(),
    ended_at DATETIME2(3) NULL,
    status NVARCHAR(40) NULL,
    symbols_json NVARCHAR(MAX) NULL,
    params_json NVARCHAR(MAX) NULL,
    metrics_json NVARCHAR(MAX) NULL,
    result_json NVARCHAR(MAX) NULL
  );
END;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_replay_runs_profile_strategy' AND object_id = OBJECT_ID('dbo.replay_runs'))
BEGIN
  CREATE INDEX IX_replay_runs_profile_strategy ON dbo.replay_runs(bot_profile, strategy, started_at DESC);
END;

IF NOT EXISTS (
  SELECT 1 FROM sys.tables WHERE name = 'replay_trades' AND schema_id = SCHEMA_ID('dbo')
)
BEGIN
  CREATE TABLE dbo.replay_trades (
    replay_trade_id UNIQUEIDENTIFIER NOT NULL CONSTRAINT DF_replay_trades_id DEFAULT NEWID() PRIMARY KEY,
    replay_run_id UNIQUEIDENTIFIER NULL,
    bot_profile NVARCHAR(20) NOT NULL,
    strategy NVARCHAR(80) NOT NULL,
    ts DATETIME2(3) NOT NULL,
    symbol NVARCHAR(80) NULL,
    side NVARCHAR(16) NULL,
    pnl_usd FLOAT NULL,
    costs_usd FLOAT NULL,
    trade_json NVARCHAR(MAX) NULL
  );
END;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_replay_trades_run_ts' AND object_id = OBJECT_ID('dbo.replay_trades'))
BEGIN
  CREATE INDEX IX_replay_trades_run_ts ON dbo.replay_trades(replay_run_id, ts DESC);
END;

IF NOT EXISTS (
  SELECT 1 FROM sys.tables WHERE name = 'walk_forward_results' AND schema_id = SCHEMA_ID('dbo')
)
BEGIN
  CREATE TABLE dbo.walk_forward_results (
    result_id UNIQUEIDENTIFIER NOT NULL CONSTRAINT DF_walk_forward_results_id DEFAULT NEWID() PRIMARY KEY,
    bot_profile NVARCHAR(20) NOT NULL,
    strategy NVARCHAR(80) NOT NULL,
    ts DATETIME2(3) NOT NULL CONSTRAINT DF_walk_forward_results_ts DEFAULT SYSUTCDATETIME(),
    training_window_json NVARCHAR(MAX) NULL,
    validation_window_json NVARCHAR(MAX) NULL,
    passed BIT NOT NULL CONSTRAINT DF_walk_forward_results_passed DEFAULT (0),
    metrics_json NVARCHAR(MAX) NULL,
    failure_reasons_json NVARCHAR(MAX) NULL
  );
END;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_walk_forward_results_profile_strategy' AND object_id = OBJECT_ID('dbo.walk_forward_results'))
BEGIN
  CREATE INDEX IX_walk_forward_results_profile_strategy ON dbo.walk_forward_results(bot_profile, strategy, ts DESC);
END;

IF NOT EXISTS (
  SELECT 1 FROM sys.tables WHERE name = 'promotion_candidates' AND schema_id = SCHEMA_ID('dbo')
)
BEGIN
  CREATE TABLE dbo.promotion_candidates (
    candidate_id UNIQUEIDENTIFIER NOT NULL CONSTRAINT DF_promotion_candidates_id DEFAULT NEWID() PRIMARY KEY,
    bot_profile NVARCHAR(20) NOT NULL,
    target_profile NVARCHAR(20) NOT NULL,
    strategy NVARCHAR(80) NOT NULL,
    strategy_version NVARCHAR(80) NULL,
    config_hash NVARCHAR(120) NULL,
    code_hash NVARCHAR(120) NULL,
    stage NVARCHAR(40) NOT NULL CONSTRAINT DF_promotion_candidates_stage DEFAULT ('proposed'),
    status NVARCHAR(40) NOT NULL CONSTRAINT DF_promotion_candidates_status DEFAULT ('pending'),
    created_at DATETIME2(3) NOT NULL CONSTRAINT DF_promotion_candidates_created_at DEFAULT SYSUTCDATETIME(),
    reviewed_at DATETIME2(3) NULL,
    sample_size INT NULL,
    expectancy_usd FLOAT NULL,
    profit_factor FLOAT NULL,
    max_drawdown_pct FLOAT NULL,
    promotion_confidence FLOAT NULL,
    evidence_json NVARCHAR(MAX) NULL
  );
END;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_promotion_candidates_status' AND object_id = OBJECT_ID('dbo.promotion_candidates'))
BEGIN
  CREATE INDEX IX_promotion_candidates_status ON dbo.promotion_candidates(status, stage, created_at DESC);
END;

EXEC('
CREATE OR ALTER VIEW dbo.v_bot_performance_24h AS
WITH spot AS (
  SELECT
    bot_profile,
    COALESCE(strategy, ''unknown'') AS strategy,
    symbol,
    pnl_usd,
    CAST(NULL AS FLOAT) AS funding_usd,
    CAST(NULL AS FLOAT) AS fee_usd,
    CAST(NULL AS FLOAT) AS slippage_usd,
    ts
  FROM dbo.bot_trade_ledger
  WHERE ts >= DATEADD(hour, -24, SYSUTCDATETIME())
    AND trade_type IN (''SELL'', ''EXIT'')
),
perps AS (
  SELECT
    bot_profile,
    COALESCE(strategy, ''unknown'') AS strategy,
    symbol,
    pnl_usd,
    funding_usd,
    fee_usd,
    slippage_usd,
    ts
  FROM dbo.perps_trades
  WHERE ts >= DATEADD(hour, -24, SYSUTCDATETIME())
    AND trade_type = ''EXIT''
)
SELECT
  bot_profile,
  strategy,
  COUNT(*) AS closed_trades,
  SUM(CASE WHEN pnl_usd > 0 THEN 1 ELSE 0 END) AS wins,
  SUM(CASE WHEN pnl_usd < 0 THEN 1 ELSE 0 END) AS losses,
  SUM(COALESCE(pnl_usd, 0)) AS pnl_usd,
  SUM(COALESCE(funding_usd, 0)) AS funding_usd,
  SUM(COALESCE(fee_usd, 0)) AS fee_usd,
  SUM(COALESCE(slippage_usd, 0)) AS slippage_usd,
  CASE WHEN COUNT(*) > 0 THEN SUM(COALESCE(pnl_usd, 0)) / COUNT(*) ELSE 0 END AS expectancy_usd,
  MAX(ts) AS last_trade_at
FROM (
  SELECT * FROM spot
  UNION ALL
  SELECT * FROM perps
) x
GROUP BY bot_profile, strategy;
');

EXEC('
CREATE OR ALTER VIEW dbo.v_strategy_rejection_waterfall AS
SELECT
  bot_profile,
  COALESCE(strategy, ''unknown'') AS strategy,
  symbol,
  ''spot_signal'' AS source,
  ts,
  reject_reasons_json AS reason_blob
FROM dbo.signals
WHERE final_signal IN (''HOLD'', ''REJECT'') AND reject_reasons_json IS NOT NULL
UNION ALL
SELECT
  scope AS bot_profile,
  COALESCE(strategy, ''unknown'') AS strategy,
  symbol,
  ''pre_trade'' AS source,
  rejected_at AS ts,
  reason AS reason_blob
FROM dbo.trade_rejections
UNION ALL
SELECT
  bot_profile,
  COALESCE(strategy, ''unknown'') AS strategy,
  symbol,
  ''perps_signal'' AS source,
  ts,
  reasons_json AS reason_blob
FROM dbo.perps_signals
WHERE accepted = 0;
');

EXEC('
CREATE OR ALTER VIEW dbo.v_open_risk_exposure AS
SELECT
  bot_profile,
  ''spot'' AS market_type,
  symbol,
  strategy,
  entry_usd AS exposure_usd,
  entry_usd AS notional_usd,
  CAST(NULL AS FLOAT) AS leverage,
  opened_at,
  CAST(NULL AS FLOAT) AS liquidation_buffer_multiple
FROM dbo.positions
WHERE closed_at IS NULL
UNION ALL
SELECT
  bot_profile,
  ''perp'' AS market_type,
  symbol,
  strategy,
  remaining_notional_usd AS exposure_usd,
  notional_usd,
  leverage,
  opened_at,
  liquidation_buffer_multiple
FROM dbo.perps_positions
WHERE status = ''open'';
');

EXEC('
CREATE OR ALTER VIEW dbo.v_strategy_version_performance AS
SELECT
  bot_profile,
  COALESCE(strategy, ''unknown'') AS strategy,
  CASE WHEN ISJSON(raw_trade_json) = 1 THEN JSON_VALUE(raw_trade_json, ''$.strategyVersion'') ELSE NULL END AS strategy_version,
  COUNT(*) AS trades,
  SUM(CASE WHEN pnl_usd > 0 THEN 1 ELSE 0 END) AS wins,
  SUM(CASE WHEN pnl_usd < 0 THEN 1 ELSE 0 END) AS losses,
  SUM(COALESCE(pnl_usd, 0)) AS pnl_usd,
  AVG(pnl_usd) AS expectancy_usd,
  MAX(ts) AS last_trade_at
FROM dbo.bot_trade_ledger
WHERE trade_type IN (''SELL'', ''EXIT'')
GROUP BY bot_profile, COALESCE(strategy, ''unknown''), CASE WHEN ISJSON(raw_trade_json) = 1 THEN JSON_VALUE(raw_trade_json, ''$.strategyVersion'') ELSE NULL END
UNION ALL
SELECT
  bot_profile,
  COALESCE(strategy, ''unknown'') AS strategy,
  CASE WHEN ISJSON(raw_trade_json) = 1 THEN JSON_VALUE(raw_trade_json, ''$.strategyVersion'') ELSE NULL END AS strategy_version,
  COUNT(*) AS trades,
  SUM(CASE WHEN pnl_usd > 0 THEN 1 ELSE 0 END) AS wins,
  SUM(CASE WHEN pnl_usd < 0 THEN 1 ELSE 0 END) AS losses,
  SUM(COALESCE(pnl_usd, 0)) AS pnl_usd,
  AVG(pnl_usd) AS expectancy_usd,
  MAX(ts) AS last_trade_at
FROM dbo.perps_trades
WHERE trade_type = ''EXIT''
GROUP BY bot_profile, COALESCE(strategy, ''unknown''), CASE WHEN ISJSON(raw_trade_json) = 1 THEN JSON_VALUE(raw_trade_json, ''$.strategyVersion'') ELSE NULL END;
');

EXEC('
CREATE OR ALTER VIEW dbo.v_execution_quality AS
SELECT
  o.bot_profile,
  COALESCE(o.strategy, ''unknown'') AS strategy,
  o.symbol,
  o.ts,
  ''spot'' AS market_type,
  f.fee_usd,
  f.slippage_bps,
  CAST(NULL AS FLOAT) AS funding_usd,
  CAST(NULL AS FLOAT) AS slippage_usd
FROM dbo.orders o
LEFT JOIN dbo.fills f ON f.order_id = o.order_id
UNION ALL
SELECT
  bot_profile,
  COALESCE(strategy, ''unknown'') AS strategy,
  symbol,
  ts,
  ''perp'' AS market_type,
  fee_usd,
  CASE WHEN notional_usd > 0 THEN (slippage_usd / notional_usd) * 10000 ELSE NULL END AS slippage_bps,
  funding_usd,
  slippage_usd
FROM dbo.perps_trades;
');
