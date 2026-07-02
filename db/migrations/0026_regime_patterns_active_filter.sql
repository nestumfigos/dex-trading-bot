BEGIN TRANSACTION;
BEGIN TRY

-- B3.sql.7: filtered index for active rows.
-- M0024 created IX_regime_patterns_lookup as a non-unique index covering all
-- rows on (regime, strategy, scope, active). Phase A audit 07-sql.md #7
-- flagged that the trading loop only ever queries `active = 1` rows, so
-- the index scans an ever-growing tombstone tail of `active = 0` history.
-- Drop and recreate with `WHERE active = 1` so the index stays small and
-- selective. Cannot edit M0024 in place (migration checksums are pinned).

IF EXISTS (
  SELECT 1 FROM sys.indexes
  WHERE name = 'IX_regime_patterns_lookup'
    AND object_id = OBJECT_ID('dbo.regime_patterns')
)
BEGIN
  DROP INDEX IX_regime_patterns_lookup ON dbo.regime_patterns;
END

CREATE INDEX IX_regime_patterns_lookup
  ON dbo.regime_patterns(regime, strategy, scope)
  INCLUDE (size_multiplier, preferred_chains, avoid_chains, recommendation, measured_at)
  WHERE active = 1;

-- Stamp the schema_version pin (B1.8) so boot-time parity check sees 26.
IF EXISTS (SELECT 1 FROM sys.tables WHERE name='_schema_version' AND schema_id=SCHEMA_ID('dbo'))
BEGIN
  UPDATE dbo._schema_version
  SET current_version = 26,
      applied_at      = SYSUTCDATETIME(),
      notes           = N'B3.sql.7 filtered active index via M0026'
  WHERE id = 1;
END

COMMIT TRANSACTION;
END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
  THROW;
END CATCH;
