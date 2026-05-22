BEGIN TRANSACTION;
BEGIN TRY

-- M012: health_checks
-- Per-cycle canary log. Each row = one canary run with check-by-check pass/fail.
-- 30d retention. Read by dashboard /api/health panel.

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'health_checks' AND schema_id = SCHEMA_ID('dbo'))
BEGIN
  CREATE TABLE dbo.health_checks (
    id              BIGINT IDENTITY(1,1) PRIMARY KEY,
    checked_at      DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME(),
    scope           NVARCHAR(32)  NOT NULL DEFAULT 'global',  -- live | paper
    overall_status  NVARCHAR(16)  NOT NULL,                    -- PASS | WARN | FAIL
    check_name      NVARCHAR(64)  NOT NULL,                    -- 'memory_mtime' | 'sql_latency' | 'lock_files' | ...
    status          NVARCHAR(16)  NOT NULL,                    -- PASS | WARN | FAIL | SKIPPED
    value_observed  NVARCHAR(256) NULL,                        -- '1500ms' | '12 positions' | '450MB'
    threshold       NVARCHAR(256) NULL,                        -- '<2000ms' | '>500MB'
    message         NVARCHAR(1024) NULL,
    recovery_hint   NVARCHAR(512) NULL,
    duration_ms     INT           NULL,
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


-- Hot scan: dashboard latest + recent canary status.
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_health_checks_checked_at' AND object_id = OBJECT_ID('dbo.health_checks'))
BEGIN
  CREATE INDEX IX_health_checks_checked_at
    ON dbo.health_checks (checked_at DESC)
    INCLUDE (scope, overall_status, check_name, status);
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


-- Per-check trend.
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_health_checks_check_name' AND object_id = OBJECT_ID('dbo.health_checks'))
BEGIN
  CREATE INDEX IX_health_checks_check_name
    ON dbo.health_checks (check_name, scope, checked_at DESC)
    INCLUDE (status, value_observed);
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


-- Failure-only filter.
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_health_checks_failures' AND object_id = OBJECT_ID('dbo.health_checks'))
BEGIN
  CREATE INDEX IX_health_checks_failures
    ON dbo.health_checks (scope, checked_at DESC)
    INCLUDE (check_name, status, message)
    WHERE status = 'FAIL';
END

  COMMIT TRANSACTION;
END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
  THROW;
END CATCH;
GO

