-- M0019: add FK signals.ai_decision_id -> ai_decisions.id ON DELETE SET NULL.
-- Day 5 fix: ai_decision_id was added in M0012 but never constrained, allowing orphaned references.
BEGIN TRANSACTION;
BEGIN TRY

  -- Confirm both columns exist before adding FK.
  IF COL_LENGTH('dbo.signals', 'ai_decision_id') IS NOT NULL
     AND COL_LENGTH('dbo.ai_decisions', 'id') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM sys.foreign_keys WHERE name = 'FK_signals_ai_decision_id'
     )
  BEGIN
    ALTER TABLE dbo.signals
      ADD CONSTRAINT FK_signals_ai_decision_id
      FOREIGN KEY (ai_decision_id) REFERENCES dbo.ai_decisions(id)
      ON DELETE SET NULL;
  END;

  COMMIT TRANSACTION;
END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
  THROW;
END CATCH;
GO
