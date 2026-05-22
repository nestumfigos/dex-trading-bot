-- Rollback M0020
IF EXISTS (
  SELECT 1 FROM sys.indexes
  WHERE name = 'IX_config_changes_scope_knob_changed_at'
    AND object_id = OBJECT_ID('dbo.config_changes')
)
  DROP INDEX IX_config_changes_scope_knob_changed_at ON dbo.config_changes;
GO
