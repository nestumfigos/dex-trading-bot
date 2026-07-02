IF EXISTS (
  SELECT 1 FROM sys.indexes
  WHERE name = 'IX_regime_patterns_lookup'
    AND object_id = OBJECT_ID('dbo.regime_patterns')
)
BEGIN
  DROP INDEX IX_regime_patterns_lookup ON dbo.regime_patterns;
END;

IF NOT EXISTS (
  SELECT 1 FROM sys.indexes
  WHERE name = 'IX_regime_patterns_lookup'
    AND object_id = OBJECT_ID('dbo.regime_patterns')
)
AND EXISTS (
  SELECT 1 FROM sys.tables
  WHERE name = 'regime_patterns'
    AND schema_id = SCHEMA_ID('dbo')
)
BEGIN
  CREATE INDEX IX_regime_patterns_lookup
    ON dbo.regime_patterns(regime, strategy, scope, active)
    INCLUDE (size_multiplier, preferred_chains, avoid_chains, recommendation, measured_at);
END;

IF EXISTS (SELECT 1 FROM sys.tables WHERE name = '_schema_version' AND schema_id = SCHEMA_ID('dbo'))
BEGIN
  UPDATE dbo._schema_version
  SET current_version = 25,
      applied_at = SYSUTCDATETIME(),
      notes = N'Rollback from M0026 filtered active index'
  WHERE id = 1;
END;
