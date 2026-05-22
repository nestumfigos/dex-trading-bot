-- Rollback M004: symbol_overrides
IF EXISTS (SELECT 1 FROM sys.tables WHERE name = 'symbol_overrides' AND schema_id = SCHEMA_ID('dbo'))
BEGIN
  DROP TABLE dbo.symbol_overrides;
END
GO
