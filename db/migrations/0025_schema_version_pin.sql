BEGIN TRANSACTION;
BEGIN TRY

-- B1.8: schema_version pin. Phase A audit 07-sql.md #1 flagged that live/paper
-- DBs could end up at different migration states without a single source of
-- truth pinning which migration the codebase expects. This adds a single-row
-- table that init-sql.js can read to assert version parity before starting
-- the trading loop.
--
-- Each successful M-script applies an UPSERT to record "this version is now
-- committed". A boot-time check refuses to trade if `currentVersion <
-- expectedVersion` (DB behind code) — a code deploy ahead of a missing
-- migration is a known data-loss scenario per the audit.

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name='_schema_version' AND schema_id=SCHEMA_ID('dbo'))
BEGIN
  CREATE TABLE dbo._schema_version (
    -- Single-row table; locked to id=1 by check constraint.
    id              INT NOT NULL PRIMARY KEY,
    current_version INT NOT NULL,
    applied_at      DATETIME2 NOT NULL CONSTRAINT DF_schema_version_applied DEFAULT SYSUTCDATETIME(),
    notes           NVARCHAR(MAX) NULL,
    CONSTRAINT CK_schema_version_singleton CHECK (id = 1)
  );
END;

MERGE dbo._schema_version AS target
USING (SELECT 1 AS id, 25 AS current_version) AS source
ON target.id = source.id
WHEN MATCHED THEN UPDATE SET
    current_version = source.current_version,
    applied_at      = SYSUTCDATETIME(),
    notes           = N'B1.8 pin applied via M0025'
WHEN NOT MATCHED THEN INSERT (id, current_version, notes)
    VALUES (source.id, source.current_version, N'B1.8 pin applied via M0025');

COMMIT TRANSACTION;
END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
  THROW;
END CATCH;
