IF EXISTS (
  SELECT 1
  FROM sys.indexes
  WHERE name = 'IX_bot_trade_ledger_setup_type_ts'
    AND object_id = OBJECT_ID('dbo.bot_trade_ledger')
)
BEGIN
  DROP INDEX IX_bot_trade_ledger_setup_type_ts ON dbo.bot_trade_ledger;
END
GO

IF COL_LENGTH('dbo.bot_trade_ledger', 'setup_type') IS NOT NULL
BEGIN
  ALTER TABLE dbo.bot_trade_ledger
    DROP COLUMN setup_type;
END
GO
