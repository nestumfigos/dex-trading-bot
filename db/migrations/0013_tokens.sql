BEGIN TRANSACTION;
BEGIN TRY

-- M014: tokens
-- Metadata cache for tokens we've seen. Reduces DexScreener / CoinGecko / KuCoin
-- API hits by serving stale (with refresh in background) when (symbol, chain)
-- was queried within last 5 min. Background refresher: scripts/refresh-tokens.js
-- (deferred to dedicated wire-up).

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'tokens' AND schema_id = SCHEMA_ID('dbo'))
BEGIN
  CREATE TABLE dbo.tokens (
    id              INT IDENTITY(1,1) PRIMARY KEY,
    symbol          NVARCHAR(64)  NOT NULL,
    chain           NVARCHAR(32)  NOT NULL,
    address         NVARCHAR(128) NULL,
    pair_address    NVARCHAR(128) NULL,
    name            NVARCHAR(256) NULL,
    decimals        INT           NULL,
    liquidity_usd   FLOAT         NULL,
    volume_24h_usd  FLOAT         NULL,
    market_cap_usd  FLOAT         NULL,
    price_usd       FLOAT         NULL,
    price_change_24h FLOAT        NULL,
    txns_24h        INT           NULL,
    holder_count    INT           NULL,
    top_holders_pct FLOAT         NULL,
    listed_at       DATETIME2     NULL,                  -- when token first appeared
    source          NVARCHAR(64)  NULL,                  -- dexscreener | coingecko | kucoin
    metadata_json   NVARCHAR(MAX) NULL,                  -- raw provider payload
    refreshed_at    DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME(),
    created_at      DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME()
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


-- One row per (symbol, chain) — composite uniqueness.
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='UX_tokens_symbol_chain' AND object_id=OBJECT_ID('dbo.tokens'))
BEGIN
  CREATE UNIQUE INDEX UX_tokens_symbol_chain ON dbo.tokens (symbol, chain);
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


-- Address lookup (used when chain has unique address).
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_tokens_address' AND object_id=OBJECT_ID('dbo.tokens'))
BEGIN
  CREATE INDEX IX_tokens_address ON dbo.tokens (address) WHERE address IS NOT NULL;
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


-- Stale-detector index: query rows refreshed > 5min ago.
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_tokens_refreshed_at' AND object_id=OBJECT_ID('dbo.tokens'))
BEGIN
  CREATE INDEX IX_tokens_refreshed_at ON dbo.tokens (refreshed_at ASC) INCLUDE (symbol, chain);
END

  COMMIT TRANSACTION;
END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
  THROW;
END CATCH;
GO

