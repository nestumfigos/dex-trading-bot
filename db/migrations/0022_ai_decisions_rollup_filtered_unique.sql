-- M0022: convert UX_ai_decisions_rollup_day to a filtered unique index that excludes
-- NULL model rows. SQL Server treats multiple NULLs in a unique index as distinct,
-- which works but is brittle if the column semantics ever change. Filtered unique
-- with WHERE model IS NOT NULL captures intent and stays valid if NULL counts grow.
BEGIN TRANSACTION;
BEGIN TRY

  IF EXISTS (
    SELECT 1 FROM sys.indexes
    WHERE name = 'UX_ai_decisions_rollup_day'
      AND object_id = OBJECT_ID('dbo.ai_decisions_rollup')
  )
  BEGIN
    DROP INDEX UX_ai_decisions_rollup_day ON dbo.ai_decisions_rollup;
  END;

  IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
    WHERE name = 'UX_ai_decisions_rollup_day_filtered'
      AND object_id = OBJECT_ID('dbo.ai_decisions_rollup')
  )
  BEGIN
    CREATE UNIQUE INDEX UX_ai_decisions_rollup_day_filtered
      ON dbo.ai_decisions_rollup (day, scope, provider, model, purpose)
      WHERE model IS NOT NULL;
  END;

  COMMIT TRANSACTION;
END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
  THROW;
END CATCH;
GO
