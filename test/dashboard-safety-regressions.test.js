'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const dashboardSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.js'), 'utf8');
const frontendSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'dashboard.js'), 'utf8');
const htmlSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

test('sensitive diagnostic dashboard routes require protected access', () => {
  assert.match(dashboardSource, /app\.get\('\/api\/signals\/archive-search', requireDiagnosticAccess/);
  assert.match(dashboardSource, /app\.get\('\/api\/ai-health', requireDiagnosticAccess/);
  assert.match(dashboardSource, /app\.get\('\/api\/ai-quota', requireDiagnosticAccess/);
  assert.match(dashboardSource, /app\.get\('\/api\/correlation', requireAdminToken/);
  assert.match(dashboardSource, /app\.post\('\/api\/admin\/sell-position', requireAdminToken/);
  assert.match(dashboardSource, /app\.post\('\/api\/admin\/safe-mode\/clear', requireAdminToken/);
  assert.doesNotMatch(dashboardSource, /app\.get\('\/api\/admin\/safe-mode\/clear'/);
  assert.match(dashboardSource, /TradingView webhook secret is required when enabled/);
  assert.match(dashboardSource, /chain:\s*payload\.chain/);
  assert.match(dashboardSource, /ttlMs:\s*Number\(config\.webhooks\?\.tradingViewMaxAgeMs/);
  assert.match(dashboardSource, /Access-Control-Allow-Origin/);
  assert.doesNotMatch(dashboardSource, /DASHBOARD_CORS_ORIGIN \|\| '\*'/);
  assert.match(dashboardSource, /\['3001', '3002'\]\.includes\(parsed\.port\)/);
});

test('dashboard does not present unknown trade or 24h PnL as profit', () => {
  assert.doesNotMatch(frontendSource, /compute24hPnl\(portfolio\.pnlHistory\) \?\? unrealizedPnl/);
  assert.match(frontendSource, /const rawPnl = t\.pnl \?\? t\.realizedPnl/);
  assert.match(frontendSource, /Authorization: `Bearer \$\{token\}`/);
  assert.match(frontendSource, /fetch\(getBaseUrl\(\) \+ '\/api\/admin\/sell-position'/);
  assert.match(frontendSource, /renderTrades\(\[\]\)/);
  assert.match(frontendSource, /p\.unrealizedPnl == null \? null/);
  assert.match(frontendSource, /Unavailable/);
  assert.match(frontendSource, /const portBot = window\.location\.port === '3001' \? 'paper' : 'live'/);
  assert.match(frontendSource, /localStorage\.getItem\('dt\.botExplicit'\) === 'true'/);
  assert.match(frontendSource, /window\.location\.hash\.slice\(1\)/);
});

test('paper dashboard exposes read-only paper perp history without enabling live execution', () => {
  assert.match(dashboardSource, /app\.get\('\/api\/perps\/trades'/);
  assert.match(dashboardSource, /liveExecutionEnabled:\s*false/);
  assert.match(frontendSource, /paperApi\('\/api\/perps\/trades'\)/);
  assert.match(htmlSource, /data-view="perp-trades"/);
  assert.match(htmlSource, /Live perps execution is disabled\./);
  assert.match(frontendSource, /historyStatus === 'unavailable'/);
});

test('paper dashboard exposes research-only perps replays and walk-forward validation', () => {
  assert.match(dashboardSource, /app\.post\('\/api\/perps\/backtests\/traderxo'/);
  assert.match(dashboardSource, /app\.post\('\/api\/perps\/backtests\/traderxo', requireWriteAccess/);
  assert.match(dashboardSource, /app\.post\('\/api\/perps\/backtests\/traderxo\/study', requireWriteAccess/);
  assert.match(dashboardSource, /app\.post\('\/api\/perps\/backtests\/traderxo\/walk-forward', requireWriteAccess/);
  assert.match(dashboardSource, /app\.get\('\/api\/perps\/backtests\/traderxo\/study\/latest'/);
  assert.match(dashboardSource, /app\.get\('\/api\/perps\/backtests\/traderxo\/walk-forward\/latest'/);
  assert.match(dashboardSource, /app\.post\('\/api\/perps\/backtests\/traderxo\/benchmark', requireWriteAccess/);
  assert.match(dashboardSource, /app\.get\('\/api\/perps\/backtests\/traderxo\/benchmark\/latest'/);
  assert.match(dashboardSource, /persistsPaperTrades:\s*false/);
  assert.match(frontendSource, /paperPost\('\/api\/perps\/backtests\/traderxo'/);
  assert.match(frontendSource, /\.\.\.\(token \? \{ Authorization: `Bearer \$\{token\}` \} : \{\}\)/);
  assert.match(frontendSource, /runPerpWalkForward/);
  assert.match(frontendSource, /runPerpBenchmark/);
  assert.match(htmlSource, /data-view="perp-backtests"/);
  assert.match(htmlSource, /Historical replay never creates paper trades or enables live perps\./);
});

test('dashboard does not claim operational status during an active incident', () => {
  assert.match(frontendSource, /Attention Required/);
  assert.match(frontendSource, /status\.health\?\.incident\?\.active/);
});
