-- Rollback M0018: drop bot_trade_ledger if it exists.
-- WARNING: irreversibly destroys trade history rows; only run with consent.
IF EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_bot_trade_ledger_profile_ts' AND object_id = OBJECT_ID('dbo.bot_trade_ledger'))
  DROP INDEX IX_bot_trade_ledger_profile_ts ON dbo.bot_trade_ledger;
GO
IF OBJECT_ID('dbo.bot_trade_ledger', 'U') IS NOT NULL
  DROP TABLE dbo.bot_trade_ledger;
GO
