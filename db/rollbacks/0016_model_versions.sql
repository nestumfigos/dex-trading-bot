IF EXISTS (SELECT 1 FROM sys.tables WHERE name = 'ml_model_versions' AND schema_id = SCHEMA_ID('dbo'))
  DROP TABLE dbo.ml_model_versions;
