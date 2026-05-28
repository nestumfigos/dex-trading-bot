-- M0018: bot_trade_ledger baseline (formalize inline schema from sqlServer.js).
-- M0017 safely defers if this table is absent; this baseline also supplies the
-- setup_type index so a fresh database ends in the same shape.
BEGIN TRANSACTION;
BEGIN TRY

  IF OBJECT_ID('dbo.bot_trade_ledger', 'U') IS NULL
  BEGIN
    CREATE TABLE dbo.bot_trade_ledger (
      trade_id UNIQUEIDENTIFIER NOT NULL PRIMARY KEY,
      bot_profile NVARCHAR(20) NOT NULL,
      ts DATETIME2(3) NOT NULL,
      trade_type NVARCHAR(20) NOT NULL,
      symbol NVARCHAR(40) NULL,
      chain NVARCHAR(30) NULL,
      chain_key NVARCHAR(30) NULL,
      strategy NVARCHAR(30) NULL,
      address NVARCHAR(120) NULL,
      price FLOAT NULL,
      quantity FLOAT NULL,
      value_usd FLOAT NULL,
      pnl_usd FLOAT NULL,
      txid NVARCHAR(200) NULL,
      signal_source NVARCHAR(80) NULL,
      reason NVARCHAR(200) NULL,
      setup_type NVARCHAR(40) NULL,
      raw_trade_json NVARCHAR(MAX) NULL
    );
  END;

  IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
    WHERE name = 'IX_bot_trade_ledger_profile_ts'
      AND object_id = OBJECT_ID('dbo.bot_trade_ledger')
  )
  BEGIN
    CREATE INDEX IX_bot_trade_ledger_profile_ts ON dbo.bot_trade_ledger(bot_profile, ts DESC);
  END;

  IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
    WHERE name = 'IX_bot_trade_ledger_setup_type_ts'
      AND object_id = OBJECT_ID('dbo.bot_trade_ledger')
  )
  BEGIN
    CREATE INDEX IX_bot_trade_ledger_setup_type_ts
      ON dbo.bot_trade_ledger(bot_profile, setup_type, ts DESC)
      INCLUDE (trade_type, symbol, chain_key, strategy, pnl_usd)
      WHERE setup_type IS NOT NULL;
  END;

  COMMIT TRANSACTION;
END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
  THROW;
END CATCH;
GO
