-- Rollback M005: indicator_weights
IF EXISTS (SELECT 1 FROM sys.tables WHERE name = 'indicator_weights' AND schema_id = SCHEMA_ID('dbo'))
BEGIN
  DROP TABLE dbo.indicator_weights;
END
GO
