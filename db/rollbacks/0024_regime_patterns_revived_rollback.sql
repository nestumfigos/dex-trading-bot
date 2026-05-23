BEGIN TRANSACTION;
BEGIN TRY

-- Rollback M0024: drop regime_patterns table + indexes (mirror of M0021's drop).
IF EXISTS (
  SELECT 1 FROM sys.indexes
  WHERE name = 'IX_regime_patterns_measured_at'
    AND object_id = OBJECT_ID('dbo.regime_patterns')
)
  DROP INDEX IX_regime_patterns_measured_at ON dbo.regime_patterns;

IF EXISTS (
  SELECT 1 FROM sys.indexes
  WHERE name = 'IX_regime_patterns_lookup'
    AND object_id = OBJECT_ID('dbo.regime_patterns')
)
  DROP INDEX IX_regime_patterns_lookup ON dbo.regime_patterns;

IF OBJECT_ID('dbo.regime_patterns', 'U') IS NOT NULL
  DROP TABLE dbo.regime_patterns;

  COMMIT TRANSACTION;
END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
  THROW;
END CATCH;
GO
