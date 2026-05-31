'use strict';

// Config schema registry. Defines every env var the bot reads: type, default,
// min/max, source. Boot validator rejects unknown vars when STRICT_MODE.
//
// Coverage strategy: hot-reloadable strategy/risk/self-evolution knobs are
// fully typed here. Long-tail provider keys + URLs are catalogued at type=string
// without bounds. As migrations land (M002 strategy_config + Week 6 dashboard
// PATCH endpoint), fully-typed knobs become hot-swappable via DB row.

const KNOBS = {
  // ── Boot / runtime ──────────────────────────────────────────────────
  NODE_ENV: { type: 'enum', enum: ['production', 'development', 'test'], default: 'production' },
  BOT_PROFILE: { type: 'enum', enum: ['live', 'paper'], default: 'live' },
  BOT_DATA_DIR: { type: 'string', default: 'data' },
  PORT: { type: 'int', min: 1024, max: 65535, default: 3002 },
  DASHBOARD_BIND_HOST: { type: 'string', default: '127.0.0.1' },
  PAPER_TRADING: { type: 'bool', default: false },
  PAPER_BALANCE_USD: { type: 'float', min: 0, default: 10000 },

  // ── Self-evolution gates (DANGER: 2026-05-16 these are 'false' in live) ──
  SELF_EVOLUTION_ENABLED: { type: 'bool', default: false, hotReload: true },
  SELF_EVOLUTION_ALLOW_LIVE_MUTATION: { type: 'bool', default: false, hotReload: true },
  SELF_EVOLUTION_AUTO_APPLY: { type: 'bool', default: false, hotReload: true },
  SELF_EVOLUTION_ALLOW_LIVE_APPLY: { type: 'bool', default: false, hotReload: true },
  SELF_EVOLUTION_AUTO_PROMOTE: { type: 'bool', default: false, hotReload: true },
  SELF_EVOLUTION_UNSAFE_EXPERIMENTAL: { type: 'bool', default: false, hotReload: true },

  // ── Risk caps ──────────────────────────────────────────────────────
  MAX_POSITION_SIZE_PCT: { type: 'float', min: 0, max: 100, default: 3, hotReload: true },
  KUCOIN_MAX_POSITION_SIZE_PCT: { type: 'float', min: 0, max: 100, default: 30, hotReload: true },
  BSC_MAX_CONSECUTIVE_LOSSES: { type: 'int', min: 1, max: 50, default: 8, hotReload: true },
  BSC_MOMENTUM_HEAT_ALLOWANCE_PCT: { type: 'float', min: 0, max: 100, default: 60, hotReload: true },
  LIVE_BSC_ENTRIES_ENABLED: { type: 'bool', default: false, hotReload: true },

  // ── Strategy knobs ─────────────────────────────────────────────────
  MIN_LIQUIDITY_USD: { type: 'float', min: 0, default: 5000, hotReload: true },
  MIN_HOLD_HOURS: { type: 'float', min: 0, default: 0, hotReload: true },
  MOMENTUM_ENABLED: { type: 'bool', default: true, hotReload: true },
  MOMENTUM_ENABLED_CHAINS: { type: 'string', default: 'kucoin', hotReload: true },
  MOMENTUM_SELL_TIERS: { type: 'json', default: null, hotReload: true },
  MOMENTUM_ROTATION_EDGE_MIN: { type: 'float', default: null, hotReload: true },
  MOMENTUM_ROTATION_PERSISTENCE: { type: 'int', default: null, hotReload: true },
  SWING_ENABLED: { type: 'bool', default: false, hotReload: true },
  SWING_ENABLED_CHAINS: { type: 'string', default: 'kucoin', hotReload: true },
  BACKES_SWING_ENABLED: { type: 'bool', default: false, hotReload: true },
  BACKES_SWING_ENABLED_CHAINS: { type: 'string', default: 'kucoin', hotReload: true },
  BACKES_SWING_MAX_CONCURRENT_POSITIONS: { type: 'int', min: 1, default: 3, hotReload: true },
  BSC_FLOW_BREAKOUT_ENABLED: { type: 'bool', default: false, hotReload: true },
  BSC_FLOW_BREAKOUT_ENABLED_CHAINS: { type: 'string', default: 'bsc', hotReload: true },
  BSC_FLOW_BREAKOUT_MAX_CONCURRENT_POSITIONS: { type: 'int', min: 1, default: 3, hotReload: true },
  BASE_DEX_MOMENTUM_RECLAIM_ENABLED: { type: 'bool', default: false, hotReload: true },
  BASE_DEX_MOMENTUM_RECLAIM_ENABLED_CHAINS: { type: 'string', default: 'base', hotReload: true },
  BASE_DEX_MOMENTUM_RECLAIM_MAX_CONCURRENT_POSITIONS: { type: 'int', min: 1, default: 2, hotReload: true },
  SOLANA_BULL_FLAG_V2_ENABLED: { type: 'bool', default: false, hotReload: true },
  SOLANA_BULL_FLAG_V2_ENABLED_CHAINS: { type: 'string', default: 'solana', hotReload: true },
  SOLANA_BULL_FLAG_V2_MAX_CONCURRENT_POSITIONS: { type: 'int', min: 1, default: 2, hotReload: true },
  BULL_FLAG_ENABLED: { type: 'bool', default: false, hotReload: true },
  BULL_FLAG_ENABLED_CHAINS: { type: 'string', default: 'kucoin', hotReload: true },
  BULL_FLAG_SCAN_INTERVAL_SECONDS: { type: 'int', min: 60, default: 90, hotReload: true },
  BULL_FLAG_EXIT_CHECK_MINUTES: { type: 'int', min: 1, default: 15, hotReload: true },
  BULL_FLAG_MAX_CONCURRENT_POSITIONS: { type: 'int', min: 1, default: 2, hotReload: true },
  BULL_FLAG_POLE_PCT_MIN: { type: 'float', min: 0, default: 5, hotReload: true },
  BULL_FLAG_POLE_MAX_CANDLES: { type: 'int', min: 1, default: 4, hotReload: true },
  BULL_FLAG_FLAG_MIN_CANDLES: { type: 'int', min: 1, default: 2, hotReload: true },
  BULL_FLAG_FLAG_MAX_CANDLES: { type: 'int', min: 1, default: 8, hotReload: true },
  BULL_FLAG_FLAG_DEPTH_MAX_PCT: { type: 'float', min: 0, max: 100, default: 50, hotReload: true },
  BULL_FLAG_FLAG_VOL_CONTRACT_MAX_RATIO: { type: 'float', min: 0, default: 0.7, hotReload: true },
  BULL_FLAG_BREAKOUT_VOL_MIN_RATIO: { type: 'float', min: 0, default: 1.5, hotReload: true },
  BULL_FLAG_MIN_24H_VOLUME_USD: { type: 'float', min: 0, default: 5000000, hotReload: true },
  BULL_FLAG_MIN_LIQUIDITY_USD: { type: 'float', min: 0, default: 500000, hotReload: true },
  BULL_FLAG_MIN_NET_EDGE_PCT: { type: 'float', min: 0, default: 2.5, hotReload: true },
  BULL_FLAG_RISK_PCT_BASE: { type: 'float', min: 0, max: 100, default: 0.35, hotReload: true },
  BULL_FLAG_RISK_PCT_APLUS: { type: 'float', min: 0, max: 100, default: 0.5, hotReload: true },
  BULL_FLAG_APLUS_VOL_EXPANSION_MIN: { type: 'float', min: 0, default: 3, hotReload: true },
  BULL_FLAG_APLUS_FLAG_DEPTH_MAX_PCT: { type: 'float', min: 0, max: 100, default: 30, hotReload: true },
  BULL_FLAG_MAX_STOP_DISTANCE_PCT: { type: 'float', min: 0, default: 3.5, hotReload: true },
  BULL_FLAG_MAX_DAILY_LOSS_PCT: { type: 'float', min: 0, max: 100, default: 1.5, hotReload: true },
  BULL_FLAG_MANUAL_CUT_CANDLES: { type: 'int', min: 1, default: 3, hotReload: true },
  BULL_FLAG_MANUAL_CUT_TIMEFRAME_MIN: { type: 'int', min: 1, default: 5, hotReload: true },
  BULL_FLAG_BSC_MIN_24H_VOLUME_USD: { type: 'float', min: 0, default: 10000000, hotReload: true },
  BULL_FLAG_BSC_MIN_TOKEN_AGE_DAYS: { type: 'int', min: 0, default: 30, hotReload: true },
  BULL_FLAG_BASE_MIN_24H_VOLUME_USD: { type: 'float', min: 0, default: 10000000, hotReload: true },

  // ── Learning ───────────────────────────────────────────────────────
  LEARNING_ENABLED: { type: 'bool', default: true, hotReload: true },

  // ── SQL ────────────────────────────────────────────────────────────
  SQL_ENABLED: { type: 'bool', default: false },
  SQL_CONNECTION_STRING: { type: 'string', default: '', secret: true },
  SQL_STATE_RESTORE_ENABLED: { type: 'bool', default: true },
  SQL_TELEMETRY_FLUSH_MS: { type: 'int', min: 100, default: 3000 },
  SQL_AUTO_PRUNE_ENABLED: { type: 'bool', default: false },
  SQL_AUTO_PRUNE_INTERVAL_MS: { type: 'int', min: 60000, default: 3600000 },
  SQL_STATE_HISTORY_PER_KEY_LIMIT: { type: 'int', min: 1, default: 30 },
  SQL_STATE_HISTORY_KEY_LIMIT: { type: 'int', min: 1, default: 120 },
  SQL_MARKET_STATE_TRACKED_TOKEN_LIMIT: { type: 'int', min: 1, default: 100 },
  SQL_STATE_TRADE_LIMIT: { type: 'int', min: 1, default: 80 },
  SQL_STATE_RECENT_TRADE_LIMIT: { type: 'int', min: 1, default: 80 },
  SQL_STATE_PNL_HISTORY_LIMIT: { type: 'int', min: 1, default: 200 },
  SQL_STATE_EXECUTION_JOURNAL_LIMIT: { type: 'int', min: 1, default: 80 },

  // ── DB hot-reload ─────────────────────────────────────────────────
  DB_HOT_RELOAD_POLL_MS: { type: 'int', min: 5000, default: 60000 },
  DB_HOT_RELOAD_FALLBACK_MS: { type: 'int', min: 60000, default: 300000 },

  // ── Python sidecar ────────────────────────────────────────────────
  PYTHON_SIDECAR_MAX_CONCURRENT: { type: 'int', min: 1, default: 1 },
  PYTHON_SIDECAR_MAX_QUEUE: { type: 'int', min: 0, default: 10 },

  // ── AI fallback controls ──────────────────────────────────────────
  ALLOW_TECHNICAL_FALLBACK_ON_AI_FAILURE: { type: 'bool', default: true, hotReload: true },
  AI_UNAVAILABLE_MIN_CONFIRMATIONS: { type: 'int', min: 1, default: 3, hotReload: true },
  KUCOIN_PENDING_AI_ADVISORY: { type: 'bool', default: false, hotReload: true },
  KUCOIN_PENDING_AI_MIN_CONFIRMATIONS: { type: 'int', min: 1, default: 2, hotReload: true },

  // ── Provider keys (cataloged, opaque) ─────────────────────────────
  SOLANA_PRIVATE_KEY: { type: 'string', default: '', secret: true },
  SOLANA_RPC_URL: { type: 'string', default: 'https://api.mainnet-beta.solana.com' },
  HELIUS_API_KEY: { type: 'string', default: '', secret: true },
  BSC_PRIVATE_KEY: { type: 'string', default: '', secret: true },
  BSC_RPC_URL: { type: 'string', default: 'https://bsc-dataseed.binance.org' },
  BASE_PRIVATE_KEY: { type: 'string', default: '', secret: true },
  BASE_RPC_URL: { type: 'string', default: 'https://mainnet.base.org' },
  ALCHEMY_API_KEY: { type: 'string', default: '', secret: true },
  BIRDEYE_API_KEY: { type: 'string', default: '', secret: true },
  GOPLUS_API_KEY: { type: 'string', default: '', secret: true },
  GROQ_API_KEY: { type: 'string', default: '', secret: true },
  GEMINI_API_KEY: { type: 'string', default: '', secret: true },
  ANTHROPIC_API_KEY: { type: 'string', default: '', secret: true },
  OPENAI_API_KEY: { type: 'string', default: '', secret: true },
  COINMARKETCAP_API_KEY: { type: 'string', default: '', secret: true },
  KUCOIN_API_KEY: { type: 'string', default: '', secret: true },
  KUCOIN_API_SECRET: { type: 'string', default: '', secret: true },
  KUCOIN_PASSPHRASE: { type: 'string', default: '', secret: true },
  TELEGRAM_TOKEN: { type: 'string', default: '', secret: true },
  TELEGRAM_CHAT_ID: { type: 'string', default: '' },
};

