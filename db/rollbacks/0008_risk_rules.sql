IF EXISTS (SELECT 1 FROM sys.tables WHERE name = 'risk_rules' AND schema_id = SCHEMA_ID('dbo'))
  DROP TABLE dbo.risk_rules;
