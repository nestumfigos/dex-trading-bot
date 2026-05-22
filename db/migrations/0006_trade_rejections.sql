BEGIN TRANSACTION;
BEGIN TRY

-- M007: trade_rejections
-- Audit every blocked trade attempt (pre-trade contract failures, filter rejects,
-- AI vetoes). 30d retention. Queryable by dashboard + analytics.

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'trade_rejections' AND schema_id = SCHEMA_ID('dbo'))
BEGIN
  CREATE TABLE dbo.trade_rejections (
    id              BIGINT IDENTITY(1,1) PRIMARY KEY,
    rejected_at     DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME(),
    scope           NVARCHAR(32)  NOT NULL DEFAULT 'global',  -- live | paper | global
    strategy        NVARCHAR(32)  NULL,
    side            NVARCHAR(8)   NOT NULL,                    -- BUY | SELL
    symbol          NVARCHAR(64)  NOT NULL,
    chain           NVARCHAR(32)  NOT NULL,
    address         NVARCHAR(128) NULL,
    gate            NVARCHAR(64)  NOT NULL,                    -- rule name from risk_rules
    severity        NVARCHAR(16)  NOT NULL DEFAULT 'block',    -- block | warn | log
    reason          NVARCHAR(1024) NULL,
    requested_size_usd FLOAT      NULL,
    wallet_usd      FLOAT         NULL,
    position_value_usd FLOAT      NULL,
    metadata        NVARCHAR(MAX) NULL,                        -- JSON: tier index, min notional, etc
    bot_version     NVARCHAR(64)  NULL
  );
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


-- Hot scan: dashboard latest, retention prune.
IF NOT EXISTS (
  SELECT 1 FROM sys.indexes
   WHERE name = 'IX_trade_rejections_rejected_at'
     AND object_id = OBJECT_ID('dbo.trade_rejections')
)
BEGIN
  CREATE INDEX IX_trade_rejections_rejected_at
    ON dbo.trade_rejections (rejected_at DESC)
    INCLUDE (scope, strategy, side, symbol, gate);
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


-- Symbol drill-down (how often is X blocked?).
IF NOT EXISTS (
  SELECT 1 FROM sys.indexes
   WHERE name = 'IX_trade_rejections_symbol_chain'
     AND object_id = OBJECT_ID('dbo.trade_rejections')
)
BEGIN
  CREATE INDEX IX_trade_rejections_symbol_chain
    ON dbo.trade_rejections (symbol, chain, rejected_at DESC)
    INCLUDE (gate, severity);
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


-- Gate breakdown (which rule fires most?).
IF NOT EXISTS (
  SELECT 1 FROM sys.indexes
   WHERE name = 'IX_trade_rejections_gate'
     AND object_id = OBJECT_ID('dbo.trade_rejections')
)
BEGIN
  CREATE INDEX IX_trade_rejections_gate
    ON dbo.trade_rejections (gate, rejected_at DESC)
    INCLUDE (scope, severity);
END

  COMMIT TRANSACTION;
END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
  THROW;
END CATCH;
GO

