#!/usr/bin/env node
'use strict';

/**
 * Fix the "PRIMARY filegroup is full" warnings by inspecting the Agent database
 * data files and:
 *   1. Enabling autogrowth (-1 = unlimited up to disk capacity, FILEGROWTH = 256MB)
 *   2. Bumping the current size up by 1 GB so the next batch of inserts has room.
 *
 * Idempotent and safe to run repeatedly.
 *
 * Usage: node scripts/fix-sql-filegroup.js
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });
const sql = require('mssql');

async function main() {
  const conn = String(process.env.SQL_CONNECTION_STRING || '').trim();
  if (!conn) {
    console.error('SQL_CONNECTION_STRING is empty. Aborting.');
    process.exit(1);
  }

  console.log('Connecting to MSSQL...');
  const pool = await sql.connect(conn);

  // 1. Show the current state of the data files
  const before = await pool.request().query(`
    SELECT name, type_desc, size * 8.0 / 1024 AS size_mb,
           growth, is_percent_growth, max_size,
           physical_name
    FROM sys.database_files
  `);
  console.log('Current files:');
  console.table(before.recordset);

  const dataFile = before.recordset.find((f) => f.type_desc === 'ROWS');
  if (!dataFile) {
    console.error('No ROWS data file found. Is this an Agent DB?');
    process.exit(2);
  }

  const currentMb = Number(dataFile.size_mb);
  const targetMb = Math.max(currentMb + 1024, 2048); // grow by 1GB or to 2GB minimum

  console.log(`\nApplying:`);
  console.log(`  - Set FILEGROWTH = 256MB on file [${dataFile.name}]`);
  console.log(`  - Set MAXSIZE = UNLIMITED on file [${dataFile.name}]`);
  console.log(`  - Grow file [${dataFile.name}] from ${currentMb.toFixed(0)}MB to ${targetMb}MB`);

  // 2. Enable autogrow with sane settings (256MB chunks, unlimited cap)
  await pool.request().query(`
    ALTER DATABASE [Agent]
    MODIFY FILE (NAME = N'${dataFile.name}', FILEGROWTH = 262144KB, MAXSIZE = UNLIMITED);
  `);

  // 3. Pre-grow the file so the next ~1GB of inserts doesn't trigger autogrow lag
  try {
    await pool.request().query(`
      ALTER DATABASE [Agent]
      MODIFY FILE (NAME = N'${dataFile.name}', SIZE = ${targetMb}MB);
    `);
  } catch (err) {
    console.warn(`Pre-grow failed (drive may be full): ${err.message}`);
  }

  // 4. Same for the log file if needed
  const logFile = before.recordset.find((f) => f.type_desc === 'LOG');
  if (logFile) {
    try {
      await pool.request().query(`
        ALTER DATABASE [Agent]
        MODIFY FILE (NAME = N'${logFile.name}', FILEGROWTH = 65536KB, MAXSIZE = UNLIMITED);
      `);
    } catch (err) {
      console.warn(`Log file alter failed: ${err.message}`);
    }
  }

  // 5. Show after-state
  const after = await pool.request().query(`
    SELECT name, type_desc, size * 8.0 / 1024 AS size_mb,
           CASE WHEN is_percent_growth = 1 THEN CAST(growth AS VARCHAR) + '%'
                ELSE CAST(growth * 8 / 1024 AS VARCHAR) + ' MB' END AS growth_setting,
           CASE WHEN max_size = -1 THEN 'UNLIMITED'
                WHEN max_size = 268435456 THEN 'UNLIMITED'
                ELSE CAST(max_size * 8.0 / 1024 AS VARCHAR) + ' MB' END AS max_size
    FROM sys.database_files
  `);
  console.log('\nAfter:');
  console.table(after.recordset);

  await pool.close();
  console.log('\nDone. The "filegroup full" warnings should stop on next bot cycle.');
}

main().catch((err) => {
  console.error('Failed:', err.message);
  process.exit(3);
});
