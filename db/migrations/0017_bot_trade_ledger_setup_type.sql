BEGIN TRANSACTION;
BEGIN TRY

-- M018: bot_trade_ledger.setup_type
-- Promote setup type from raw_trade_json into a first-class column for
-- strategy/setup-level reporting.

IF OBJECT_ID('dbo.bot_trade_ledger', 'U') IS NOT NULL
   AND COL_LENGTH('dbo.bot_trade_ledger', 'setup_type') IS NULL
BEGIN
  ALTER TABLE dbo.bot_trade_ledger
    ADD setup_type NVARCHAR(40) NULL;
END

  COMMIT TRANSACTION;
END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
  THROW;
END CATCH;
GO
BEGIN TRANSACTION;
BEGIN TRY


IF OBJECT_ID('dbo.bot_trade_ledger', 'U') IS NOT NULL
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM sys.indexes
    WHERE name = 'IX_bot_trade_ledger_setup_type_ts'
      AND object_id = OBJECT_ID('dbo.bot_trade_ledger')
  )
  BEGIN
    CREATE INDEX IX_bot_trade_ledger_setup_type_ts
      ON dbo.bot_trade_ledger(bot_profile, setup_type, ts DESC)
      INCLUDE (trade_type, symbol, chain_key, strategy, pnl_usd)
      WHERE setup_type IS NOT NULL;
  END
END

  COMMIT TRANSACTION;
END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
  THROW;
END CATCH;
GO
