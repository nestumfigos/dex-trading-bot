IF EXISTS (SELECT 1 FROM sys.tables WHERE name = 'trade_rejections' AND schema_id = SCHEMA_ID('dbo'))
  DROP TABLE dbo.trade_rejections;
