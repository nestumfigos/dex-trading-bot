IF EXISTS (SELECT 1 FROM sys.tables WHERE name='regime_patterns' AND schema_id=SCHEMA_ID('dbo'))
  DROP TABLE dbo.regime_patterns;
