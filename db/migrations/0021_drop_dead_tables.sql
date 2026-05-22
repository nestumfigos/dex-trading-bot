-- M0021: drop dead tables (DRAFT — apply only after manual zero-usage re-verification).
--
-- Scope: `indicator_weights` (M0004) + `regime_patterns` (M0014).
-- Both tables were defined for adaptive scoring features that were never wired into
-- runtime code (zero grep hits across src/ as of 2026-05-22 audit).
--
-- INTENTIONALLY EXCLUDED: `ai_prompts` (M0010) — used by scripts/backfill-ai-prompts.js.
-- Earlier "dead" classification missed that importer.
--
-- DESTRUCTIVE: drops tables, their indexes, and any rows. Rollback recreates the
-- empty table + indexes but cannot recover row data. Take a backup before applying.
BEGIN TRANSACTION;
BEGIN TRY

  -- indicator_weights
  IF EXISTS (
    SELECT 1 FROM sys.indexes
    WHERE name = 'IX_indicator_weights_indicator_scope'
      AND object_id = OBJECT_ID('dbo.indicator_weights')
  )
    DROP INDEX IX_indicator_weights_indicator_scope ON dbo.indicator_weights;

  IF EXISTS (
    SELECT 1 FROM sys.indexes
    WHERE name = 'UX_indicator_weights_indicator_bucket_scope_strategy'
      AND object_id = OBJECT_ID('dbo.indicator_weights')
  )
    DROP INDEX UX_indicator_weights_indicator_bucket_scope_strategy ON dbo.indicator_weights;

  IF OBJECT_ID('dbo.indicator_weights', 'U') IS NOT NULL
    DROP TABLE dbo.indicator_weights;

  -- regime_patterns
  IF EXISTS (
    SELECT 1 FROM sys.indexes
    WHERE name = 'IX_regime_patterns_measured_at'
      AND object_id = OBJECT_ID('dbo.regime_patterns')
  )
    DROP INDEX IX_regime_patterns_measured_at ON dbo.regime_patterns;

  IF EXISTS (
    SELECT 1 FROM sys.indexes
    WHERE name = 'UX_regime_patterns_regime_strat_scope_active'
      AND object_id = OBJECT_ID('dbo.regime_patterns')
  )
    DROP INDEX UX_regime_patterns_regime_strat_scope_active ON dbo.regime_patterns;

  IF OBJECT_ID('dbo.regime_patterns', 'U') IS NOT NULL
    DROP TABLE dbo.regime_patterns;

  COMMIT TRANSACTION;
END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
  THROW;
END CATCH;
GO
