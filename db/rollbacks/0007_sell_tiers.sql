IF EXISTS (SELECT 1 FROM sys.tables WHERE name = 'sell_tiers' AND schema_id = SCHEMA_ID('dbo'))
  DROP TABLE dbo.sell_tiers;
