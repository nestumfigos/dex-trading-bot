-- Rollback M006: evolution_history
IF EXISTS (SELECT 1 FROM sys.tables WHERE name = 'evolution_history' AND schema_id = SCHEMA_ID('dbo'))
BEGIN
  DROP TABLE dbo.evolution_history;
END
GO
