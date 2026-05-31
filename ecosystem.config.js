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
        LIVE_BSC_ENTRIES_ENABLED: 'true',
        BSC_MOMENTUM_HEAT_ALLOWANCE_PCT: '60',
        BSC_MAX_CONSECUTIVE_LOSSES: '8',
        LEARNING_ENABLED: 'false',
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
        LIVE_BSC_ENTRIES_ENABLED: 'true',
        BSC_MOMENTUM_HEAT_ALLOWANCE_PCT: '60',
        BSC_MAX_CONSECUTIVE_LOSSES: '8',
        LEARNING_ENABLED: 'false',
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
      // STOPGAP (2026-05-30, not a leak fix): paper runs the heavy experimental
      // ML superset (rl-online-updater, bayesian-network, python-sidecar,
      // hybrid-orchestrator) and leaks memory, hard-OOM-crashing ~every 30-45min
      // at node's ~2GB heap ceiling (pm2 max_memory_restart can't see memory on
      // Windows, so it never fires). Give V8 4GB headroom (machine has 30GB) and
      // recycle cleanly every 30min so it recycles BEFORE OOM instead of crashing.
      // Real fix = heap-profile the superset to find the leak.
      node_args: '--max-old-space-size=4096',
      cron_restart: '0,30 * * * *',
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
        PAPER_TRADING: 'true',
        PORT: '3003',
        DASHBOARD_BIND_HOST: '0.0.0.0',
        BOT_PROFILE: 'paper',
        BOT_DATA_DIR: 'data',
        SELF_EVOLUTION_ALLOW_LIVE_APPLY: 'true',
        SELF_EVOLUTION_UNSAFE_EXPERIMENTAL: 'true',
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
        SELF_EVOLUTION_ALLOW_LIVE_APPLY: 'true',
        SELF_EVOLUTION_UNSAFE_EXPERIMENTAL: 'true',
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
      // cron_restart offset to :15/:45 to avoid overlap with paper's :00/:30.
      // 2GB heap (lighter than paper's 4GB) — perps is narrower-scope.
      name: 'dex-bot-perps',
      cwd: PERPS_REPO_PATH,
      script: 'src/index.js',
      node_args: '--max-old-space-size=2048',
      cron_restart: '15,45 * * * *',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      kill_timeout: 10000,
      listen_timeout: 15000,
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
        PERPS_PAPER_STRATEGY_ADMISSION_REQUIRED: 'true',
        PERPS_PAPER_SYMBOLS: 'BTCUSDT,ETHUSDT,SOLUSDT',
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
        PERPS_PAPER_STRATEGY_ADMISSION_REQUIRED: 'true',
        PERPS_PAPER_SYMBOLS: 'BTCUSDT,ETHUSDT,SOLUSDT',
      },
    },
  ],
};
