IF EXISTS (SELECT 1 FROM sys.tables WHERE name='tokens' AND schema_id=SCHEMA_ID('dbo'))
  DROP TABLE dbo.tokens;
