IF EXISTS (SELECT 1 FROM sys.tables WHERE name = 'ai_decisions_rollup' AND schema_id = SCHEMA_ID('dbo'))
  DROP TABLE dbo.ai_decisions_rollup;
GO
IF EXISTS (SELECT 1 FROM sys.tables WHERE name = 'ai_decisions' AND schema_id = SCHEMA_ID('dbo'))
  DROP TABLE dbo.ai_decisions;
