BEGIN TRANSACTION;
BEGIN TRY

-- M006: evolution_history
-- Replaces append-only data/self-evolution-history.jsonl. Each row = one self-
-- evolution decision with pre/post win-rate for causal feedback. Bot dual-writes
-- file + DB for 1 week before deprecating the file.

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'evolution_history' AND schema_id = SCHEMA_ID('dbo'))
BEGIN
  CREATE TABLE dbo.evolution_history (
    id                  INT IDENTITY(1,1) PRIMARY KEY,
    decided_at          DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME(),
    scope               NVARCHAR(32)  NOT NULL DEFAULT 'global',  -- live | paper | global
    strategy            NVARCHAR(32)  NULL,
    patch_id            NVARCHAR(128) NOT NULL,                    -- short id of evolution change
    patch_summary       NVARCHAR(1024) NULL,
    patch_json          NVARCHAR(MAX) NULL,                        -- full diff payload
    decision            NVARCHAR(32)  NOT NULL,                    -- proposed | accepted | rejected | promoted | rolled_back
    decided_by          NVARCHAR(64)  NULL,                        -- 'auto' | 'human' | 'guardian'
    reason              NVARCHAR(1024) NULL,
    samples_pre         INT           NULL,
    samples_post        INT           NULL,
    pre_win_rate        FLOAT         NULL,
    post_win_rate       FLOAT         NULL,
    pre_pnl_usd         FLOAT         NULL,
    post_pnl_usd        FLOAT         NULL,
    causal_delta_winrate FLOAT        NULL,
    causal_delta_pnl    FLOAT         NULL,
    measured_at         DATETIME2     NULL,                        -- when post stats settled
    notes               NVARCHAR(MAX) NULL,
    bot_version         NVARCHAR(64)  NULL,
    strategy_version_id NVARCHAR(128) NULL
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


-- Time-ordered scan (dashboard latest, prune by age).
IF NOT EXISTS (
  SELECT 1 FROM sys.indexes
   WHERE name = 'IX_evolution_history_decided_at'
     AND object_id = OBJECT_ID('dbo.evolution_history')
)
BEGIN
  CREATE INDEX IX_evolution_history_decided_at
    ON dbo.evolution_history (decided_at DESC)
    INCLUDE (scope, strategy, decision, patch_id);
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


-- Patch lookup (re-evaluate same patch later).
IF NOT EXISTS (
  SELECT 1 FROM sys.indexes
   WHERE name = 'IX_evolution_history_patch_id'
     AND object_id = OBJECT_ID('dbo.evolution_history')
)
BEGIN
  CREATE INDEX IX_evolution_history_patch_id
    ON dbo.evolution_history (patch_id, decided_at DESC);
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


-- Decision filter (find all rollbacks, all promoted, etc).
IF NOT EXISTS (
  SELECT 1 FROM sys.indexes
   WHERE name = 'IX_evolution_history_decision_scope'
     AND object_id = OBJECT_ID('dbo.evolution_history')
)
BEGIN
  CREATE INDEX IX_evolution_history_decision_scope
    ON dbo.evolution_history (decision, scope, decided_at DESC);
END

  COMMIT TRANSACTION;
END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
  THROW;
END CATCH;
GO

