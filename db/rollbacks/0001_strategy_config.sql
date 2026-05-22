-- ROLLBACK M002
IF EXISTS (
  SELECT 1 FROM sys.tables WHERE name = 'strategy_config' AND schema_id = SCHEMA_ID('dbo')
)
BEGIN
  DROP TABLE dbo.strategy_config;
END;
