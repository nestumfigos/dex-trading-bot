// Signal archive utility: rolling window + compressed archive
'use strict';

const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

const ARCHIVE_PATH = path.join(__dirname, '../../logs/signals-archive.jsonl.gz');
const MAX_SIGNALS = 1000;

function archiveSignals(signals) {
  if (!Array.isArray(signals) || signals.length === 0) return;
  const lines = signals.map((s) => JSON.stringify(s)).join('\n');
  const buf = Buffer.from(lines + '\n', 'utf8');
  // Append to gzip archive
  const stream = fs.createWriteStream(ARCHIVE_PATH, { flags: 'a' });
  const gzip = zlib.createGzip();
  gzip.pipe(stream);
  gzip.write(buf);
  gzip.end();
}

function enforceRollingWindow(recentSignals, newSignal) {
  recentSignals.push(newSignal);
  if (recentSignals.length > MAX_SIGNALS) {
    const toArchive = recentSignals.splice(0, recentSignals.length - MAX_SIGNALS);
    archiveSignals(toArchive);
  }
}

// Simple search in archive (by token, date, or signal type)
function searchArchive({ symbol, from, to, signal }, cb) {
  const results = [];
  const gunzip = zlib.createGunzip();
  const stream = fs.createReadStream(ARCHIVE_PATH);
  stream.pipe(gunzip);
  let buffer = '';
  gunzip.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (symbol && obj.symbol !== symbol) continue;
        if (signal && obj.finalSignal !== signal) continue;
        if (from && new Date(obj.timestamp) < new Date(from)) continue;
        if (to && new Date(obj.timestamp) > new Date(to)) continue;
        results.push(obj);
        if (results.length >= 1000) break;
      } catch {}
    }
  });
  gunzip.on('end', () => cb(null, results));
  gunzip.on('error', (err) => cb(err, results));
}

module.exports = { enforceRollingWindow, searchArchive, MAX_SIGNALS, ARCHIVE_PATH };
