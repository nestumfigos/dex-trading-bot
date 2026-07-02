IF OBJECT_ID('dbo.v_execution_quality', 'V') IS NOT NULL
BEGIN
  DROP VIEW dbo.v_execution_quality;
END;

IF OBJECT_ID('dbo.v_strategy_version_performance', 'V') IS NOT NULL
BEGIN
  DROP VIEW dbo.v_strategy_version_performance;
END;

IF OBJECT_ID('dbo.v_open_risk_exposure', 'V') IS NOT NULL
BEGIN
  DROP VIEW dbo.v_open_risk_exposure;
END;

IF OBJECT_ID('dbo.v_strategy_rejection_waterfall', 'V') IS NOT NULL
BEGIN
  DROP VIEW dbo.v_strategy_rejection_waterfall;
END;

IF OBJECT_ID('dbo.v_bot_performance_24h', 'V') IS NOT NULL
BEGIN
  DROP VIEW dbo.v_bot_performance_24h;
END;

IF EXISTS (SELECT 1 FROM sys.tables WHERE name = 'promotion_candidates' AND schema_id = SCHEMA_ID('dbo'))
BEGIN
  DROP TABLE dbo.promotion_candidates;
END;

IF EXISTS (SELECT 1 FROM sys.tables WHERE name = 'walk_forward_results' AND schema_id = SCHEMA_ID('dbo'))
BEGIN
  DROP TABLE dbo.walk_forward_results;
END;

IF EXISTS (SELECT 1 FROM sys.tables WHERE name = 'replay_trades' AND schema_id = SCHEMA_ID('dbo'))
BEGIN
  DROP TABLE dbo.replay_trades;
END;

IF EXISTS (SELECT 1 FROM sys.tables WHERE name = 'replay_runs' AND schema_id = SCHEMA_ID('dbo'))
BEGIN
  DROP TABLE dbo.replay_runs;
END;

IF EXISTS (SELECT 1 FROM sys.tables WHERE name = 'correlation_snapshots' AND schema_id = SCHEMA_ID('dbo'))
BEGIN
  DROP TABLE dbo.correlation_snapshots;
END;

IF EXISTS (SELECT 1 FROM sys.tables WHERE name = 'portfolio_exposure_snapshots' AND schema_id = SCHEMA_ID('dbo'))
BEGIN
  DROP TABLE dbo.portfolio_exposure_snapshots;
END;

IF EXISTS (SELECT 1 FROM sys.tables WHERE name = 'perps_admission_snapshots' AND schema_id = SCHEMA_ID('dbo'))
BEGIN
  DROP TABLE dbo.perps_admission_snapshots;
END;

IF EXISTS (SELECT 1 FROM sys.tables WHERE name = 'perps_state_snapshots' AND schema_id = SCHEMA_ID('dbo'))
BEGIN
  DROP TABLE dbo.perps_state_snapshots;
END;

IF EXISTS (SELECT 1 FROM sys.tables WHERE name = 'perps_positions' AND schema_id = SCHEMA_ID('dbo'))
BEGIN
  DROP TABLE dbo.perps_positions;
END;

IF EXISTS (SELECT 1 FROM sys.tables WHERE name = 'perps_trades' AND schema_id = SCHEMA_ID('dbo'))
BEGIN
  DROP TABLE dbo.perps_trades;
END;

IF EXISTS (SELECT 1 FROM sys.tables WHERE name = 'perps_signals' AND schema_id = SCHEMA_ID('dbo'))
BEGIN
  DROP TABLE dbo.perps_signals;
END;

IF EXISTS (SELECT 1 FROM sys.tables WHERE name = 'trading_events' AND schema_id = SCHEMA_ID('dbo'))
BEGIN
  DROP TABLE dbo.trading_events;
END;
