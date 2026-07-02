-- M0020: index on (scope, knob, changed_at DESC) — hot queries filter by scope+knob.
-- Existing indexes cover knob or changed_at alone but not the composite hot path.
BEGIN TRANSACTION;
BEGIN TRY

  IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
    WHERE name = 'IX_config_changes_scope_knob_changed_at'
      AND object_id = OBJECT_ID('dbo.config_changes')
  )
  BEGIN
    CREATE INDEX IX_config_changes_scope_knob_changed_at
      ON dbo.config_changes(scope, knob, changed_at DESC);
  END;

  COMMIT TRANSACTION;
END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
  THROW;
END CATCH;
GO
