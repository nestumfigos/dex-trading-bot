IF EXISTS (SELECT 1 FROM sys.tables WHERE name = '_schema_version' AND schema_id = SCHEMA_ID('dbo'))
BEGIN
  DROP TABLE dbo._schema_version;
END;
