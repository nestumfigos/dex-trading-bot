BEGIN TRANSACTION;
BEGIN TRY

-- M0024: regime_patterns revived.
-- Original M0014 created the table; M0021 (2026-05-22) dropped it as "never
-- wired into runtime code". W16.5 (2026-05-23) wires src/agent/regime-patterns.js
-- + src/index.js:1679 sizing chain. Re-create the table so the wire is
-- usable. Schema mirrors M0014 exactly so seeder scripts work unchanged.

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name='regime_patterns' AND schema_id=SCHEMA_ID('dbo'))
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

-- Query support: filter active rows by (regime, strategy, scope) ordered by recency.
IF NOT EXISTS (
  SELECT 1 FROM sys.indexes
  WHERE name = 'IX_regime_patterns_lookup'
    AND object_id = OBJECT_ID('dbo.regime_patterns')
)
BEGIN
  CREATE INDEX IX_regime_patterns_lookup
    ON dbo.regime_patterns(regime, strategy, scope, active)
    INCLUDE (size_multiplier, preferred_chains, avoid_chains, recommendation);
END

-- Time-ordered lookup for "latest active row".
IF NOT EXISTS (
  SELECT 1 FROM sys.indexes
  WHERE name = 'IX_regime_patterns_measured_at'
    AND object_id = OBJECT_ID('dbo.regime_patterns')
)
BEGIN
  CREATE INDEX IX_regime_patterns_measured_at
    ON dbo.regime_patterns(measured_at DESC);
END

  COMMIT TRANSACTION;
END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
  THROW;
END CATCH;
GO
