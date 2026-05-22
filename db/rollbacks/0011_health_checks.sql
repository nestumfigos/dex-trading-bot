IF EXISTS (SELECT 1 FROM sys.tables WHERE name = 'health_checks' AND schema_id = SCHEMA_ID('dbo'))
  DROP TABLE dbo.health_checks;
