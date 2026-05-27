#!/usr/bin/env node
'use strict';

// B6P.mm-refresh: pull current binance USD-M leverage-bracket table and emit
// an updated TIERS map for src/strategies/perps-maintenance-margin.js.
//
// Usage:
//   node scripts/refresh-mm-tiers.js                 # print to stdout
//   node scripts/refresh-mm-tiers.js --write         # patch the source file
//   node scripts/refresh-mm-tiers.js --symbol BTCUSDT,ETHUSDT,SOLUSDT
//
// Requires Node 18+ (uses global fetch). No signing needed — leverageBracket
// is a public endpoint.

const fs = require('fs');
const path = require('path');

const DEFAULT_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
const BINANCE_URL = 'https://fapi.binance.com/fapi/v1/leverageBracket';

function parseArgs(argv) {
  const args = { write: false, symbols: DEFAULT_SYMBOLS };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--write') args.write = true;
    else if (argv[i] === '--symbol' || argv[i] === '--symbols') {
      args.symbols = String(argv[i + 1] || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
      i += 1;
    }
  }
  if (args.symbols.length === 0) args.symbols = DEFAULT_SYMBOLS;
  return args;
}

async function fetchBrackets() {
  if (typeof fetch !== 'function') throw new Error('fetch unavailable (Node 18+ required)');
  const res = await fetch(BINANCE_URL);
  if (!res.ok) throw new Error(`Binance leverageBracket HTTP ${res.status}`);
  return res.json();
}

function bracketToTier(bracket) {
  // Binance shape: { bracket, initialLeverage, notionalCap, notionalFloor,
  //                  maintMarginRatio, cum }
  return {
    upToNotionalUsd: Number(bracket.notionalCap) >= 1e18 ? Infinity : Number(bracket.notionalCap),
    maintenanceMarginRatio: Number(bracket.maintMarginRatio),
    maxLeverage: Number(bracket.initialLeverage),
  };
}

function tiersForSymbol(allBrackets, symbol) {
  const entry = allBrackets.find((row) => String(row.symbol).toUpperCase() === symbol);
  if (!entry || !Array.isArray(entry.brackets)) return null;
  return entry.brackets
    .sort((a, b) => Number(a.notionalCap) - Number(b.notionalCap))
    .map(bracketToTier);
}

function formatTiers(tiersBySymbol) {
  const lines = ['const TIERS = {'];
  for (const [sym, tiers] of Object.entries(tiersBySymbol)) {
    lines.push(`  ${sym}: [`);
    for (const t of tiers) {
      const cap = t.upToNotionalUsd === Infinity ? 'Infinity' : t.upToNotionalUsd.toString();
      lines.push(`    { upToNotionalUsd: ${cap.padEnd(15)} maintenanceMarginRatio: ${t.maintenanceMarginRatio}, maxLeverage: ${t.maxLeverage} },`);
    }
    lines.push('  ],');
  }
  lines.push('};');
  return lines.join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const brackets = await fetchBrackets();
  const tiersBySymbol = {};
  for (const sym of args.symbols) {
    const tiers = tiersForSymbol(brackets, sym);
    if (!tiers) {
      console.error(`[refresh-mm-tiers] symbol not found in binance response: ${sym}`);
      continue;
    }
    tiersBySymbol[sym] = tiers;
  }
  const block = formatTiers(tiersBySymbol);
  if (!args.write) {
    console.log(block);
    return;
  }
  const target = path.join(__dirname, '..', 'src', 'strategies', 'perps-maintenance-margin.js');
  let source = fs.readFileSync(target, 'utf8');
  const startIdx = source.indexOf('const TIERS = {');
  if (startIdx === -1) throw new Error(`Could not locate "const TIERS = {" in ${target}`);
  // Find matching closing brace via simple brace counting.
  let i = source.indexOf('{', startIdx);
  let depth = 1;
  while (i < source.length && depth > 0) {
    i += 1;
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') depth -= 1;
  }
  if (depth !== 0) throw new Error('Unbalanced braces while locating TIERS block end');
  // Find the semicolon after the closing brace.
  let endIdx = i + 1;
  while (endIdx < source.length && source[endIdx] !== ';') endIdx += 1;
  endIdx += 1; // include the semicolon
  const before = source.slice(0, startIdx);
  const after = source.slice(endIdx);
  source = before + block + after;
  fs.writeFileSync(target, source);
  console.log(`[refresh-mm-tiers] wrote updated TIERS table to ${target}`);
}

main().catch((err) => {
  console.error(`[refresh-mm-tiers] FAILED: ${err.message}`);
  process.exit(1);
});
