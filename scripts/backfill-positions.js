#!/usr/bin/env node
'use strict';

/**
 * Backfill existing open positions with the fields introduced by the structured-
 * learning fixes. Without this, positions opened before the upgrade have no
 * tokenAgeBucket / entryVolumeSpike / entryLiquidityUsd / marketRegime, so when
 * they close their lessons miss the new dimensions.
 *
 * Defaults to 'unknown' / 0 where we don't have data — that's correct because
 * we genuinely don't know what those values were at entry time.
 *
 * Usage:  node scripts/backfill-positions.js [path/to/state.json]
 */

const fs = require('fs');
const path = require('path');

const target = process.argv[2] || path.resolve(__dirname, '..', 'data', 'state.json');

function backfill(filePath) {
  if (!fs.existsSync(filePath)) {
    console.error(`Not found: ${filePath}`);
    process.exit(1);
  }

  const raw = fs.readFileSync(filePath, 'utf8');
  const data = JSON.parse(raw);
  const positions = data.positions || {};
  const keys = Object.keys(positions);
  if (!keys.length) {
    console.log(`No positions to backfill in ${filePath}.`);
    return;
  }

  let updated = 0;
  for (const key of keys) {
    const p = positions[key];
    if (!p || typeof p !== 'object') continue;
    let changed = false;
    if (p.tokenAgeBucket === undefined || p.tokenAgeBucket === null) {
      p.tokenAgeBucket = 'unknown';
      changed = true;
    }
    if (p.marketRegime === undefined || p.marketRegime === null) {
      p.marketRegime = 'unknown';
      changed = true;
    }
    if (p.entryVolumeSpike === undefined || p.entryVolumeSpike === null) {
      p.entryVolumeSpike = 0;
      changed = true;
    }
    if (p.entryLiquidityUsd === undefined || p.entryLiquidityUsd === null) {
      p.entryLiquidityUsd = 0;
      changed = true;
    }
    if (p.entryRsi === undefined || p.entryRsi === null) {
      p.entryRsi = 0;
      changed = true;
    }
    // Make sure highestPrice and stopLoss are set so disaster stop / trailing logic works
    if (!Number.isFinite(Number(p.highestPrice))) {
      p.highestPrice = Number(p.entryPrice || p.currentPrice || 0);
      changed = true;
    }
    if (!Number.isFinite(Number(p.stopLoss)) && Number.isFinite(Number(p.entryPrice))) {
      // Default to 8% below entry if no stop was ever set
      p.stopLoss = Number(p.entryPrice) * 0.92;
      changed = true;
    }
    if (changed) updated += 1;
  }

  if (updated > 0) {
    const backupPath = `${filePath}.pre-position-backfill.${Date.now()}.bak`;
    fs.writeFileSync(backupPath, raw);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    console.log(`Backfilled ${updated} of ${keys.length} positions in ${filePath}`);
    console.log(`Backup: ${backupPath}`);
  } else {
    console.log(`All ${keys.length} positions already have required fields.`);
  }
}

backfill(target);
