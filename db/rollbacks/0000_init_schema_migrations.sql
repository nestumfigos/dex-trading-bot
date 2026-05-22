-- ROLLBACK M001: schema_migrations
-- WARNING: dropping this table loses all migration history.
-- Only run during full DB reset or initial bootstrap recovery.

IF EXISTS (
  SELECT 1 FROM sys.tables WHERE name = 'schema_migrations' AND schema_id = SCHEMA_ID('dbo')
)
BEGIN
  DROP TABLE dbo.schema_migrations;
END;
