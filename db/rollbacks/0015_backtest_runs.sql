IF EXISTS (SELECT 1 FROM sys.tables WHERE name = 'backtest_runs' AND schema_id = SCHEMA_ID('dbo'))
  DROP TABLE dbo.backtest_runs;
