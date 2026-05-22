-- ROLLBACK M003
IF EXISTS (
  SELECT 1 FROM sys.tables WHERE name = 'config_changes' AND schema_id = SCHEMA_ID('dbo')
)
BEGIN
  DROP TABLE dbo.config_changes;
END;
