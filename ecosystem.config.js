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
      },
      env_production: {
        NODE_ENV: 'production',
      },
    },
  ],
};
