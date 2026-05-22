BEGIN TRANSACTION;
BEGIN TRY

-- M009: risk_rules
-- Catalog of risk gates registered by the pre-trade contract. Each gate can be
-- toggled active/inactive + severity adjusted without code change.
-- Severity enum (validated in code): block | warn | log

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'risk_rules' AND schema_id = SCHEMA_ID('dbo'))
BEGIN
  CREATE TABLE dbo.risk_rules (
    id            INT IDENTITY(1,1) PRIMARY KEY,
    name          NVARCHAR(64)  NOT NULL,                    -- e.g. 'tier_feasibility'
    scope         NVARCHAR(32)  NOT NULL DEFAULT 'global',   -- live | paper | global
    severity      NVARCHAR(16)  NOT NULL DEFAULT 'block',    -- block | warn | log
    enabled       BIT           NOT NULL DEFAULT 1,
    description   NVARCHAR(512) NULL,
    config_json   NVARCHAR(MAX) NULL,                        -- per-rule tunables
    source        NVARCHAR(64)  NOT NULL DEFAULT 'manual',   -- manual | seed | self_evolution
    created_at    DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME(),
    updated_at    DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME(),
    updated_by    NVARCHAR(128) NULL
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


-- Unique rule per (name, scope). Hot lookup by pre-trade contract.
IF NOT EXISTS (
  SELECT 1 FROM sys.indexes
   WHERE name = 'UX_risk_rules_name_scope'
     AND object_id = OBJECT_ID('dbo.risk_rules')
)
BEGIN
  CREATE UNIQUE INDEX UX_risk_rules_name_scope
    ON dbo.risk_rules (name, scope);
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


-- Filter: enabled rules per scope (hot list at every trade attempt).
IF NOT EXISTS (
  SELECT 1 FROM sys.indexes
   WHERE name = 'IX_risk_rules_scope_enabled'
     AND object_id = OBJECT_ID('dbo.risk_rules')
)
BEGIN
  CREATE INDEX IX_risk_rules_scope_enabled
    ON dbo.risk_rules (scope, enabled)
    INCLUDE (name, severity);
END

  COMMIT TRANSACTION;
END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
  THROW;
END CATCH;
GO

