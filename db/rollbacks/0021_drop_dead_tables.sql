-- Rollback M0021: re-create the dropped tables (empty — row data not recoverable).
-- Mirrors the original M0004 + M0014 schema.
BEGIN TRANSACTION;
BEGIN TRY

  -- indicator_weights (was M0004)
  IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'indicator_weights' AND schema_id = SCHEMA_ID('dbo'))
  BEGIN
    CREATE TABLE dbo.indicator_weights (
      id              INT IDENTITY(1,1) PRIMARY KEY,
      indicator       NVARCHAR(64)  NOT NULL,
      bucket          NVARCHAR(64)  NOT NULL,
      scope           NVARCHAR(32)  NOT NULL DEFAULT 'global',
      strategy        NVARCHAR(32)  NULL,
      samples         INT           NOT NULL DEFAULT 0,
      wins            INT           NOT NULL DEFAULT 0,
      losses          INT           NOT NULL DEFAULT 0,
      win_rate        FLOAT         NOT NULL DEFAULT 0.0,
      weight          FLOAT         NOT NULL DEFAULT 1.0,
      avg_pnl_pct     FLOAT         NULL,
      last_outcome_at DATETIME2     NULL,
      updated_at      DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME(),
      created_at      DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME()
    );
  END;

  IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
    WHERE name = 'UX_indicator_weights_indicator_bucket_scope_strategy'
      AND object_id = OBJECT_ID('dbo.indicator_weights')
  )
    CREATE UNIQUE INDEX UX_indicator_weights_indicator_bucket_scope_strategy
      ON dbo.indicator_weights (indicator, bucket, scope, strategy);

  IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
    WHERE name = 'IX_indicator_weights_indicator_scope'
      AND object_id = OBJECT_ID('dbo.indicator_weights')
  )
    CREATE INDEX IX_indicator_weights_indicator_scope
      ON dbo.indicator_weights (indicator, scope)
      INCLUDE (bucket, weight, win_rate, samples);

  -- regime_patterns (was M0014)
  IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'regime_patterns' AND schema_id = SCHEMA_ID('dbo'))
  BEGIN
    CREATE TABLE dbo.regime_patterns (
      id                  INT IDENTITY(1,1) PRIMARY KEY,
      regime              NVARCHAR(64)  NOT NULL,
      strategy            NVARCHAR(32)  NOT NULL,
      scope               NVARCHAR(32)  NOT NULL DEFAULT 'global',
      recommendation      NVARCHAR(32)  NOT NULL,
      size_multiplier     FLOAT         NOT NULL DEFAULT 1.0,
      preferred_chains    NVARCHAR(256) NULL,
      avoid_chains        NVARCHAR(256) NULL,
      confidence          FLOAT         NULL,
      samples             INT           NULL,
      win_rate            FLOAT         NULL,
      avg_pnl_pct         FLOAT         NULL,
      source              NVARCHAR(64)  NOT NULL DEFAULT 'ml_retrain',
      active              BIT           NOT NULL DEFAULT 1,
      measured_at         DATETIME2     NULL,
      created_at          DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME(),
      updated_at          DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME()
    );
  END;

  IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
    WHERE name = 'UX_regime_patterns_regime_strat_scope_active'
      AND object_id = OBJECT_ID('dbo.regime_patterns')
  )
    CREATE UNIQUE INDEX UX_regime_patterns_regime_strat_scope_active
      ON dbo.regime_patterns (regime, strategy, scope)
      WHERE active = 1;

  IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
    WHERE name = 'IX_regime_patterns_measured_at'
      AND object_id = OBJECT_ID('dbo.regime_patterns')
  )
    CREATE INDEX IX_regime_patterns_measured_at ON dbo.regime_patterns (measured_at DESC)
      INCLUDE (regime, strategy, recommendation, confidence);

  COMMIT TRANSACTION;
END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
  THROW;
END CATCH;
GO
