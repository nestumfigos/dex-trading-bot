-- Rollback M0022: restore the non-filtered unique index.
BEGIN TRANSACTION;
BEGIN TRY

  IF EXISTS (
    SELECT 1 FROM sys.indexes
    WHERE name = 'UX_ai_decisions_rollup_day_filtered'
      AND object_id = OBJECT_ID('dbo.ai_decisions_rollup')
  )
  BEGIN
    DROP INDEX UX_ai_decisions_rollup_day_filtered ON dbo.ai_decisions_rollup;
  END;

  IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
    WHERE name = 'UX_ai_decisions_rollup_day'
      AND object_id = OBJECT_ID('dbo.ai_decisions_rollup')
  )
  BEGIN
    CREATE UNIQUE INDEX UX_ai_decisions_rollup_day
      ON dbo.ai_decisions_rollup (day, scope, provider, model, purpose);
  END;

  COMMIT TRANSACTION;
END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
  THROW;
END CATCH;
GO
