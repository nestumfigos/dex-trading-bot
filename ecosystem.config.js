const path = require('path');

const PAPER_WORKTREE_PATH = process.env.PAPER_WORKTREE_PATH || path.resolve(__dirname, '..', 'dex-trading-bot-paper');
const PERPS_REPO_PATH    = process.env.PERPS_REPO_PATH    || path.resolve(__dirname, '..', 'dex-trading-bot-perps');

module.exports = {
  apps: [
    {
      name: 'dex-bot',
      script: 'src/index.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      kill_timeout: 10000,
      listen_timeout: 15000,
      max_restarts: 10,
      min_uptime: '10s',
      watch: false,
      max_memory_restart: '500M',
      env: {
        NODE_ENV: 'production',
        BOT_PROFILE: 'live',
        PORT: '3002',
        DASHBOARD_BIND_HOST: '0.0.0.0',
        // Python sidecar/external models enabled. PM2's WMIC monitor path was
        // the confirmed cmd-window storm source and is patched locally.
        PYTHON_SIDECAR_ENABLED: 'true',
        EXTERNAL_MODELS_ENABLED: 'true',
        PYTHON_SIDECAR_TIMEOUT_MS: '4000',
        LIVE_BSC_ENTRIES_ENABLED: 'true',
        BSC_MOMENTUM_HEAT_ALLOWANCE_PCT: '60',
        BSC_MAX_CONSECUTIVE_LOSSES: '8',
        LEARNING_ENABLED: 'false',
        SELF_EVOLUTION_ENABLED: 'false',
        SELF_EVOLUTION_ALLOW_LIVE_MUTATION: 'false',
        SELF_EVOLUTION_AUTO_APPLY: 'false',
        SELF_EVOLUTION_ALLOW_LIVE_APPLY: 'false',
        SELF_EVOLUTION_AUTO_PROMOTE: 'false',
        SELF_EVOLUTION_UNSAFE_EXPERIMENTAL: 'false',
        SQL_TELEMETRY_FLUSH_MS: '3000',
        MIN_LIQUIDITY_USD: '5000',
        PRE_TRADE_CONTRACT_MODE: 'enforce',
        BOT_MIN_SCHEMA_VERSION: '17',
        SQL_AUTO_PRUNE_ENABLED: 'true',
        SQL_AUTO_PRUNE_INTERVAL_MS: '3600000',
        PRE_TRADE_CONTRACT_MODE: 'enforce',
        BOT_MIN_SCHEMA_VERSION: '17',
      },
      env_production: {
        NODE_ENV: 'production',
        BOT_PROFILE: 'live',
        PORT: '3002',
        DASHBOARD_BIND_HOST: '0.0.0.0',
        // Python sidecar/external models enabled. PM2's WMIC monitor path was
        // the confirmed cmd-window storm source and is patched locally.
        PYTHON_SIDECAR_ENABLED: 'true',
        EXTERNAL_MODELS_ENABLED: 'true',
        PYTHON_SIDECAR_TIMEOUT_MS: '4000',
        LIVE_BSC_ENTRIES_ENABLED: 'true',
        BSC_MOMENTUM_HEAT_ALLOWANCE_PCT: '60',
        BSC_MAX_CONSECUTIVE_LOSSES: '8',
        LEARNING_ENABLED: 'false',
        SELF_EVOLUTION_ENABLED: 'false',
        SELF_EVOLUTION_ALLOW_LIVE_MUTATION: 'false',
        SELF_EVOLUTION_AUTO_APPLY: 'false',
        SELF_EVOLUTION_ALLOW_LIVE_APPLY: 'false',
        SELF_EVOLUTION_AUTO_PROMOTE: 'false',
        SELF_EVOLUTION_UNSAFE_EXPERIMENTAL: 'false',
        SQL_TELEMETRY_FLUSH_MS: '3000',
        MIN_LIQUIDITY_USD: '5000',
        PRE_TRADE_CONTRACT_MODE: 'enforce',
        BOT_MIN_SCHEMA_VERSION: '17',
        SQL_AUTO_PRUNE_ENABLED: 'true',
        SQL_AUTO_PRUNE_INTERVAL_MS: '3600000',
        PRE_TRADE_CONTRACT_MODE: 'enforce',
        BOT_MIN_SCHEMA_VERSION: '17',
      },
    },
    {
      name: 'dex-bot-paper',
      cwd: PAPER_WORKTREE_PATH,
      script: 'src/index.js',
      // 2026-05-31: cron_restart REMOVED. Original (2026-05-30) reason was OOM
      // mitigation for paper's heavy ML superset (rl-online-updater,
      // bayesian-network, python-sidecar, hybrid-orchestrator) hitting node's
      // ~2GB heap ceiling. Two problems with the cron approach on Windows pm2:
      //   1. Each cron-restart triggered a lock-contention respawn loop with
      //      the singleton's pm2-quirk delayed-exit: new spawn detects lock,
      //      sleeps 15s, exits; pm2 autorestarts; loop continues until the
      //      old paper actually releases the lock — bot looked stable but
      //      restart counter climbed by ~4/min and cmd.exe windows flashed
      //      constantly, disrupting the operator's machine.
      //   2. pm2-Windows fork mode opens a visible console wrapper for each
      //      cron-spawned child. Removing cron removes the flashing.
      // Memory mitigation now relies on:
      //   - 4GB V8 heap (--max-old-space-size=4096) — machine has 30GB.
      //   - Operator memory monitoring (Task Manager / Get-Process). If RSS
      //     climbs past ~3GB, manually `pm2 restart dex-bot-paper` once.
      //   - Future: heap-profile the ML superset to find the actual leak.
      // If automatic recycling becomes necessary again, prefer a long
      // interval (e.g. '0 */4 * * *' = every 4h) AND bump kill_timeout to
      // 30s so the old process drains fully before the new spawn lands.
      node_args: '--max-old-space-size=4096',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      kill_timeout: 30000,
      listen_timeout: 60000,
      max_restarts: 10,
      min_uptime: '10s',
      watch: false,
      max_memory_restart: '3500M',
      env: {
        NODE_ENV: 'production',
        PAPER_TRADING: 'true',
        PORT: '3003',
        DASHBOARD_BIND_HOST: '0.0.0.0',
        BOT_PROFILE: 'paper',
        BOT_DATA_DIR: 'data',
        // Python sidecar/external models enabled. Keep paper sidecar bounded
        // because it can evaluate many tokens per cycle.
        PYTHON_SIDECAR_ENABLED: 'true',
        EXTERNAL_MODELS_ENABLED: 'true',
        PYTHON_SIDECAR_TIMEOUT_MS: '4000',
        PYTHON_SIDECAR_MAX_CONCURRENT: '1',
        PYTHON_SIDECAR_MAX_QUEUE: '10',
        SELF_EVOLUTION_AUTO_APPLY: 'false',
        SELF_EVOLUTION_ALLOW_LIVE_APPLY: 'false',
        SELF_EVOLUTION_AUTO_PROMOTE: 'false',
        SELF_EVOLUTION_UNSAFE_EXPERIMENTAL: 'false',
        SQL_AUTO_PRUNE_ENABLED: 'true',
        SQL_AUTO_PRUNE_INTERVAL_MS: '3600000',
        PRE_TRADE_CONTRACT_MODE: 'enforce',
        BOT_MIN_SCHEMA_VERSION: '17',
      },
      env_production: {
        NODE_ENV: 'production',
        PAPER_TRADING: 'true',
        PORT: '3003',
        DASHBOARD_BIND_HOST: '0.0.0.0',
        BOT_PROFILE: 'paper',
        BOT_DATA_DIR: 'data',
        // Python sidecar/external models enabled. Keep paper sidecar bounded
        // because it can evaluate many tokens per cycle.
        PYTHON_SIDECAR_ENABLED: 'true',
        EXTERNAL_MODELS_ENABLED: 'true',
        PYTHON_SIDECAR_TIMEOUT_MS: '4000',
        PYTHON_SIDECAR_MAX_CONCURRENT: '1',
        PYTHON_SIDECAR_MAX_QUEUE: '10',
        SELF_EVOLUTION_AUTO_APPLY: 'false',
        SELF_EVOLUTION_ALLOW_LIVE_APPLY: 'false',
        SELF_EVOLUTION_AUTO_PROMOTE: 'false',
        SELF_EVOLUTION_UNSAFE_EXPERIMENTAL: 'false',
        SQL_AUTO_PRUNE_ENABLED: 'true',
        SQL_AUTO_PRUNE_INTERVAL_MS: '3600000',
        PRE_TRADE_CONTRACT_MODE: 'enforce',
        BOT_MIN_SCHEMA_VERSION: '17',
      },
    },
    {
      // 2026-05-31 (cycle-2 follow-up): add perps paper-research service to pm2
      // for consistency with spot+paper. Bound to port 3004 (next free after
      // 3002 live / 3003 paper). PERPS_PAPER_SERVICE_ENABLED gate at
      // src/index.js:18 throws if not set to 'true' — explicit opt-in.
      // PERPS_ADMIN_TOKEN intentionally NOT baked here: the perps server
      // (src/server.js requirePerpsAdminToken) returns 503 on POST routes
      // until operator sets the env var, so secret never lives in committed
      // ecosystem config. To enable POST writes: set PERPS_ADMIN_TOKEN in the
      // shell env that runs pm2 (or in pm2 module env), then `pm2 restart
      // dex-bot-perps --update-env`. GET routes work without the token.
      // 2GB heap (lighter than paper's 4GB) — perps is narrower-scope.
      // 2026-05-31: cron_restart REMOVED — same pm2-Windows churn rationale
      // as paper above. If memory becomes an issue, prefer long interval +
      // bumped kill_timeout (see paper comment).
      name: 'dex-bot-perps',
      cwd: PERPS_REPO_PATH,
      script: 'src/index.js',
      node_args: '--max-old-space-size=2048',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      kill_timeout: 30000,
      listen_timeout: 60000,
      max_restarts: 10,
      min_uptime: '10s',
      watch: false,
      max_memory_restart: '1500M',
      env: {
        NODE_ENV: 'production',
        PORT: '3004',
        DASHBOARD_BIND_HOST: '127.0.0.1', // perps server is localhost-only by design
        PERPS_PAPER_SERVICE_ENABLED: 'true',
        PERPS_DATA_SOURCE: 'kucoin',
        PERPS_PAPER_OBSERVATION_DAYS: '0',
        PERPS_PAPER_MARKET_DATA_ENABLED: 'true',
        PERPS_PAPER_MARKPRICE_WS_ENABLED: 'true',
        // 2026-05-31 (operator request): execute paper trades on raw signals
        // without waiting for per-symbol historical backtest evidence to
        // accumulate. Admission gate stays enforced when promoting to live —
        // this opt-out is paper-only by virtue of liveExecutionEnabled=false
        // being hardcoded in paper-perps-adapter / server. Set to 'true' to
        // re-enable admission.
        PERPS_PAPER_STRATEGY_ADMISSION_REQUIRED: 'false',
        // PERPS_PAPER_SYMBOLS intentionally OMITTED: when unset, src/index.js
        // falls through to load all canonical symbols from
        // config/kucoin-perps-universe.json (~602 KuCoin perps). To restrict
        // back to a small list, set PERPS_PAPER_SYMBOLS='BTCUSDT,ETHUSDT,...'.
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: '3004',
        DASHBOARD_BIND_HOST: '127.0.0.1',
        PERPS_PAPER_SERVICE_ENABLED: 'true',
        PERPS_DATA_SOURCE: 'kucoin',
        PERPS_PAPER_OBSERVATION_DAYS: '0',
        PERPS_PAPER_MARKET_DATA_ENABLED: 'true',
        PERPS_PAPER_MARKPRICE_WS_ENABLED: 'true',
        PERPS_PAPER_STRATEGY_ADMISSION_REQUIRED: 'false',
        // PERPS_PAPER_SYMBOLS omitted — falls through to full universe.
      },
    },
  ],
};