const CASTERS = {
  int: (v) => { const n = parseInt(v, 10); if (!Number.isFinite(n)) throw new Error(`not int: ${v}`); return n; },
  float: (v) => { const n = parseFloat(v); if (!Number.isFinite(n)) throw new Error(`not float: ${v}`); return n; },
  bool: (v) => /^(true|1|yes|on)$/i.test(String(v).trim()),
  string: (v) => String(v),
  enum: (v, spec) => {
    const s = String(v);
    if (!spec.enum.includes(s)) throw new Error(`not in enum ${spec.enum.join('|')}: ${v}`);
    return s;
  },
  json: (v) => { try { return JSON.parse(v); } catch (e) { throw new Error(`not json: ${e.message}`); } },
};

function castValue(name, raw) {
  const spec = KNOBS[name];
  if (!spec) return raw;
  if (raw === undefined || raw === '') return spec.default;
  const caster = CASTERS[spec.type];
  if (!caster) return raw;
  const val = caster(raw, spec);
  if (spec.min != null && val < spec.min) throw new Error(`${name}=${val} below min ${spec.min}`);
  if (spec.max != null && val > spec.max) throw new Error(`${name}=${val} above max ${spec.max}`);
  return val;
}

// Boot-time validator. Returns { errors, warnings, unknown }.
// Caller decides: WARN_ONLY logs; STRICT throws on first error.
function validate(env = process.env, { strictUnknown = false, ignorePrefixes = [] } = {}) {
  const errors = [];
  const warnings = [];
  const unknown = [];

  // Default ignore prefixes — Node, npm, system, common third-party.
  // 2026-05-23: expanded with full Windows env enumeration + known bot config
  // prefixes documented in config/index.js but not individually typed.
  const defaultIgnore = [
    // Node / npm / shell
    'npm_', 'NODE_', 'PATH', 'HOME', 'USER', 'PWD', 'TEMP', 'TMP',
    'COMPUTERNAME', 'USERPROFILE', 'USERNAME', 'USERDOMAIN', 'PROCESSOR_',
    'NUMBER_OF_PROCESSORS', 'OS', 'COMSPEC', 'LANG', 'LC_', 'TZ',
    'PSModulePath', 'OneDrive', 'GIT_', 'SSH_', 'TERM', 'WINDIR',
    'CLAUDE_', 'VSCODE_', 'ELECTRON_', 'CHROME_',
    // Windows-specific (case-sensitive match required)
    'SystemRoot', 'SystemDrive', 'ProgramFiles', 'ProgramData', 'ProgramW6432',
    'APPDATA', 'LOCALAPPDATA', 'ALLUSERSPROFILE', 'PUBLIC',
    'CommonProgramFiles', 'CommonProgramW6432',
    'ComSpec', 'DriverData', 'EFC_', 'EXIT_CODE', 'LOGONSERVER', 'PROMPT',
    'PSExecutionPolicyPreference', 'POWERSHELL_TELEMETRY_OPTOUT',
    'SESSIONNAME', 'windir',
    'ChocolateyInstall', 'ChocolateyLastPathUpdate',
    'MSYSTEM', 'EXEPATH', 'PLINK_PROTOCOL', 'SHELL', 'SHLVL', 'OLDPWD', '_',
    'VIRTUAL_ENV', '__COMPAT_LAYER', 'NoDefaultCurrentDirectoryInExePath',
    'COREPACK_ENABLE_AUTO_PIN', 'CLIENTNAME',
    'COPILOT_', 'APPLICATION_INSIGHTS_', 'CLAUDECODE', 'MCP_',
    'PROGRAMFILES', 'SYSTEMDRIVE', 'SYSTEMROOT', 'COMMONPROGRAMFILES',
    // Bot config prefixes — parsed in config/index.js with their own defaults.
    'AI_', 'ANTHROPIC_', 'GEMINI_', 'GROQ_', 'OLLAMA_', 'POLYGON_',
    'COINMARKETCAP_', 'COINPAPRIKA_', 'DEXSCREENER_', 'BIRDEYE_',
    'BSC_', 'KUCOIN_', 'SOLANA_', 'BASE_',
    'MOMENTUM_', 'STRATEGY_', 'BULL_FLAG_', 'BACKES_',
    'JITO_', 'MERKLE_', 'MEV_',
    'BREAKOUT_', 'BRAIN_', 'BACKTEST_',
    'DAILY_', 'HOURLY_', 'HIGH_VOL_', 'LOW_VOL_', 'HYBRID_',
    'EXECUTION_', 'EXCHANGE_',
    'RECONCILE_', 'RECONCILIATION_', 'RECOVERY_',
    'SCAN_', 'SLIPPAGE_', 'STOP_', 'TAKE_', 'TRAILING_', 'TRADING_', 'TRADINGVIEW_',
    'SQL_', 'NATIVE_', 'NEWS_', 'MARKET_',
    'LIQUIDITY_', 'LIVE_', 'LOG_',
    'TOKEN_', 'USE_',
    'RL_', 'MAX_', 'MIN_', 'ESTIMATED_', 'REQUIRE_',
    'DASHBOARD_', 'FAST_', 'YOUNG_',
  ];
  const ignoreAll = [...defaultIgnore, ...ignorePrefixes];

  for (const [name, raw] of Object.entries(env)) {
    if (ignoreAll.some((p) => name.startsWith(p))) continue;
    const spec = KNOBS[name];
    if (!spec) {
      unknown.push(name);
      continue;
    }
    try {
      castValue(name, raw);
    } catch (err) {
      errors.push(`${name}: ${err.message}`);
    }
  }

  if (unknown.length && strictUnknown) {
    errors.push(`Unknown env vars: ${unknown.join(', ')}`);
  } else if (unknown.length) {
    try {
      const fs = require('fs');
      const path = require('path');
      const dataDir = process.env.BOT_DATA_DIR || 'data';
      const reportPath = path.resolve(process.cwd(), dataDir, 'config-unknown-env-vars.txt');
      try { fs.mkdirSync(path.dirname(reportPath), { recursive: true }); } catch (_) { /* best-effort */ }
      const header = [
        `# Unknown env vars (not in src/config/schema.js KNOBS)`,
        `# Generated: ${new Date().toISOString()} — overwritten each boot`,
        `# Action: either add a KNOBS entry or remove from .env / ecosystem.config.js`,
        `# Count: ${unknown.length}`,
        '',
      ].join('\n');
      fs.writeFileSync(reportPath, header + unknown.sort().join('\n') + '\n', 'utf8');
    } catch (_) { /* best-effort */ }
    warnings.push(`${unknown.length} env vars not in schema — see data/config-unknown-env-vars.txt (set CONFIG_STRICT_UNKNOWN=true to enforce)`);
  }

  return { errors, warnings, unknown };
}

function listKnobs() {
  return Object.entries(KNOBS).map(([name, spec]) => ({ name, ...spec }));
}

function getKnobSpec(name) {
  return KNOBS[name] || null;
}

module.exports = { KNOBS, castValue, validate, listKnobs, getKnobSpec };
