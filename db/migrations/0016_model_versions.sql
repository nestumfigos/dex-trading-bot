BEGIN TRANSACTION;
BEGIN TRY

-- M017: ml_model_versions
-- Tracks every ML artifact trained (.pkl, .pt). `active=1` row per (name, scope)
-- is what the bot loads; previous versions retained for rollback. Distinct from
-- pre-existing dbo.model_versions which serves promotion-governance versions
-- (config snapshots + regime family); this one is for ML model artifacts.

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'ml_model_versions' AND schema_id = SCHEMA_ID('dbo'))
BEGIN
  CREATE TABLE dbo.ml_model_versions (
    id                INT IDENTITY(1,1) PRIMARY KEY,
    name              NVARCHAR(64)  NOT NULL,                      -- 'xgboost' | 'random_forest' | 'lstm_sequence' | 'rl_policy'
    version           NVARCHAR(64)  NOT NULL,                      -- 'production-v1' | 'candidate-2026-05-17'
    scope             NVARCHAR(32)  NOT NULL DEFAULT 'global',
    artifact_path     NVARCHAR(512) NOT NULL,                      -- relative path under artifacts/models/
    artifact_sha256   NVARCHAR(128) NULL,                          -- integrity check
    framework         NVARCHAR(32)  NULL,                          -- 'xgboost' | 'sklearn' | 'pytorch'
    train_samples     INT           NULL,
    train_started_at  DATETIME2     NULL,
    train_finished_at DATETIME2     NULL,
    metrics_json      NVARCHAR(MAX) NULL,                          -- {auc, precision, recall, log_loss, ...}
    config_json       NVARCHAR(MAX) NULL,                          -- training hyperparameters
    feature_columns   NVARCHAR(MAX) NULL,                          -- CSV or JSON array
    promoted_at       DATETIME2     NULL,                          -- when this version went active
    retired_at        DATETIME2     NULL,                          -- when superseded (NULL = current/never promoted)
    active            BIT           NOT NULL DEFAULT 0,            -- 1 = currently loaded
    source            NVARCHAR(64)  NOT NULL DEFAULT 'manual',     -- manual | auto_retrain | self_evolution
    notes             NVARCHAR(512) NULL,
    created_at        DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME(),
    bot_version       NVARCHAR(64)  NULL
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


-- One active row per (name, scope) — what the bot loads.
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='UX_ml_model_versions_name_scope_active' AND object_id=OBJECT_ID('dbo.ml_model_versions'))
BEGIN
  CREATE UNIQUE INDEX UX_ml_model_versions_name_scope_active
    ON dbo.ml_model_versions (name, scope)
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


-- Version history per model.
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_ml_model_versions_name_created' AND object_id=OBJECT_ID('dbo.ml_model_versions'))
BEGIN
  CREATE INDEX IX_ml_model_versions_name_created
    ON dbo.ml_model_versions (name, created_at DESC)
    INCLUDE (version, scope, active, retired_at);
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


-- Stale artifact sweep (find retired but not yet deleted from disk).
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_ml_model_versions_retired_at' AND object_id=OBJECT_ID('dbo.ml_model_versions'))
BEGIN
  CREATE INDEX IX_ml_model_versions_retired_at
    ON dbo.ml_model_versions (retired_at ASC)
    INCLUDE (name, artifact_path)
    WHERE retired_at IS NOT NULL;
END

  COMMIT TRANSACTION;
END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
  THROW;
END CATCH;
GO

