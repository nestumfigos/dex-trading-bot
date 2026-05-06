 'use strict';
 
 // One-time SQL init for telemetry tables + KPI views.
 // Does NOT require SQL_ENABLED=true.
 
 const sql = require('mssql');
 
 function getArg(flag) {
   const idx = process.argv.indexOf(flag);
   if (idx === -1) return null;
   return process.argv[idx + 1] || null;
 }
 
 function required(value, name) {
   if (!value) throw new Error(`Missing ${name}. Provide it via --conn or env.`);
   return value;
 }
 
 async function main() {
   const conn = getArg('--conn') || process.env.SQL_INIT_CONNECTION_STRING || process.env.SQL_CONNECTION_STRING;
   required(conn, 'connection string');
 
   const pool = await sql.connect(conn);
 
   const ddl = `
 -- Runs
 IF OBJECT_ID('dbo.bot_runs', 'U') IS NULL
 BEGIN
   CREATE TABLE dbo.bot_runs (
     run_id UNIQUEIDENTIFIER NOT NULL PRIMARY KEY,
     bot_profile NVARCHAR(20) NOT NULL,
     host NVARCHAR(120) NULL,
     pid INT NULL,
     git_sha NVARCHAR(80) NULL,
     started_at DATETIME2(3) NOT NULL CONSTRAINT DF_bot_runs_started_at DEFAULT (SYSUTCDATETIME()),
     ended_at DATETIME2(3) NULL,
     exit_reason NVARCHAR(200) NULL,
     config_hash NVARCHAR(80) NULL,
     meta_json NVARCHAR(MAX) NULL
   );
   CREATE INDEX IX_bot_runs_profile_started ON dbo.bot_runs(bot_profile, started_at DESC);
 END
 
 -- Signals
 IF OBJECT_ID('dbo.signals', 'U') IS NULL
 BEGIN
   CREATE TABLE dbo.signals (
     signal_id UNIQUEIDENTIFIER NOT NULL PRIMARY KEY,
     run_id UNIQUEIDENTIFIER NULL,
     ts DATETIME2(3) NOT NULL,
     bot_profile NVARCHAR(20) NOT NULL,
     chain NVARCHAR(30) NULL,
     chain_key NVARCHAR(30) NULL,
     symbol NVARCHAR(40) NULL,
     address NVARCHAR(120) NULL,
     strategy NVARCHAR(30) NULL,
     final_signal NVARCHAR(30) NULL,
     technical_signal NVARCHAR(30) NULL,
     signal_source NVARCHAR(80) NULL,
     confidence FLOAT NULL,
     ai_confidence FLOAT NULL,
     ai_reason NVARCHAR(400) NULL,
     risk_flags_json NVARCHAR(MAX) NULL,
     features_json NVARCHAR(MAX) NULL,
     gate_json NVARCHAR(MAX) NULL,
     reject_reasons_json NVARCHAR(MAX) NULL
   );
   CREATE INDEX IX_signals_ts ON dbo.signals(ts DESC);
   CREATE INDEX IX_signals_symbol_chain_ts ON dbo.signals(symbol, chain_key, ts DESC);
   CREATE INDEX IX_signals_run_ts ON dbo.signals(run_id, ts DESC);
 END
 
 -- Orders
 IF OBJECT_ID('dbo.orders', 'U') IS NULL
 BEGIN
   CREATE TABLE dbo.orders (
     order_id UNIQUEIDENTIFIER NOT NULL PRIMARY KEY,
     run_id UNIQUEIDENTIFIER NULL,
     ts DATETIME2(3) NOT NULL,
     bot_profile NVARCHAR(20) NOT NULL,
     chain NVARCHAR(30) NULL,
     chain_key NVARCHAR(30) NULL,
     symbol NVARCHAR(40) NULL,
     address NVARCHAR(120) NULL,
     side NVARCHAR(10) NOT NULL,
     strategy NVARCHAR(30) NULL,
     requested_quote_usd FLOAT NULL,
     requested_base_qty FLOAT NULL,
     expected_price FLOAT NULL,
     status NVARCHAR(30) NOT NULL,
     reason NVARCHAR(200) NULL,
     error_text NVARCHAR(800) NULL,
     client_order_key NVARCHAR(120) NULL,
     metadata_json NVARCHAR(MAX) NULL
   );
   CREATE INDEX IX_orders_ts ON dbo.orders(ts DESC);
   CREATE INDEX IX_orders_status_ts ON dbo.orders(status, ts DESC);
   CREATE INDEX IX_orders_symbol_chain_ts ON dbo.orders(symbol, chain_key, ts DESC);
 END
 
 -- Fills
 IF OBJECT_ID('dbo.fills', 'U') IS NULL
 BEGIN
   CREATE TABLE dbo.fills (
     fill_id UNIQUEIDENTIFIER NOT NULL PRIMARY KEY,
     order_id UNIQUEIDENTIFIER NOT NULL,
     ts DATETIME2(3) NOT NULL,
     txid_or_exchange_id NVARCHAR(200) NULL,
     filled_base_qty FLOAT NULL,
     filled_quote_usd FLOAT NULL,
     avg_price FLOAT NULL,
     fee_usd FLOAT NULL,
     slippage_bps FLOAT NULL,
     block_number BIGINT NULL,
     confirmations INT NULL,
     raw_receipt_json NVARCHAR(MAX) NULL
   );
   CREATE INDEX IX_fills_order_id ON dbo.fills(order_id);
   CREATE INDEX IX_fills_txid ON dbo.fills(txid_or_exchange_id);
 END
 
 -- Positions
 IF OBJECT_ID('dbo.positions', 'U') IS NULL
 BEGIN
   CREATE TABLE dbo.positions (
     position_id UNIQUEIDENTIFIER NOT NULL PRIMARY KEY,
     run_id UNIQUEIDENTIFIER NULL,
     bot_profile NVARCHAR(20) NOT NULL,
     chain NVARCHAR(30) NULL,
     chain_key NVARCHAR(30) NULL,
     symbol NVARCHAR(40) NULL,
     address NVARCHAR(120) NULL,
     strategy NVARCHAR(30) NULL,
     opened_at DATETIME2(3) NOT NULL,
     closed_at DATETIME2(3) NULL,
     entry_price FLOAT NULL,
     entry_usd FLOAT NULL,
     exit_price FLOAT NULL,
     exit_usd FLOAT NULL,
     pnl_usd FLOAT NULL,
     pnl_pct FLOAT NULL,
     exit_reason NVARCHAR(200) NULL,
     tags_json NVARCHAR(MAX) NULL
   );
   CREATE INDEX IX_positions_closed_at ON dbo.positions(closed_at DESC);
   CREATE INDEX IX_positions_symbol_chain_opened ON dbo.positions(symbol, chain_key, opened_at DESC);
 END
 
 -- Position snapshots
 IF OBJECT_ID('dbo.position_snapshots', 'U') IS NULL
 BEGIN
   CREATE TABLE dbo.position_snapshots (
     snapshot_id UNIQUEIDENTIFIER NOT NULL PRIMARY KEY,
     position_id UNIQUEIDENTIFIER NOT NULL,
     ts DATETIME2(3) NOT NULL,
     price FLOAT NULL,
     unrealized_pnl_usd FLOAT NULL,
     highest_price FLOAT NULL,
     trailing_stop FLOAT NULL,
     risk_state_json NVARCHAR(MAX) NULL
   );
   CREATE INDEX IX_position_snapshots_position_ts ON dbo.position_snapshots(position_id, ts DESC);
 END
 
 -- Ops events
 IF OBJECT_ID('dbo.ops_events', 'U') IS NULL
 BEGIN
   CREATE TABLE dbo.ops_events (
     event_id UNIQUEIDENTIFIER NOT NULL PRIMARY KEY,
     run_id UNIQUEIDENTIFIER NULL,
     bot_profile NVARCHAR(20) NOT NULL,
     ts DATETIME2(3) NOT NULL,
     severity NVARCHAR(12) NOT NULL,
     category NVARCHAR(40) NOT NULL,
     name NVARCHAR(80) NOT NULL,
     chain_key NVARCHAR(30) NULL,
     symbol NVARCHAR(40) NULL,
     duration_ms INT NULL,
     context_json NVARCHAR(MAX) NULL,
     message NVARCHAR(800) NULL
   );
   CREATE INDEX IX_ops_events_ts ON dbo.ops_events(ts DESC);
   CREATE INDEX IX_ops_events_category_name_ts ON dbo.ops_events(category, name, ts DESC);
 END
 
 -- KPI views (computed from closed positions)
 IF OBJECT_ID('dbo.v_kpi_hourly', 'V') IS NULL
 EXEC('
 CREATE VIEW dbo.v_kpi_hourly AS
 SELECT
   DATEADD(hour, DATEDIFF(hour, 0, closed_at), 0) AS bucket_start,
   bot_profile,
   ISNULL(strategy, ''unknown'') AS strategy,
   ISNULL(chain_key, ''unknown'') AS chain_key,
   COUNT(1) AS trades,
   SUM(CASE WHEN pnl_usd >= 0 THEN 1 ELSE 0 END) AS wins,
   SUM(CASE WHEN pnl_usd < 0 THEN 1 ELSE 0 END) AS losses,
   SUM(ISNULL(pnl_usd, 0)) AS pnl_usd,
   SUM(CASE WHEN pnl_usd >= 0 THEN ISNULL(pnl_usd, 0) ELSE 0 END) AS gross_profit,
   SUM(CASE WHEN pnl_usd < 0 THEN ABS(ISNULL(pnl_usd, 0)) ELSE 0 END) AS gross_loss,
   CASE
     WHEN SUM(CASE WHEN pnl_usd < 0 THEN ABS(ISNULL(pnl_usd, 0)) ELSE 0 END) = 0 THEN NULL
     ELSE
       SUM(CASE WHEN pnl_usd >= 0 THEN ISNULL(pnl_usd, 0) ELSE 0 END) /
       NULLIF(SUM(CASE WHEN pnl_usd < 0 THEN ABS(ISNULL(pnl_usd, 0)) ELSE 0 END), 0)
   END AS profit_factor,
   CASE WHEN COUNT(1) = 0 THEN NULL ELSE CAST(SUM(CASE WHEN pnl_usd >= 0 THEN 1 ELSE 0 END) AS FLOAT) / COUNT(1) END AS win_rate
 FROM dbo.positions
 WHERE closed_at IS NOT NULL
 GROUP BY DATEADD(hour, DATEDIFF(hour, 0, closed_at), 0), bot_profile, ISNULL(strategy, ''unknown''), ISNULL(chain_key, ''unknown'');
 ');
 
 IF OBJECT_ID('dbo.v_kpi_daily', 'V') IS NULL
 EXEC('
 CREATE VIEW dbo.v_kpi_daily AS
 SELECT
   CAST(closed_at AS date) AS bucket_start,
   bot_profile,
   ISNULL(strategy, ''unknown'') AS strategy,
   ISNULL(chain_key, ''unknown'') AS chain_key,
   COUNT(1) AS trades,
   SUM(CASE WHEN pnl_usd >= 0 THEN 1 ELSE 0 END) AS wins,
   SUM(CASE WHEN pnl_usd < 0 THEN 1 ELSE 0 END) AS losses,
   SUM(ISNULL(pnl_usd, 0)) AS pnl_usd,
   SUM(CASE WHEN pnl_usd >= 0 THEN ISNULL(pnl_usd, 0) ELSE 0 END) AS gross_profit,
   SUM(CASE WHEN pnl_usd < 0 THEN ABS(ISNULL(pnl_usd, 0)) ELSE 0 END) AS gross_loss,
   CASE
     WHEN SUM(CASE WHEN pnl_usd < 0 THEN ABS(ISNULL(pnl_usd, 0)) ELSE 0 END) = 0 THEN NULL
     ELSE
       SUM(CASE WHEN pnl_usd >= 0 THEN ISNULL(pnl_usd, 0) ELSE 0 END) /
       NULLIF(SUM(CASE WHEN pnl_usd < 0 THEN ABS(ISNULL(pnl_usd, 0)) ELSE 0 END), 0)
   END AS profit_factor,
   CASE WHEN COUNT(1) = 0 THEN NULL ELSE CAST(SUM(CASE WHEN pnl_usd >= 0 THEN 1 ELSE 0 END) AS FLOAT) / COUNT(1) END AS win_rate
 FROM dbo.positions
 WHERE closed_at IS NOT NULL
 GROUP BY CAST(closed_at AS date), bot_profile, ISNULL(strategy, ''unknown''), ISNULL(chain_key, ''unknown'');
 ');
 `;
 
   await pool.request().batch(ddl);
   await pool.close();
   // eslint-disable-next-line no-console
   console.log('[init-telemetry-sql] OK');
 }
 
 main().catch((e) => {
   // eslint-disable-next-line no-console
   console.error('[init-telemetry-sql] FAILED:', e.message);
   process.exit(1);
 });
