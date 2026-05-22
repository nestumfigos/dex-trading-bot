BEGIN TRANSACTION;
BEGIN TRY

-- M004: symbol_overrides
-- Replaces scattered tokenBlacklist / tokenPreferences storage in agent-memory.json.
-- One row = one symbol+chain override with action enum + optional expiration.
-- Read by memory/blacklist.js (Week 2) + pre-trade-contract (Week 3).

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'symbol_overrides' AND schema_id = SCHEMA_ID('dbo'))
BEGIN
  CREATE TABLE dbo.symbol_overrides (
    id              INT IDENTITY(1,1) PRIMARY KEY,
    symbol          NVARCHAR(64)  NOT NULL,
    chain           NVARCHAR(32)  NOT NULL,
    scope           NVARCHAR(32)  NOT NULL DEFAULT 'global',  -- global | live | paper
    action          NVARCHAR(32)  NOT NULL,                    -- block | prefer | size_multiply | custom_stop
    value           NVARCHAR(256) NULL,                        -- multiplier, stop pct, custom payload
    reason          NVARCHAR(512) NULL,
    source          NVARCHAR(64)  NOT NULL DEFAULT 'manual',   -- manual | memory | self_evolution | telegram
    created_at      DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME(),
    updated_at      DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME(),
    expires_at      DATETIME2     NULL,
    active          BIT           NOT NULL DEFAULT 1,
    created_by      NVARCHAR(128) NULL
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


-- Unique active override per (scope, symbol, chain, action).
IF NOT EXISTS (
  SELECT 1 FROM sys.indexes
   WHERE name = 'UX_symbol_overrides_scope_sym_chain_action_active'
     AND object_id = OBJECT_ID('dbo.symbol_overrides')
)
BEGIN
  CREATE UNIQUE INDEX UX_symbol_overrides_scope_sym_chain_action_active
    ON dbo.symbol_overrides (scope, symbol, chain, action)
    WHERE active = 1;
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


-- Lookup index for hot-path read (filter by symbol+chain+active).
IF NOT EXISTS (
  SELECT 1 FROM sys.indexes
   WHERE name = 'IX_symbol_overrides_sym_chain_active'
     AND object_id = OBJECT_ID('dbo.symbol_overrides')
)
BEGIN
  CREATE INDEX IX_symbol_overrides_sym_chain_active
    ON dbo.symbol_overrides (symbol, chain, active)
    INCLUDE (action, value, expires_at);
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


-- Expiration sweep helper index.
IF NOT EXISTS (
  SELECT 1 FROM sys.indexes
   WHERE name = 'IX_symbol_overrides_expires_at'
     AND object_id = OBJECT_ID('dbo.symbol_overrides')
)
BEGIN
  CREATE INDEX IX_symbol_overrides_expires_at
    ON dbo.symbol_overrides (expires_at)
    WHERE active = 1 AND expires_at IS NOT NULL;
END

  COMMIT TRANSACTION;
END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
  THROW;
END CATCH;
GO

