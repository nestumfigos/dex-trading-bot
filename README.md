# DEX Momentum Trading Bot

Momentum trading bot for **Jupiter (Solana)**, **PancakeSwap (BSC)**, and **BaseSwap (Base)**.  
Runs 24/7 on your own computer. Paper trading mode included — test safely before going live.

---

## Quick start

```bash
git clone <this-repo>
cd dex-trading-bot
npm install
cp .env.example .env
# Fill in your .env keys (see API Keys section below)
npm run paper        # safe paper trading mode
npm start            # live trading (real money)
```

Dashboard opens at **http://localhost:3002**

Health endpoint: **http://localhost:3002/health**

---

## API Keys — Where to get them

### 1. Solana / Jupiter

| Key | Where to get | Cost |
|-----|-------------|------|
| `SOLANA_PRIVATE_KEY` | Phantom wallet → Settings → Export Private Key | Free |
| `SOLANA_RPC_URL` | https://helius.dev → Create free project → copy RPC URL | Free tier: 100k req/day |
| `HELIUS_API_KEY` | Same Helius dashboard → API Key tab | Free tier available |
| `BIRDEYE_API_KEY` | https://birdeye.so/api → Sign up → Dashboard | Free tier: 100 req/min |
| `COINMARKETCAP_API_KEY` | https://coinmarketcap.com/api/ → Free developer key | Free tier available |

Jupiter swap API itself is **completely free** — no key needed.  
Explorer: https://solscan.io (to verify your transactions)

---

### 2. BSC / PancakeSwap

| Key | Where to get | Cost |
|-----|-------------|------|
| `BSC_PRIVATE_KEY` | MetaMask → Account Details → Export Private Key | Free |
| `BSC_RPC_URL` | https://nodereal.io → BNB Smart Chain → Free plan | Free: 300 req/day; Paid from $9/mo |

DexScreener API (used for BSC token data and native-price fallback) is **completely free** — no key needed.  
Honeypot.is API (used for rug checks) is **completely free** — no key needed.  
Explorer: https://bscscan.com

**Alternative free BSC RPC endpoints:**
```
https://bsc-dataseed.binance.org
https://bsc-dataseed1.defibit.io
https://bsc-dataseed1.ninicoin.io
```

---

### 3. Base / BaseSwap

| Key | Where to get | Cost |
|-----|-------------|------|
| `BASE_PRIVATE_KEY` | MetaMask → Account Details → Export Private Key (same as BSC if same wallet) | Free |
| `BASE_RPC_URL` | https://alchemy.com → Create App → Network: Base Mainnet | Free: 300M compute units/mo |
| `ALCHEMY_API_KEY` | Same Alchemy dashboard → API Key | Free tier generous |

BaseSwap router contract is on-chain — no API key needed for swaps.  
Explorer: https://basescan.org

**Alternative free Base RPC:**
```
https://mainnet.base.org   (Coinbase public — rate limited)
```

---

## Wallet setup

You need funded wallets on each chain:

- **Solana wallet**: Load with SOL (for gas) + USDC (for buying tokens)
  - Minimum recommended: 0.1 SOL for gas + your trading capital in USDC
  - Get USDC on Solana via: https://jup.ag

- **BSC wallet**: Load with BNB (gas + trading capital)
  - Minimum recommended: 0.05 BNB for gas + trading capital in BNB
  - Get BNB via Binance or Coinbase → withdraw to your BSC address

- **Base wallet**: Load with ETH on Base (gas + trading capital)
  - Minimum recommended: 0.005 ETH for gas + trading capital in ETH
  - Bridge ETH to Base via: https://bridge.base.org

---

## Running 24/7 on your computer

Use **PM2** to keep the bot running even if your terminal closes:

```bash
npm install -g pm2
pm2 start src/index.js --name "dex-bot"
pm2 save
pm2 startup   # auto-start on system reboot
```

Useful PM2 commands:
```bash
pm2 logs dex-bot        # watch live logs
pm2 status              # check if running
pm2 restart dex-bot     # restart after config changes
pm2 stop dex-bot        # stop the bot
```

Run with Docker (includes restart policy):

```bash
docker compose up -d --build
docker compose ps
docker compose logs -f dex-bot
```

---

## Strategy parameters (edit config/index.js)

| Parameter | Default | What it does |
|-----------|---------|-------------|
| EMA fast | 9 | Short EMA period — faster signal |
| EMA slow | 21 | Slow EMA — crossover triggers entry |
| RSI period | 14 | RSI lookback |
| RSI buy threshold | 45 | Only buy when RSI < this (not overbought) |
| Volume spike | 2.5x | Require volume 2.5x the average |

The bot now adjusts the volume spike multiplier dynamically by market regime (normal vs high volatility).

---

## Risk guardrails (always enforced)

- Min liquidity: **$75,000** — no trades on illiquid tokens
- Max position size: **3% of portfolio** (never exceeds 5%)
- Stop-loss: **-8%** automatic exit
- Take-profit: **+25%** automatic exit
- Max concurrent positions: **5**
- Daily drawdown limit: **-15%** — bot halts for the day
- Honeypot detected: **trade blocked**
- Top-10 holders > 80%: **trade blocked**
- Team wallet unlocked: **position size halved**
- Token launched < 6h: **higher-risk sizing and stricter liquidity checks**
- Trailing stop after 2x: **dynamic stop locks gains on reversals**

---

## Reliability hardening

- Exchange adapters now include retry logic, slippage controls, and gas estimation where applicable.
- Anthropic and exchange circuits degrade gracefully during outages (cooldown mode) instead of crashing the process.
- Startup config validation checks required env vars and logs actionable warnings.
- Native SOL, BNB, and ETH prices now use an ordered provider chain: CoinGecko first, DexScreener fallback, and optional CoinMarketCap free-tier backup.
- Token legitimacy checks now prefer CoinGecko contract-address lookups on supported chains, with optional CoinMarketCap symbol fallback.
- Polling remains the default mode; for production scale, prefer Helius or QuickNode webhooks to reduce latency and RPC load.

---

## Security warnings

- **NEVER** commit your `.env` file to GitHub
- **NEVER** share your private keys with anyone
- Use a dedicated trading wallet — not your main wallet
- Start with paper trading (`npm run paper`) for at least 1 week
- Start small on live trading — the bot can lose money

---

## Project structure

```
dex-trading-bot/
├── src/
│   ├── index.js              # Main bot loop
│   ├── dashboard.js          # HTTP + WebSocket dashboard
│   ├── exchanges/
│   │   ├── jupiter.js        # Solana / Jupiter
│   │   ├── pancakeswap.js    # BSC / PancakeSwap
│   │   └── baseswap.js       # Base / BaseSwap
│   ├── strategy/
│   │   └── momentum.js       # EMA + RSI strategy
│   ├── risk/
│   │   └── guardian.js       # All risk checks
│   └── utils/
│       ├── indicators.js     # EMA, RSI, volume calc
│       └── logger.js         # Winston logger
├── config/
│   └── index.js              # Central config
├── logs/                     # Auto-created log files
├── .env.example              # Copy to .env and fill in
└── package.json
```
