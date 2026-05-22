IF EXISTS (SELECT 1 FROM sys.tables WHERE name = 'ai_prompts' AND schema_id = SCHEMA_ID('dbo'))
  DROP TABLE dbo.ai_prompts;
