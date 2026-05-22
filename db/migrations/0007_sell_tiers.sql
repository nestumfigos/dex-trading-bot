BEGIN TRANSACTION;
BEGIN TRY

-- M008: sell_tiers
-- Replaces MOMENTUM_SELL_TIERS JSON-in-env. Hot-reloadable. min_notional_usd
-- precomputed per (chain, scope) so pre-trade contract checkTierFeasibility
-- can short-circuit without per-call exchange queries.

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'sell_tiers' AND schema_id = SCHEMA_ID('dbo'))
BEGIN
  CREATE TABLE dbo.sell_tiers (
    id                INT IDENTITY(1,1) PRIMARY KEY,
    scope             NVARCHAR(32)  NOT NULL DEFAULT 'global',  -- live | paper | global
    strategy          NVARCHAR(32)  NOT NULL,                    -- momentum | swing | rotation
    tier_index        INT           NOT NULL,                    -- 1..N
    profit_multiplier FLOAT         NOT NULL,                    -- 1.04 = +4%
    sell_pct          FLOAT         NOT NULL,                    -- 0.30 = 30%
    min_notional_usd  FLOAT         NULL,                        -- precomputed feasibility floor
    chain             NVARCHAR(32)  NULL,                        -- NULL = all chains
    active            BIT           NOT NULL DEFAULT 1,
    source            NVARCHAR(64)  NOT NULL DEFAULT 'manual',   -- manual | env_import | self_evolution
    notes             NVARCHAR(512) NULL,
    created_at        DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME(),
    updated_at        DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME(),
    updated_by        NVARCHAR(128) NULL
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


-- One active row per (scope, strategy, tier_index, chain) — hot lookup.
IF NOT EXISTS (
  SELECT 1 FROM sys.indexes
   WHERE name = 'UX_sell_tiers_scope_strat_idx_chain_active'
     AND object_id = OBJECT_ID('dbo.sell_tiers')
)
BEGIN
  CREATE UNIQUE INDEX UX_sell_tiers_scope_strat_idx_chain_active
    ON dbo.sell_tiers (scope, strategy, tier_index, chain)
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


-- Hot read by exit checker: get all tiers for strategy ordered.
IF NOT EXISTS (
  SELECT 1 FROM sys.indexes
   WHERE name = 'IX_sell_tiers_strategy_active'
     AND object_id = OBJECT_ID('dbo.sell_tiers')
)
BEGIN
  CREATE INDEX IX_sell_tiers_strategy_active
    ON dbo.sell_tiers (strategy, scope, tier_index)
    INCLUDE (profit_multiplier, sell_pct, min_notional_usd, chain)
    WHERE active = 1;
END

  COMMIT TRANSACTION;
END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
  THROW;
END CATCH;
GO

