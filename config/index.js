require('dotenv').config();

const isPaperTrading = process.env.PAPER_TRADING === 'true';
const defaultScanIntervalSeconds = isPaperTrading ? 120 : 75;

const config = {
  paperTrading: isPaperTrading,
  paperBalance: parseFloat(process.env.PAPER_BALANCE_USD) || 10000,

  solana: {
    privateKey: process.env.SOLANA_PRIVATE_KEY,
    rpcUrl: process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
    heliusApiKey: process.env.HELIUS_API_KEY,
    priceCacheTtlMs: parseInt(process.env.SOL_PRICE_CACHE_TTL_MS || '30000', 10),
    fallbackPriceUsd: parseFloat(process.env.FALLBACK_SOL_PRICE_USD || '200'),
  },

  bsc: {
    privateKey: process.env.BSC_PRIVATE_KEY,
    rpcUrl: process.env.BSC_RPC_URL || 'https://bsc-dataseed.binance.org',
    wsUrl: process.env.BSC_WS_URL || '',
    chainId: 56,
    pancakeRouterV2: '0x10ED43C718714eb63d5aA57B78B54704E256024E',
    pancakeFactoryV2: '0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73',
    wbnb: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
    busd: '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56',
  },

  base: {
    privateKey: process.env.BASE_PRIVATE_KEY,
    rpcUrl: process.env.BASE_RPC_URL || 'https://mainnet.base.org',
    wsUrl: process.env.BASE_WS_URL || '',
    alchemyKey: process.env.ALCHEMY_API_KEY,
    chainId: 8453,
    baseswapRouter: process.env.BASESWAP_ROUTER || '0x327Df1E6de05895d2ab08513aaDD9313Fe505d86',
    baseswapFactory: process.env.BASESWAP_FACTORY || '',
    weth: process.env.BASE_WETH || '0x4200000000000000000000000000000000000006',
    priceCacheTtlMs: parseInt(process.env.ETH_PRICE_CACHE_TTL_MS || '30000', 10),
    fallbackPriceUsd: parseFloat(process.env.FALLBACK_ETH_PRICE_USD || '3000'),
  },

  kucoin: {
    apiKey: process.env.KUCOIN_API_KEY,
    apiSecret: process.env.KUCOIN_API_SECRET,
    apiPassphrase: process.env.KUCOIN_API_PASSPHRASE,
    sandbox: process.env.KUCOIN_SANDBOX === 'true',
  },

  birdeye: {
    apiKey: process.env.BIRDEYE_API_KEY,
    baseUrl: 'https://public-api.birdeye.so',
    rpmLimit: parseInt(process.env.BIRDEYE_RPM_LIMIT || '30', 10),
    cacheTtlMs: parseInt(process.env.BIRDEYE_CACHE_TTL_MS || '60000', 10),
    dexscreenerCacheTtlMs: parseInt(process.env.DEXSCREENER_CACHE_TTL_MS || '90000', 10),
    // Bug 7: age-adaptive token-data cache TTLs.
    // Tokens < 6h old use a short TTL (15s default) so stale data never lingers longer than one poll.
    // Tokens 6–24h old use a medium TTL (30s default).
    // Tokens > 24h old fall back to cacheTtlMs above.
    momentumTokenCacheTtlMs: parseInt(process.env.MOMENTUM_TOKEN_CACHE_TTL_MS || '15000', 10),
    newTokenCacheTtlMs: parseInt(process.env.NEW_TOKEN_CACHE_TTL_MS || '30000', 10),
  },

  coinmarketcap: {
    enabled: process.env.COINMARKETCAP_ENABLED !== 'false',
    apiKey: process.env.COINMARKETCAP_API_KEY || '',
    baseUrl: process.env.COINMARKETCAP_BASE_URL || 'https://pro-api.coinmarketcap.com',
  },

  marketData: {
    nativePriceProviders: String(process.env.NATIVE_PRICE_PROVIDER_ORDER || 'coingecko,dexscreener,coinmarketcap')
      .split(',')
      .map((provider) => provider.trim().toLowerCase())
      .filter(Boolean),
  },

  goplus: {
    apiKey: process.env.GOPLUS_API_KEY,
  },

  groq: {
    apiKey: process.env.GROQ_API_KEY,
    model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
  },

  gemini: {
    apiKey: process.env.GEMINI_API_KEY,
    model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
  },

  ai: {
    narrativeMinScore: parseFloat(process.env.AI_NARRATIVE_MIN_SCORE) || 65,
  },

  telegram: {
    token: process.env.TELEGRAM_TOKEN,
    chatId: process.env.TELEGRAM_CHAT_ID,
  },

  risk: {
    maxPositionSizePct: parseFloat(process.env.MAX_POSITION_SIZE_PCT) || 3,
    stopLossPct: parseFloat(process.env.STOP_LOSS_PCT) || 8,
    takeProfitPct: parseFloat(process.env.TAKE_PROFIT_PCT) || 25,
    minLiquidityUsd: parseFloat(process.env.MIN_LIQUIDITY_USD) || 10000,
    maxConcurrentPositions: parseInt(process.env.MAX_CONCURRENT_POSITIONS) || 5,
    dailyDrawdownLimitPct: parseFloat(process.env.DAILY_DRAWDOWN_LIMIT_PCT) || 15,
    maxTokenAgeHours: parseFloat(process.env.MAX_TOKEN_AGE_HOURS) || 6,
    trailingStopAfterMultiplier: parseFloat(process.env.TRAILING_STOP_AFTER_MULTIPLIER) || 2,
    trailingStopPct: parseFloat(process.env.TRAILING_STOP_PCT) || 15,
    maxCorrelationPct: parseFloat(process.env.MAX_CORRELATION_PCT) || 75,
    aiConfidenceFloor: parseFloat(process.env.AI_CONFIDENCE_FLOOR) || 70,
    maxConsecutiveLosses: parseInt(process.env.MAX_CONSECUTIVE_LOSSES || '4', 10),
    minTradesForKpiGate: parseInt(process.env.MIN_TRADES_FOR_KPI_GATE || '40', 10),
    minProfitFactor: parseFloat(process.env.MIN_PROFIT_FACTOR || '1.15'),
    maxDailyLossPct: parseFloat(process.env.MAX_DAILY_LOSS_PCT || '2.5'),
    maxAverageSlippageBps: parseFloat(process.env.MAX_AVG_SLIPPAGE_BPS || '180'),
    maxBalanceDriftPct: parseFloat(process.env.MAX_BALANCE_DRIFT_PCT || '10'),
    maxNativePriceAgeMs: parseInt(process.env.MAX_NATIVE_PRICE_AGE_MS || '120000', 10),
    minBalanceCoverage: parseInt(process.env.MIN_BALANCE_COVERAGE || '2', 10),
    maxSuppressedTokenErrors: parseInt(process.env.MAX_SUPPRESSED_TOKEN_ERRORS || '10', 10),
    maxRoundTripFrictionPct: parseFloat(process.env.MAX_ROUND_TRIP_FRICTION_PCT || '15'),
    maxReserveImbalanceRatio: parseFloat(process.env.MAX_RESERVE_IMBALANCE_RATIO || '1000'),
    maxMarketImpactPct: parseFloat(process.env.MAX_MARKET_IMPACT_PCT || '3'),
    maxTradeShareOfHourlyVolumePct: parseFloat(process.env.MAX_TRADE_SHARE_HOURLY_VOLUME_PCT || '0.5'),
    assumedWinRatePct: parseFloat(process.env.ASSUMED_WIN_RATE_PCT || '42'),
    estimatedDexFeePctPerSide: parseFloat(process.env.ESTIMATED_DEX_FEE_PCT_PER_SIDE || '0.3'),
    estimatedMevTaxPctPerRoundTrip: parseFloat(process.env.ESTIMATED_MEV_TAX_PCT_PER_ROUND_TRIP || '0.7'),
    estimatedNetworkCostPctPerRoundTrip: parseFloat(process.env.ESTIMATED_NETWORK_COST_PCT_PER_ROUND_TRIP || '0.2'),
    minNetExpectedEdgePct: parseFloat(process.env.MIN_NET_EXPECTED_EDGE_PCT || '0.8'),
    maxHoldMinutesGlobal: parseInt(process.env.MAX_HOLD_MINUTES_GLOBAL || '4320', 10),
    maxDailyLossPctByChain: (() => {
      const raw = process.env.MAX_DAILY_LOSS_PCT_BY_CHAIN;
      if (raw) {
        try { return JSON.parse(raw); } catch { /* fall through */ }
      }
      return { solana: 3.5, bsc: 2.5, base: 2.5, kucoin: 3.0 };
    })(),
    oracleStopEnabled: process.env.ORACLE_STOP_ENABLED === 'true',
    chainlinkFeedByToken: (() => {
      const raw = process.env.CHAINLINK_FEED_BY_TOKEN;
      if (raw) {
        try { return JSON.parse(raw); } catch { /* fall through */ }
      }
      return {};
    })(),
    pythFeedByToken: (() => {
      const raw = process.env.PYTH_FEED_BY_TOKEN;
      if (raw) {
        try { return JSON.parse(raw); } catch { /* fall through */ }
      }
      return {};
    })(),
    oraclePriceCacheMs: parseInt(process.env.ORACLE_PRICE_CACHE_MS || '2000', 10),
    realtimeStopLossEnabled: process.env.REALTIME_STOP_LOSS_ENABLED !== 'false',
    realtimeStopCheckSeconds: parseInt(process.env.REALTIME_STOP_CHECK_SECONDS || '8', 10),
    realtimeStopFetchTimeoutMs: parseInt(process.env.REALTIME_STOP_FETCH_TIMEOUT_MS || '6000', 10),
  },

  bot: {
    scanIntervalSeconds: parseInt(process.env.SCAN_INTERVAL_SECONDS) || defaultScanIntervalSeconds,
    momentumScanIntervalSeconds: parseInt(process.env.MOMENTUM_SCAN_INTERVAL_SECONDS || process.env.SCAN_INTERVAL_SECONDS || '75', 10),
    swingScanIntervalMinutes: parseInt(process.env.SWING_SCAN_INTERVAL_MINUTES || '15', 10),
    momentumExitCheckMinutes: parseInt(process.env.MOMENTUM_EXIT_CHECK_MINUTES || '15', 10),
    swingExitCheckMinutes: parseInt(process.env.SWING_EXIT_CHECK_MINUTES || '60', 10),
    swingWatchlistRefreshHours: parseInt(process.env.SWING_WATCHLIST_REFRESH_HOURS || '24', 10),
    walletBalanceRefreshSeconds: parseInt(process.env.WALLET_BALANCE_REFRESH_SECONDS || '60', 10),
    discoveryMode: String(process.env.DISCOVERY_MODE || 'hybrid').toLowerCase(), // watchlist | new | hybrid
    port: parseInt(process.env.PORT) || 3002,
    logLevel: process.env.LOG_LEVEL || 'info',
    aiFailureCooldownSeconds: parseInt(process.env.AI_FAILURE_COOLDOWN_SECONDS) || 180,
    aiFailureThreshold: parseInt(process.env.AI_FAILURE_THRESHOLD) || 5,
    exchangeFailureThreshold: parseInt(process.env.EXCHANGE_FAILURE_THRESHOLD) || 4,
    exchangeFailureCooldownSeconds: parseInt(process.env.EXCHANGE_FAILURE_COOLDOWN_SECONDS) || 120,
    liveAbortDelayMs: parseInt(process.env.LIVE_ABORT_DELAY_MS) || 10000, // Time to abort live trading on startup
  },

  discovery: {
    websocketEnabled: process.env.WS_DISCOVERY_ENABLED !== 'false',
    pollTimeoutMs: parseInt(process.env.DISCOVERY_POLL_TIMEOUT_MS || '4000', 10),
      hybridPollTimeoutMs: parseInt(process.env.HYBRID_POLL_TIMEOUT_MS || '300', 10),
    reconnectBaseDelayMs: parseInt(process.env.WS_DISCOVERY_RECONNECT_BASE_DELAY_MS || '2000', 10),
    reconnectMaxDelayMs: parseInt(process.env.WS_DISCOVERY_RECONNECT_MAX_DELAY_MS || '30000', 10),
    maxTrackedTokensPerChain: parseInt(process.env.WS_DISCOVERY_MAX_TOKENS || '500', 10),
    tokenTtlMinutes: parseInt(process.env.WS_DISCOVERY_TOKEN_TTL_MINUTES || '180', 10),
    eventStaleMinutes: parseInt(process.env.WS_DISCOVERY_EVENT_STALE_MINUTES || '30', 10),
    quietMarketThreshold: process.env.DISCOVERY_QUIET_MARKET_THRESHOLD !== 'false',
    quietHoursStart: parseInt(process.env.DISCOVERY_QUIET_HOURS_START || '0', 10),
    quietHoursEnd: parseInt(process.env.DISCOVERY_QUIET_HOURS_END || '6', 10),
    maxBootstrapRetries: parseInt(process.env.WS_MAX_BOOTSTRAP_RETRIES || '20', 10),
    maxRetryDelayMs: parseInt(process.env.WS_MAX_RETRY_DELAY_MS || '300000', 10),
    solana: {
      enabled: process.env.SOLANA_WS_DISCOVERY_ENABLED !== 'false',
      programIds: String(process.env.SOLANA_DISCOVERY_PROGRAM_IDS || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    },
    bsc: {
      enabled: process.env.BSC_WS_DISCOVERY_ENABLED !== 'false',
    },
    base: {
      enabled: process.env.BASE_WS_DISCOVERY_ENABLED !== 'false',
    },
  },

  dashboard: {
    bindHost: process.env.DASHBOARD_BIND_HOST || '127.0.0.1',
    adminToken: process.env.DASHBOARD_ADMIN_TOKEN || '',
  },

  // Time-of-day trading windows (UTC hours).
  // New entries are only opened during these windows; exit checks always run.
  // Set TRADING_WINDOWS_ENABLED=false to disable entirely (trade 24/7).
  // Override windows via TRADING_WINDOWS='[{"startUtcHour":8,"endUtcHour":12}]' (JSON array).
  tradingWindows: (() => {
    const raw = process.env.TRADING_WINDOWS;
    if (raw) {
      try { return JSON.parse(raw); } catch { /* fall through to default */ }
    }
    return [
      { startUtcHour: 8,  endUtcHour: 12 }, // US pre-market + Asia close overlap
      { startUtcHour: 20, endUtcHour: 24 }, // US evening + Asia open overlap
    ];
  })(),
  tradingWindowsEnabled: process.env.TRADING_WINDOWS_ENABLED !== 'false',

  // Dual Strategy Configuration
  strategies: {
    // Strategy A: Established Token Swing Trading (longer timeframes, larger sizes)
    swing: {
      enabled: process.env.STRATEGY_SWING_ENABLED !== 'false',
      emaFast: parseInt(process.env.STRATEGY_SWING_EMA_FAST || '21', 10),
      emaSlow: parseInt(process.env.STRATEGY_SWING_EMA_SLOW || '55', 10),
      rsiPeriod: parseInt(process.env.STRATEGY_SWING_RSI_PERIOD || '21', 10),
      candleInterval: process.env.STRATEGY_SWING_CANDLE_INTERVAL || '1h',
      candleLookbackBars: parseInt(process.env.STRATEGY_SWING_CANDLE_LOOKBACK_BARS || '120', 10),
      rsiBuyThreshold: parseFloat(process.env.STRATEGY_SWING_RSI_BUY_MIN || '45'),
      rsiBuyMaxThreshold: parseFloat(process.env.STRATEGY_SWING_RSI_BUY_MAX || '65'),
      volumeSpikeMultiplier: parseFloat(process.env.STRATEGY_SWING_VOLUME_SPIKE || '1.8'),
      breakoutLookback: parseInt(process.env.STRATEGY_SWING_BREAKOUT_LOOKBACK || '30', 10),
      breakoutBufferPct: parseFloat(process.env.STRATEGY_SWING_BREAKOUT_BUFFER || '0.001'),
      minLiquidityUsd: parseFloat(process.env.STRATEGY_SWING_MIN_LIQUIDITY || '500000'),
      minTokenAgeDays: parseFloat(process.env.STRATEGY_SWING_MIN_AGE_DAYS || '7'),
      min24hVolumeUsd: parseFloat(process.env.STRATEGY_SWING_MIN_24H_VOLUME || '100000'),
      requireCoinGeckoOrCmc: process.env.STRATEGY_SWING_REQUIRE_CG_CMC !== 'false',
      excludeStableWrappedLp: process.env.STRATEGY_SWING_EXCLUDE_STABLE_WRAPPED_LP !== 'false',
      positionSizePct: parseFloat(process.env.STRATEGY_SWING_POSITION_SIZE_PCT || '5'),
      stopLossPct: parseFloat(process.env.STRATEGY_SWING_STOP_LOSS_PCT || '12'),
      takeProfitPct: parseFloat(process.env.STRATEGY_SWING_TAKE_PROFIT_PCT || '40'),
      aiConfidenceFloor: parseFloat(process.env.STRATEGY_SWING_AI_CONFIDENCE || '65'),
      maxConcurrentPositions: parseInt(process.env.STRATEGY_SWING_MAX_POSITIONS || '3', 10),
      trailingActivationMultiplier: parseFloat(process.env.STRATEGY_SWING_TRAIL_ACTIVATION_MULT || '2.0'),
      trailingStopPct: parseFloat(process.env.STRATEGY_SWING_TRAIL_STOP_PCT || '20'),
      maxHoldMinutes: parseInt(process.env.STRATEGY_SWING_MAX_HOLD_MINUTES || '4320', 10),
      rsiExitThreshold: parseFloat(process.env.STRATEGY_SWING_RSI_EXIT || '78'),
      liquidityDropExitPct: parseFloat(process.env.STRATEGY_SWING_LIQ_DROP_EXIT_PCT || '30'),
      holderConcentrationJumpPct: parseFloat(process.env.STRATEGY_SWING_HOLDER_JUMP_PCT || '8'),
      disabledFilters: (process.env.STRATEGY_SWING_DISABLED_FILTERS || 'reddit,defillama').split(',').filter(f => f.trim()), // Disable Reddit & DeFiLlama for swing
      // Item 7: adaptive tiered exit — delay/accelerate each sell tier based on momentum at trigger time.
      adaptiveTierExit: process.env.STRATEGY_SWING_ADAPTIVE_TIER_EXIT !== 'false',
      tierDelayRsiMin: parseFloat(process.env.STRATEGY_SWING_TIER_DELAY_RSI_MIN || '70'),         // RSI above this + volume OK → delay 1 cycle (let winners run)
      tierAccelSellRatioPct: parseFloat(process.env.STRATEGY_SWING_TIER_ACCEL_SELL_RATIO || '60'), // Sell ratio above this → immediate full exit
      tierLocalHighReversalPct: parseFloat(process.env.STRATEGY_SWING_TIER_REVERSAL_PCT || '5'),   // Price reversal from local high → immediate full exit
      sellTiers: [
        { profitMultiplier: 1.4, sellPct: 0.5 },
        { profitMultiplier: 1.7, sellPct: 0.25 },
        { profitMultiplier: 2.0, sellPct: 0.25 },
      ],
    },
    // Strategy B: New Launch Momentum (existing logic, < 6h old tokens)
    momentum: {
      enabled: process.env.STRATEGY_MOMENTUM_ENABLED !== 'false',
      emaFast: parseInt(process.env.STRATEGY_MOMENTUM_EMA_FAST || '9', 10),
      emaSlow: parseInt(process.env.STRATEGY_MOMENTUM_EMA_SLOW || '21', 10),
      rsiPeriod: parseInt(process.env.STRATEGY_MOMENTUM_RSI_PERIOD || '14', 10),
      candleInterval: process.env.STRATEGY_MOMENTUM_CANDLE_INTERVAL || '15m',
      candleLookbackBars: parseInt(process.env.STRATEGY_MOMENTUM_CANDLE_LOOKBACK_BARS || '120', 10),
      rsiBuyThreshold: parseFloat(process.env.STRATEGY_MOMENTUM_RSI_BUY_MIN || '55'),
      rsiBuyMaxThreshold: parseFloat(process.env.STRATEGY_MOMENTUM_RSI_BUY_MAX || '75'),
      volumeSpikeMultiplier: parseFloat(process.env.STRATEGY_MOMENTUM_VOLUME_SPIKE || '2.5'),
      lowVolVolumeSpikeMultiplier: parseFloat(process.env.STRATEGY_MOMENTUM_LOW_VOL_SPIKE || '2.1'),
      highVolVolumeSpikeMultiplier: parseFloat(process.env.STRATEGY_MOMENTUM_HIGH_VOL_SPIKE || '3.0'),
      breakoutLookback: parseInt(process.env.STRATEGY_MOMENTUM_BREAKOUT_LOOKBACK || '20', 10),
      breakoutBufferPct: parseFloat(process.env.STRATEGY_MOMENTUM_BREAKOUT_BUFFER || '0.002'),
      minLiquidityUsd: parseFloat(process.env.STRATEGY_MOMENTUM_MIN_LIQUIDITY || '10000'),
      maxLiquidityUsd: parseFloat(process.env.STRATEGY_MOMENTUM_MAX_LIQUIDITY || '500000'),
      maxTokenAgeDays: parseFloat(process.env.STRATEGY_MOMENTUM_MAX_AGE_DAYS || '0.25'), // 6 hours = 0.25 days
      minNetBuyFlowUsd: parseFloat(process.env.STRATEGY_MOMENTUM_MIN_NET_BUY_FLOW || '15000'),
      minTxCountFirstHour: parseInt(process.env.STRATEGY_MOMENTUM_MIN_TX_FIRST_HOUR || '50', 10),
      minBuyRatioPct10m: parseFloat(process.env.STRATEGY_MOMENTUM_MIN_BUY_RATIO_PCT_10M || '60'),
      minUniqueBuyers10m: parseInt(process.env.STRATEGY_MOMENTUM_MIN_UNIQUE_BUYERS_10M || '20', 10),
      strictSolanaOnchainChecks: process.env.STRATEGY_MOMENTUM_STRICT_SOLANA_ONCHAIN_CHECKS !== 'false',
      maxTopHoldersPct: parseFloat(process.env.STRATEGY_MOMENTUM_MAX_TOP_HOLDERS_PCT || '60'),
      positionSizePct: parseFloat(process.env.STRATEGY_MOMENTUM_POSITION_SIZE_PCT || '2'),
      stopLossPct: parseFloat(process.env.STRATEGY_MOMENTUM_STOP_LOSS_PCT || '8'),
      takeProfitPct: parseFloat(process.env.STRATEGY_MOMENTUM_TAKE_PROFIT_PCT || '25'),
      aiConfidenceFloor: parseFloat(process.env.STRATEGY_MOMENTUM_AI_CONFIDENCE || '75'),
      maxConcurrentPositions: parseInt(process.env.STRATEGY_MOMENTUM_MAX_POSITIONS || '3', 10),
      trailingActivationMultiplier: parseFloat(process.env.STRATEGY_MOMENTUM_TRAIL_ACTIVATION_MULT || '1.5'),
      trailingStopPct: parseFloat(process.env.STRATEGY_MOMENTUM_TRAIL_STOP_PCT || '15'),
      maxHoldMinutes: parseInt(process.env.STRATEGY_MOMENTUM_MAX_HOLD_MINUTES || '240', 10),
      maxSellRatioPct10m: parseFloat(process.env.STRATEGY_MOMENTUM_MAX_SELL_RATIO_PCT_10M || '60'),
      liquidityDropExitPct: parseFloat(process.env.STRATEGY_MOMENTUM_LIQ_DROP_EXIT_PCT || '20'),
      holderConcentrationJumpPct: parseFloat(process.env.STRATEGY_MOMENTUM_HOLDER_JUMP_PCT || '6'),
      disabledFilters: (process.env.STRATEGY_MOMENTUM_DISABLED_FILTERS || '').split(',').filter(f => f.trim()), // Keep all filters
      // Item 7: adaptive tiered exit — delay/accelerate each sell tier based on momentum at trigger time.
      adaptiveTierExit: process.env.STRATEGY_MOMENTUM_ADAPTIVE_TIER_EXIT !== 'false',
      tierDelayRsiMin: parseFloat(process.env.STRATEGY_MOMENTUM_TIER_DELAY_RSI_MIN || '70'),         // RSI above this + volume OK → delay 1 cycle (let winners run)
      tierAccelSellRatioPct: parseFloat(process.env.STRATEGY_MOMENTUM_TIER_ACCEL_SELL_RATIO || '60'), // Sell ratio above this → immediate full exit
      tierLocalHighReversalPct: parseFloat(process.env.STRATEGY_MOMENTUM_TIER_REVERSAL_PCT || '5'),   // Price reversal from local high → immediate full exit
      sellTiers: [
        { profitMultiplier: 1.25, sellPct: 0.5 },
        { profitMultiplier: 1.6, sellPct: 0.25 },
        { profitMultiplier: 2.0, sellPct: 0.25 },
      ],
    },
  },

  // Legacy strategy config (for backward compatibility, maps to momentum strategy)
  strategy: {
    emaFast: 9,
    emaSlow: 21,
    rsiPeriod: 14,
    rsiBuyThreshold: 55,
    rsiBuyMaxThreshold: 75,
    volumeSpikeMultiplier: 2.5,
    lowVolVolumeSpikeMultiplier: 2.1,
    highVolVolumeSpikeMultiplier: 3.0,
    breakoutLookback: 20,
    breakoutBufferPct: 0.002,
    minNetBuyFlowUsd: 15000,
    sellTiers: [
      { profitMultiplier: 2, sellPct: 0.5 },
      { profitMultiplier: 3, sellPct: 0.25 },
      { profitMultiplier: 5, sellPct: 0.25 },
    ],
  },

  filters: {
    // Reddit sentiment filter: requires minimum posts in lookback window
    reddit: {
      enabled: process.env.REDDIT_FILTER_ENABLED !== 'false', // Enabled by default
      minPostsRequired: parseInt(process.env.REDDIT_MIN_POSTS || '0', 10), // 0 = no requirement (any activity is OK)
      lookbackHours: parseInt(process.env.REDDIT_LOOKBACK_HOURS || '24', 10), // Increased from 1hr to 24hrs for BSC/Base
      disabledChains: (process.env.REDDIT_DISABLED_CHAINS || '').split(',').filter(c => c.trim()), // e.g., 'bsc,base'
    },
    coincap: {
      enabled: process.env.COINCAP_FILTER_ENABLED !== 'false',
      maxPriceMismatchPct: parseFloat(process.env.COINCAP_MAX_MISMATCH_PCT || '15'),
    },
    cryptocompare: {
      enabled: process.env.CRYPTOCOMPARE_FILTER_ENABLED !== 'false',
      maxPriceMismatchPct: parseFloat(process.env.CRYPTOCOMPARE_MAX_MISMATCH_PCT || '15'),
    },
    defillama: {
      enabled: process.env.DEFILLAMA_FILTER_ENABLED !== 'false',
      minApyRequired: parseFloat(process.env.DEFILLAMA_MIN_APY || '2'),
    },
  },

  anthropic: {
    enabled: process.env.ANTHROPIC_ENABLED === 'true',
    apiKey: process.env.ANTHROPIC_API_KEY,
    model: process.env.ANTHROPIC_MODEL || 'claude-3-5-haiku-latest',
    temperature: parseFloat(process.env.ANTHROPIC_TEMPERATURE) || 0.2,
  },

  execution: {
    slippageBps: parseInt(process.env.SLIPPAGE_BPS) || 100,
    maxRetries: parseInt(process.env.EXECUTION_MAX_RETRIES) || 3,
    retryDelayMs: parseInt(process.env.EXECUTION_RETRY_DELAY_MS) || 1200,
    solanaPriorityFeeLamports: parseInt(process.env.SOLANA_PRIORITY_FEE_LAMPORTS) || 50000,
    requiredConfirmationsBsc: parseInt(process.env.REQUIRED_CONFIRMATIONS_BSC || '2', 10),
    requiredConfirmationsBase: parseInt(process.env.REQUIRED_CONFIRMATIONS_BASE || '2', 10),
    bscPrivateTxRpcUrl: process.env.BSC_PRIVATE_TX_RPC_URL || '',
    requirePrivateTxForBsc: process.env.REQUIRE_PRIVATE_TX_FOR_BSC === 'true',
    mevGuardEnabled: process.env.MEV_GUARD_ENABLED !== 'false',
    mevGuardMinLiquidityUsd: parseFloat(process.env.MEV_GUARD_MIN_LIQUIDITY_USD || '150000'),
    solanaOnlyDirectRoutes: process.env.SOLANA_ONLY_DIRECT_ROUTES === 'true',
    solanaMaxPriceImpactPct: parseFloat(process.env.SOLANA_MAX_PRICE_IMPACT_PCT) || 5,
    kucoinMaxSlippagePct: parseFloat(process.env.KUCOIN_MAX_SLIPPAGE_PCT) || 1.2,
  },
};

module.exports = config;
