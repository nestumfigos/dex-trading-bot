require('dotenv').config();

// BOT_PROFILE=paper forces paper mode even when PAPER_TRADING is unset,
// so paper-bot operators cannot accidentally route trades to the live exchange
// just because they forgot the PAPER_TRADING flag.
const botProfile = String(process.env.BOT_PROFILE || '').toLowerCase();
const isPaperTrading = process.env.PAPER_TRADING === 'true' || botProfile === 'paper';
const defaultScanIntervalSeconds = isPaperTrading ? 120 : 75;
const minLiquidityUsdDefault = parseFloat(process.env.MIN_LIQUIDITY_USD) || 10000;
const defaultBscMinLiquidityUsd = parseFloat(process.env.BSC_MIN_LIQUIDITY_USD || String(minLiquidityUsdDefault)) || minLiquidityUsdDefault;
const defaultBscCoreMinLiquidityUsd = parseFloat(process.env.BSC_CORE_MIN_LIQUIDITY_USD || process.env.BSC_TOP_UNIVERSE_MIN_LIQUIDITY_USD || '80000') || 80000;
const defaultBscCoreMinVolume24hUsd = parseFloat(process.env.BSC_CORE_MIN_VOLUME_24H_USD || process.env.BSC_TOP_UNIVERSE_MIN_VOLUME_24H_USD || '200000') || 200000;
const defaultBscExplorationMinLiquidityUsd = parseFloat(process.env.BSC_EXPLORATION_MIN_LIQUIDITY_USD || '50000') || 50000;
const defaultBscExplorationMinVolume24hUsd = parseFloat(process.env.BSC_EXPLORATION_MIN_VOLUME_24H_USD || '80000') || 80000;
const defaultBscYoungTokenMinLiquidityUsd = parseFloat(
  process.env.BSC_YOUNG_TOKEN_MIN_LIQUIDITY_USD
  || String(Math.max(defaultBscMinLiquidityUsd * 2, defaultBscCoreMinLiquidityUsd))
) || Math.max(defaultBscMinLiquidityUsd * 2, defaultBscCoreMinLiquidityUsd);
const defaultBscUniverseSize = parseInt(process.env.BSC_TOP_UNIVERSE_SIZE || '500', 10) || 500;
const defaultBscCoreUniverseSize = parseInt(
  process.env.BSC_CORE_UNIVERSE_SIZE || String(Math.max(40, Math.round(defaultBscUniverseSize * 0.7))),
  10
) || Math.max(40, Math.round(defaultBscUniverseSize * 0.7));
const defaultBscExplorationUniverseSize = parseInt(
  process.env.BSC_EXPLORATION_UNIVERSE_SIZE || String(Math.max(20, defaultBscUniverseSize - defaultBscCoreUniverseSize)),
  10
) || Math.max(20, defaultBscUniverseSize - defaultBscCoreUniverseSize);
const defaultMaxDailyLossPct = parseFloat(process.env.MAX_DAILY_LOSS_PCT || '10') || 10;
const defaultNonTradeLogRetentionHours = parseInt(process.env.NON_TRADE_LOG_RETENTION_HOURS || '24', 10) || 24;
const defaultLogCleanupIntervalMinutes = parseInt(process.env.LOG_CLEANUP_INTERVAL_MINUTES || '60', 10) || 60;

function parseJsonObjectEnv(rawValue, fallback = {}) {
  if (!rawValue) return fallback;
  try {
    const parsed = JSON.parse(rawValue);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function parseJsonArrayEnv(rawValue, fallback = []) {
  if (!rawValue) return fallback;
  try {
    const parsed = JSON.parse(rawValue);
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function toFiniteNumberMap(entries = {}) {
  return Object.fromEntries(
    Object.entries(entries)
      .map(([key, value]) => [String(key || '').trim().toLowerCase(), Number(value)])
      .filter(([key, value]) => key && Number.isFinite(value) && value >= 0)
  );
}

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
    // RPC default: publicnode (low-latency, healthy). bsc-dataseed.binance.org
    // started timing out in 2026-05; left as override via env if operator
    // wants to point at a paid endpoint.
    rpcUrl: process.env.BSC_RPC_URL || 'https://bsc-rpc.publicnode.com',
    wsUrl: process.env.BSC_WS_URL || '',
    chainId: 56,
    pancakeRouterV2: '0x10ED43C718714eb63d5aA57B78B54704E256024E',
    pancakeFactoryV2: '0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73',
    wbnb: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
    busd: '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56',
  },

  base: {
    privateKey: process.env.BASE_PRIVATE_KEY,
    // RPC default: publicnode (mainnet.base.org started timing out in 2026-05).
    rpcUrl: process.env.BASE_RPC_URL || 'https://base-rpc.publicnode.com',
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

  coinpaprika: {
    enabled: process.env.COINPAPRIKA_ENABLED !== 'false',
    baseUrl: process.env.COINPAPRIKA_BASE_URL || 'https://api.coinpaprika.com/v1',
    snapshotTtlMs: parseInt(process.env.COINPAPRIKA_SNAPSHOT_TTL_MS || '60000', 10),
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
    enabled: process.env.GROQ_ENABLED !== 'false',
    apiKey: process.env.GROQ_API_KEY,
    model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
  },

  gemini: {
    enabled: process.env.GEMINI_ENABLED !== 'false',
    apiKey: process.env.GEMINI_API_KEY,
    model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
  },

  nvidia: {
    enabled: process.env.NVIDIA_ENABLED !== 'false',
    apiKey: process.env.NVIDIA_API_KEY,
    model: process.env.NVIDIA_MODEL || 'deepseek-ai/deepseek-v4-pro',
    apiUrl: 'https://integrate.api.nvidia.com/v1/chat/completions',
  },

  cerebras: {
    enabled: process.env.CEREBRAS_ENABLED !== 'false',
    apiKey: process.env.CEREBRAS_API_KEY || '',
    model: process.env.CEREBRAS_MODEL || 'llama-3.3-70b',
    apiUrl: 'https://api.cerebras.ai/v1/chat/completions',
  },

  mistral: {
    enabled: process.env.MISTRAL_ENABLED !== 'false',
    apiKey: process.env.MISTRAL_API_KEY || '',
    model: process.env.MISTRAL_MODEL || 'mistral-small-latest',
    apiUrl: 'https://api.mistral.ai/v1/chat/completions',
  },

  openrouter: {
    enabled: process.env.OPENROUTER_ENABLED !== 'false',
    apiKey: process.env.OPENROUTER_API_KEY || '',
    model: process.env.OPENROUTER_MODEL || 'meta-llama/llama-3.3-70b-instruct:free',
    apiUrl: 'https://openrouter.ai/api/v1/chat/completions',
    siteUrl: process.env.OPENROUTER_SITE_URL || 'https://github.com/dex-trading-bot',
    siteName: process.env.OPENROUTER_SITE_NAME || 'dex-trading-bot',
  },

  // SambaNova — 100% free, no credit card. Sign up at cloud.sambanova.ai
  // Supports Meta-Llama-3.3-70B-Instruct and Meta-Llama-3.1-405B-Instruct for free.
  sambanova: {
    enabled: process.env.SAMBANOVA_ENABLED !== 'false',
    apiKey: process.env.SAMBANOVA_API_KEY || '',
    model: process.env.SAMBANOVA_MODEL || 'Meta-Llama-3.3-70B-Instruct',
    apiUrl: 'https://api.sambanova.ai/v1/chat/completions',
  },

  // Together AI — $25 free credits on signup (no CC). api.together.xyz
  together: {
    enabled: process.env.TOGETHER_ENABLED !== 'false',
    apiKey: process.env.TOGETHER_API_KEY || '',
    model: process.env.TOGETHER_MODEL || 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    apiUrl: 'https://api.together.xyz/v1/chat/completions',
  },

  ai: {
    narrativeMinScore: parseFloat(process.env.AI_NARRATIVE_MIN_SCORE) || 65,
    decisionCacheMs: parseInt(process.env.AI_DECISION_CACHE_MS || '300000', 10),
    // Per-strategy AI cache freshness — momentum prices move fast, swing tolerates longer caching.
    momentumDecisionCacheMs: parseInt(process.env.AI_MOMENTUM_DECISION_CACHE_MS || '300000', 10), // 5 min
    swingDecisionCacheMs: parseInt(process.env.AI_SWING_DECISION_CACHE_MS || '1800000', 10),     // 30 min
  },

  telegram: {
    token: process.env.TELEGRAM_TOKEN,
    chatId: process.env.TELEGRAM_CHAT_ID,
  },

  risk: {
    maxPositionSizePct: parseFloat(process.env.MAX_POSITION_SIZE_PCT) || 3,
    kucoinMaxPositionSizePct: parseFloat(process.env.KUCOIN_MAX_POSITION_SIZE_PCT || '140') || 140,
    // B2.21: synced paper→live (paper tighter = safer). Paper has 6%; live had 8%.
    // Earlier stop firing reduces tail-loss exposure. Operators may override via env.
    stopLossPct: parseFloat(process.env.STOP_LOSS_PCT) || 6,
    takeProfitPct: parseFloat(process.env.TAKE_PROFIT_PCT) || 25,
    // Disaster-floor: hard exit if position drops more than this % from entry, regardless
    // of configured stopLoss. Catches cases where stopLoss is missing/misconfigured.
    disasterStopPct: parseFloat(process.env.DISASTER_STOP_PCT) || 25,
    // 2-of-3 signal confirmation: require ≥N of (Technical, AI, Sentiment) to confirm BUY.
    requireSignalCascade: process.env.REQUIRE_SIGNAL_CASCADE !== 'false',
    signalCascadeMinConfirmations: parseInt(process.env.SIGNAL_CASCADE_MIN_CONFIRMATIONS || '2', 10),
    // Dynamic AI confidence floor — adjusts ±maxAdjust based on rolling win rate.
    dynamicAiFloorEnabled: process.env.DYNAMIC_AI_FLOOR_ENABLED !== 'false',
    dynamicAiFloorSlope: parseFloat(process.env.DYNAMIC_AI_FLOOR_SLOPE || '0.5'),
    dynamicAiFloorTargetWinRatePct: parseFloat(process.env.DYNAMIC_AI_FLOOR_TARGET_WR_PCT || '50'),
    dynamicAiFloorMaxAdjustPct: parseFloat(process.env.DYNAMIC_AI_FLOOR_MAX_ADJUST_PCT || '12'),
    // Liquidity-depth aware sizing: cap position at N% of available liquidity to limit slippage.
    liquidityDepthSizingEnabled: process.env.LIQUIDITY_DEPTH_SIZING_ENABLED !== 'false',
    liquidityDepthMaxSharePct: parseFloat(process.env.LIQUIDITY_DEPTH_MAX_SHARE_PCT || '1.5'),
    minPositionSizeUsd: parseFloat(process.env.MIN_POSITION_SIZE_USD || '5'),
    // Regime-adaptive parameters: tweak RSI/volume thresholds based on realized volatility.
    regimeAdaptiveParamsEnabled: process.env.REGIME_ADAPTIVE_PARAMS_ENABLED !== 'false',
    // Graduated stale-drift exit: forces out barely-profitable positions that won't move.
    // Without this, slow-bleed winners trap capital indefinitely (never hit TP, never hit SL).
    staleDriftExitEnabled: process.env.STALE_DRIFT_EXIT_ENABLED !== 'false',
    // B2.21 (drift retained intentional): live keeps tighter stale-drift windows
    // (12h/1%) versus paper (24h/3%). Live is more aggressive on cleaning up
    // slow-bleed winners that won't move — operator may sync paper-side later
    // after A/B observation. See audit/phase-a/11-live-paper-drift.md.
    staleDriftTier1Hours: parseFloat(process.env.STALE_DRIFT_TIER1_HOURS || '12'),
    staleDriftTier1MinProfitPct: parseFloat(process.env.STALE_DRIFT_TIER1_MIN_PROFIT_PCT || '1'),
    staleDriftTier2Hours: parseFloat(process.env.STALE_DRIFT_TIER2_HOURS || '24'),
    staleDriftTier2MinProfitPct: parseFloat(process.env.STALE_DRIFT_TIER2_MIN_PROFIT_PCT || '3'),
    staleDriftTier3Hours: parseFloat(process.env.STALE_DRIFT_TIER3_HOURS || '48'),
    staleDriftTier3MinProfitPct: parseFloat(process.env.STALE_DRIFT_TIER3_MIN_PROFIT_PCT || '8'),
    // BTC macro risk-off filter: block altcoin BUYs when BTC is in a 1h selloff.
    // Catches market-wide flushes that vaporize altcoin momentum.
    btcRiskOffEnabled: process.env.BTC_RISK_OFF_ENABLED !== 'false',
    btcRiskOffThresholdPct: parseFloat(process.env.BTC_RISK_OFF_THRESHOLD_PCT || '2'),
    btcRiskOffPollMinutes: parseFloat(process.env.BTC_RISK_OFF_POLL_MINUTES || '5'),
    minLiquidityUsd: minLiquidityUsdDefault,
    // B2.21: synced paper→live (paper: 1800s / 30min). Tighter window forces
    // fresher catalyst data when admitting recent listings; reduces stale entries.
    newListingAgeSec: parseInt(process.env.NEW_LISTING_AGE_SEC || '1800', 10),
    newListingVolThresholdUsd: parseFloat(process.env.NEW_LISTING_VOL_THRESHOLD || String(minLiquidityUsdDefault / 2)),
    catalystEnabled: process.env.CATALYST_ENABLED !== 'false',
    catalystCacheTtlSeconds: parseInt(process.env.CATALYST_CACHE_TTL_SECONDS || '900', 10),
    catalystNewsLimit: parseInt(process.env.CATALYST_NEWS_LIMIT || '30', 10),
    catalystPreEventMaxLeadMinutes: parseInt(process.env.CATALYST_PRE_EVENT_MAX_LEAD_MINUTES || '1440', 10),
    catalystPreEventMinLeadMinutes: parseInt(process.env.CATALYST_PRE_EVENT_MIN_LEAD_MINUTES || '15', 10),
    catalystMinConfidence: parseFloat(process.env.CATALYST_MIN_CONFIDENCE || '72'),
    catalystMinSourceCount: parseInt(process.env.CATALYST_MIN_SOURCE_COUNT || '2', 10),
    maxConcurrentPositions: parseInt(process.env.MAX_CONCURRENT_POSITIONS) || 5,
    dailyDrawdownLimitPct: parseFloat(process.env.DAILY_DRAWDOWN_LIMIT_PCT || String(defaultMaxDailyLossPct)) || defaultMaxDailyLossPct,
    maxTokenAgeHours: parseFloat(process.env.MAX_TOKEN_AGE_HOURS) || 6,
    trailingStopAfterMultiplier: parseFloat(process.env.TRAILING_STOP_AFTER_MULTIPLIER) || 2,
    // B2.21: synced paper→live (paper: 2.5%). Tighter trailing locks in gains
    // sooner on volatile reversals — the previous 15% trailing meant winners
    // could pull back 15% before exit, surrendering most of the move.
    trailingStopPct: parseFloat(process.env.TRAILING_STOP_PCT) || 2.5,
    maxCorrelationPct: parseFloat(process.env.MAX_CORRELATION_PCT) || 75,
    aiConfidenceFloor: parseFloat(process.env.AI_CONFIDENCE_FLOOR) || 70,
    maxConsecutiveLosses: parseInt(process.env.MAX_CONSECUTIVE_LOSSES || '4', 10),
    maxConsecutiveLossesByChain: toFiniteNumberMap({
      bsc: parseInt(process.env.BSC_MAX_CONSECUTIVE_LOSSES || '8', 10),
      ...parseJsonObjectEnv(process.env.MAX_CONSECUTIVE_LOSSES_BY_CHAIN, {}),
    }),
    minTradesForKpiGate: parseInt(process.env.MIN_TRADES_FOR_KPI_GATE || '50', 10),
    minProfitFactor: parseFloat(process.env.MIN_PROFIT_FACTOR || '1.15'),
    maxPortfolioHeatPct: parseFloat(process.env.MAX_PORTFOLIO_HEAT_PCT || '45'),
    maxGlobalExposurePct: parseFloat(process.env.MAX_GLOBAL_EXPOSURE_PCT || '90'),
    kucoinMomentumHeatAllowancePct: parseFloat(process.env.KUCOIN_MOMENTUM_HEAT_ALLOWANCE_PCT || '60'),
    kucoinSwingHeatAllowancePct: parseFloat(process.env.KUCOIN_SWING_HEAT_ALLOWANCE_PCT || '95'),
    heatExemptSymbols: (process.env.HEAT_EXEMPT_SYMBOLS || 'BANANAS31').split(',').map(s => s.trim().toUpperCase()).filter(Boolean),
    bscMomentumHeatAllowancePct: parseFloat(process.env.BSC_MOMENTUM_HEAT_ALLOWANCE_PCT || '60'),
    portfolioHeatReservePctBySleeve: toFiniteNumberMap({
      'bsc:momentum': parseFloat(process.env.BSC_MOMENTUM_HEAT_RESERVE_PCT || '12'),
      ...parseJsonObjectEnv(process.env.PORTFOLIO_HEAT_RESERVE_PCT_BY_SLEEVE, {}),
    }),
    maxDailyLossPct: defaultMaxDailyLossPct,
    maxAverageSlippageBps: parseFloat(process.env.MAX_AVG_SLIPPAGE_BPS || '180'),
    maxBalanceDriftPct: parseFloat(process.env.MAX_BALANCE_DRIFT_PCT || '10'),
    reconciliationDustUsd: parseFloat(process.env.RECONCILIATION_DUST_USD || '5'),
    maxNativePriceAgeMs: parseInt(process.env.MAX_NATIVE_PRICE_AGE_MS || '120000', 10),
    minBalanceCoverage: parseInt(process.env.MIN_BALANCE_COVERAGE || '2', 10),
    maxSuppressedTokenErrors: parseInt(process.env.MAX_SUPPRESSED_TOKEN_ERRORS || '10', 10),
    maxRoundTripFrictionPct: parseFloat(process.env.MAX_ROUND_TRIP_FRICTION_PCT || '15'),
    liveBscEntriesEnabled: process.env.LIVE_BSC_ENTRIES_ENABLED === 'true',
    maxReserveImbalanceRatio: parseFloat(process.env.MAX_RESERVE_IMBALANCE_RATIO || '1000'),
    maxMarketImpactPct: parseFloat(process.env.MAX_MARKET_IMPACT_PCT || '3'),
    maxTradeShareOfHourlyVolumePct: parseFloat(process.env.MAX_TRADE_SHARE_HOURLY_VOLUME_PCT || '0.5'),
    regimeSizeScalingEnabled: process.env.REGIME_SIZE_SCALING_ENABLED !== 'false',
    regimeHighVolThresholdPct: parseFloat(process.env.REGIME_HIGH_VOL_THRESHOLD_PCT || '4'),
    regimeExtremeVolThresholdPct: parseFloat(process.env.REGIME_EXTREME_VOL_THRESHOLD_PCT || '7'),
    regimeNormalSizeMultiplier: parseFloat(process.env.REGIME_NORMAL_SIZE_MULTIPLIER || '1'),
    regimeHighVolSizeMultiplier: parseFloat(process.env.REGIME_HIGH_VOL_SIZE_MULTIPLIER || '0.75'),
    regimeExtremeVolSizeMultiplier: parseFloat(process.env.REGIME_EXTREME_VOL_SIZE_MULTIPLIER || '0.5'),
    assumedWinRatePct: parseFloat(process.env.ASSUMED_WIN_RATE_PCT || '42'),
    estimatedDexFeePctPerSide: parseFloat(process.env.ESTIMATED_DEX_FEE_PCT_PER_SIDE || '0.3'),
    estimatedMevTaxPctPerRoundTrip: parseFloat(process.env.ESTIMATED_MEV_TAX_PCT_PER_ROUND_TRIP || '0.7'),
    estimatedNetworkCostPctPerRoundTrip: parseFloat(process.env.ESTIMATED_NETWORK_COST_PCT_PER_ROUND_TRIP || '0.2'),
    liquiditySentinelEnabled: process.env.LIQUIDITY_SENTINEL_ENABLED !== 'false',
    minNetExpectedEdgePct: parseFloat(process.env.MIN_NET_EXPECTED_EDGE_PCT || '0.8'),
    minLiquidityUsdByChain: toFiniteNumberMap({
      bsc: defaultBscMinLiquidityUsd,
      ...parseJsonObjectEnv(process.env.MIN_LIQUIDITY_USD_BY_CHAIN, {}),
    }),
    youngTokenMinLiquidityUsdByChain: toFiniteNumberMap({
      bsc: defaultBscYoungTokenMinLiquidityUsd,
      ...parseJsonObjectEnv(process.env.YOUNG_TOKEN_MIN_LIQUIDITY_USD_BY_CHAIN, {}),
    }),
    maxHoldMinutesGlobal: parseInt(process.env.MAX_HOLD_MINUTES_GLOBAL || '4320', 10),
    maxDailyLossPctByChain: (() => {
      const raw = process.env.MAX_DAILY_LOSS_PCT_BY_CHAIN;
      if (raw) {
        try { return JSON.parse(raw); } catch { /* fall through */ }
      }
      return {
        solana: defaultMaxDailyLossPct,
        bsc: defaultMaxDailyLossPct,
        base: defaultMaxDailyLossPct,
        kucoin: defaultMaxDailyLossPct,
      };
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
    stopHuntDelayMs: parseInt(process.env.STOP_HUNT_DELAY_MS || '30000', 10),
    stopHuntBorderlinePct: parseFloat(process.env.STOP_HUNT_BORDERLINE_PCT || '0.35'),
    hourlyWinRateModelEnabled: process.env.HOURLY_WIN_RATE_MODEL_ENABLED !== 'false',
    hourlyWinRateMinTrades: parseInt(process.env.HOURLY_WIN_RATE_MIN_TRADES || '5', 10),
    hourlyWinRateLowPct: parseFloat(process.env.HOURLY_WIN_RATE_LOW_PCT || '40'),
    hourlyWinRateHighPct: parseFloat(process.env.HOURLY_WIN_RATE_HIGH_PCT || '60'),
    hourlyWinRateThresholdAdjustPct: parseFloat(process.env.HOURLY_WIN_RATE_THRESHOLD_ADJUST_PCT || '5'),
    tokenDataFetchTimeoutMs: parseInt(process.env.TOKEN_DATA_FETCH_TIMEOUT_MS || '5000', 10),
    realtimeStopLossEnabled: process.env.REALTIME_STOP_LOSS_ENABLED !== 'false',
    realtimeStopCheckSeconds: parseInt(process.env.REALTIME_STOP_CHECK_SECONDS || '8', 10),
    realtimeStopFetchTimeoutMs: parseInt(process.env.REALTIME_STOP_FETCH_TIMEOUT_MS || '6000', 10),
    learningEnabled: process.env.LEARNING_ENABLED !== 'false',
    learnedPatternCooldownHours: parseFloat(process.env.LEARNED_PATTERN_COOLDOWN_HOURS || '168'),
    learnedPatternHardBanHours: parseFloat(process.env.LEARNED_PATTERN_HARD_BAN_HOURS || '720'),
    learnedPatternStrikeThreshold: parseInt(process.env.LEARNED_PATTERN_STRIKE_THRESHOLD || '2', 10),
    adaptiveSizingEnabled: process.env.ADAPTIVE_SIZING_ENABLED !== 'false',
    adaptiveSizingWindowTrades: parseInt(process.env.ADAPTIVE_SIZING_WINDOW_TRADES || '20', 10),
    adaptiveSizingMinTrades: parseInt(process.env.ADAPTIVE_SIZING_MIN_TRADES || '6', 10),
    adaptiveSizingLowWinRatePct: parseFloat(process.env.ADAPTIVE_SIZING_LOW_WIN_RATE_PCT || '40'),
    adaptiveSizingHighWinRatePct: parseFloat(process.env.ADAPTIVE_SIZING_HIGH_WIN_RATE_PCT || '60'),
    adaptiveSizingReduceMultiplier: parseFloat(process.env.ADAPTIVE_SIZING_REDUCE_MULTIPLIER || '0.70'),
    adaptiveSizingBoostMultiplier: parseFloat(process.env.ADAPTIVE_SIZING_BOOST_MULTIPLIER || '1.05'),
    adaptiveSizingMinMultiplier: parseFloat(process.env.ADAPTIVE_SIZING_MIN_MULTIPLIER || '0.45'),
    adaptiveSizingMaxMultiplier: parseFloat(process.env.ADAPTIVE_SIZING_MAX_MULTIPLIER || '1.15'),
    brainEnabled: process.env.BRAIN_ENABLED !== 'false',
    brainMinSamples: parseInt(process.env.BRAIN_MIN_SAMPLES || '8', 10),
    brainWindowTrades: parseInt(process.env.BRAIN_WINDOW_TRADES || '40', 10),
    brainLowWinRatePct: parseFloat(process.env.BRAIN_LOW_WIN_RATE_PCT || '35'),
    brainHighWinRatePct: parseFloat(process.env.BRAIN_HIGH_WIN_RATE_PCT || '60'),
    brainBlockWinRatePct: parseFloat(process.env.BRAIN_BLOCK_WIN_RATE_PCT || '22'),
    brainExploreBypassPct: parseFloat(process.env.BRAIN_EXPLORE_BYPASS_PCT || '7'),
    brainReduceMultiplier: parseFloat(process.env.BRAIN_REDUCE_MULTIPLIER || '0.70'),
    brainBoostMultiplier: parseFloat(process.env.BRAIN_BOOST_MULTIPLIER || '1.10'),
    brainMinMultiplier: parseFloat(process.env.BRAIN_MIN_MULTIPLIER || '0.50'),
    brainMaxMultiplier: parseFloat(process.env.BRAIN_MAX_MULTIPLIER || '1.20'),
  },

  bot: {
    scanIntervalSeconds: parseInt(process.env.SCAN_INTERVAL_SECONDS) || defaultScanIntervalSeconds,
    momentumScanIntervalSeconds: parseInt(process.env.MOMENTUM_SCAN_INTERVAL_SECONDS || process.env.SCAN_INTERVAL_SECONDS || '75', 10),
    swingScanIntervalMinutes: parseInt(process.env.SWING_SCAN_INTERVAL_MINUTES || '15', 10),
    bullFlagScanIntervalSeconds: parseInt(process.env.BULL_FLAG_SCAN_INTERVAL_SECONDS || '90', 10),
    kucoinScanAllSymbols: process.env.KUCOIN_SCAN_ALL_SYMBOLS !== 'false',
    kucoinMaxTokensPerCycle: parseInt(process.env.KUCOIN_MAX_TOKENS_PER_CYCLE || '0', 10),
    kucoinBatchSize: parseInt(process.env.KUCOIN_BATCH_SIZE || '12', 10),
    kucoinBatchDelayMs: parseInt(process.env.KUCOIN_BATCH_DELAY_MS || '700', 10),
    momentumExitCheckMinutes: parseInt(process.env.MOMENTUM_EXIT_CHECK_MINUTES || '15', 10),
    swingExitCheckMinutes: parseInt(process.env.SWING_EXIT_CHECK_MINUTES || '60', 10),
    bullFlagExitCheckMinutes: parseInt(process.env.BULL_FLAG_EXIT_CHECK_MINUTES || process.env.MOMENTUM_EXIT_CHECK_MINUTES || '15', 10),
    swingWatchlistRefreshHours: parseInt(process.env.SWING_WATCHLIST_REFRESH_HOURS || '24', 10),
    walletBalanceRefreshSeconds: parseInt(process.env.WALLET_BALANCE_REFRESH_SECONDS || '60', 10),
    discoveryMode: String(process.env.DISCOVERY_MODE || 'hybrid').toLowerCase(), // watchlist | new | hybrid
    port: parseInt(process.env.PORT) || 3002,
    logLevel: process.env.LOG_LEVEL || 'info',
    nonTradeLogRetentionHours: defaultNonTradeLogRetentionHours,
    logCleanupIntervalMinutes: defaultLogCleanupIntervalMinutes,
    aiFailureCooldownSeconds: parseInt(process.env.AI_FAILURE_COOLDOWN_SECONDS) || 180,
    aiFailureThreshold: parseInt(process.env.AI_FAILURE_THRESHOLD) || 5,
    exchangeFailureThreshold: parseInt(process.env.EXCHANGE_FAILURE_THRESHOLD) || 4,
    exchangeFailureCooldownSeconds: parseInt(process.env.EXCHANGE_FAILURE_COOLDOWN_SECONDS) || 120,
    scanDiscoveryTimeoutMs: parseInt(process.env.SCAN_DISCOVERY_TIMEOUT_MS || '120000', 10),
    bscScanDiscoveryTimeoutMs: parseInt(process.env.BSC_SCAN_DISCOVERY_TIMEOUT_MS || '150000', 10),
    bscDiscoveryPollTimeoutMs: parseInt(process.env.BSC_DISCOVERY_POLL_TIMEOUT_MS || '90000', 10),
    bscHybridPollTimeoutMs: parseInt(process.env.BSC_HYBRID_POLL_TIMEOUT_MS || '10000', 10),
    kucoinScanDiscoveryTimeoutMs: parseInt(process.env.KUCOIN_SCAN_DISCOVERY_TIMEOUT_MS || '420000', 10),
    solanaScanDiscoveryTimeoutMs: parseInt(process.env.SOLANA_SCAN_DISCOVERY_TIMEOUT_MS || '90000', 10),
    liveAbortDelayMs: parseInt(process.env.LIVE_ABORT_DELAY_MS) || 10000, // Time to abort live trading on startup
  },

  discovery: {
    websocketEnabled: process.env.WS_DISCOVERY_ENABLED !== 'false',
    pollTimeoutMs: parseInt(process.env.DISCOVERY_POLL_TIMEOUT_MS || '4000', 10),
    hybridPollTimeoutMs: parseInt(process.env.HYBRID_POLL_TIMEOUT_MS || '300', 10),
    reconnectBaseDelayMs: parseInt(process.env.WS_DISCOVERY_RECONNECT_BASE_DELAY_MS || '2000', 10),
    reconnectMaxDelayMs: parseInt(process.env.WS_DISCOVERY_RECONNECT_MAX_DELAY_MS || '30000', 10),
    maxTrackedTokensPerChain: parseInt(process.env.WS_DISCOVERY_MAX_TOKENS || '500', 10),
    bscTopUniverseEnabled: process.env.BSC_TOP_UNIVERSE_ENABLED !== 'false',
    bscTopUniverseSize: defaultBscUniverseSize,
    bscTopUniverseMinLiquidityUsd: defaultBscCoreMinLiquidityUsd,
    bscTopUniverseMinVolume24hUsd: defaultBscCoreMinVolume24hUsd,
    bscCoreUniverseSize: defaultBscCoreUniverseSize,
    bscCoreMinLiquidityUsd: defaultBscCoreMinLiquidityUsd,
    bscCoreMinVolume24hUsd: defaultBscCoreMinVolume24hUsd,
    bscExplorationEnabled: process.env.BSC_EXPLORATION_ENABLED !== 'false',
    bscExplorationUniverseSize: defaultBscExplorationUniverseSize,
    bscExplorationMinLiquidityUsd: defaultBscExplorationMinLiquidityUsd,
    bscExplorationMinVolume24hUsd: defaultBscExplorationMinVolume24hUsd,
    bscBorderlineEnabled: process.env.BSC_BORDERLINE_ENABLED === 'true',
    bscBorderlineUniverseSize: parseInt(process.env.BSC_BORDERLINE_UNIVERSE_SIZE || '10', 10),
    bscBorderlineMinLiquidityUsd: parseFloat(process.env.BSC_BORDERLINE_MIN_LIQUIDITY_USD || '65000'),
    bscBorderlineMinVolume24hUsd: parseFloat(process.env.BSC_BORDERLINE_MIN_VOLUME_24H_USD || '125000'),
    bscTopUniverseMaxAgeDays: parseFloat(process.env.BSC_TOP_UNIVERSE_MAX_AGE_DAYS || '0'), // 0 = no age cap
    bscTopUniverseRequireLegitimacy: process.env.BSC_TOP_UNIVERSE_REQUIRE_LEGITIMACY === 'true',
    bscTopUniverseRankBatchSize: parseInt(process.env.BSC_TOP_UNIVERSE_RANK_BATCH_SIZE || '25', 10),
    bscTopUniverseMaxRankDurationMs: parseInt(process.env.BSC_TOP_UNIVERSE_MAX_RANK_DURATION_MS || '90000', 10),
    bscTopUniverseTokenDataTimeoutMs: parseInt(process.env.BSC_TOP_UNIVERSE_TOKEN_DATA_TIMEOUT_MS || '12000', 10),
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

  strategy: {
    minNetBuyFlowUsd: parseFloat(process.env.MIN_NET_BUY_FLOW_USD || '5000'),
    // Add other strategy defaults if needed
  },

  strategies: {
    momentum: {
      enabled: process.env.MOMENTUM_ENABLED !== 'false',
      enabledChains: String(process.env.MOMENTUM_ENABLED_CHAINS || (isPaperTrading ? 'solana,bsc,kucoin' : 'kucoin')).toLowerCase().split(',').map((s) => s.trim()).filter(Boolean),
      maxConcurrentPositions: parseInt(process.env.MOMENTUM_MAX_CONCURRENT_POSITIONS || '5', 10),
      emaFast: parseInt(process.env.MOMENTUM_EMA_FAST || '8', 10),
      emaSlow: parseInt(process.env.MOMENTUM_EMA_SLOW || '21', 10),
      rsiPeriod: parseInt(process.env.MOMENTUM_RSI_PERIOD || '14', 10),
      rsiBuyThreshold: parseFloat(process.env.MOMENTUM_RSI_BUY_THRESHOLD || '40'),
      rsiBuyMaxThreshold: parseFloat(process.env.MOMENTUM_RSI_BUY_MAX_THRESHOLD || '95'),
      volumeSpikeMultiplier: parseFloat(process.env.MOMENTUM_VOLUME_SPIKE_MULTIPLIER || '1.35'),
      minBuyRatioRecentPct: parseFloat(process.env.MOMENTUM_MIN_BUY_RATIO_RECENT_PCT || '50'),
      minNetBuyFlowUsd: parseFloat(process.env.MOMENTUM_MIN_NET_BUY_FLOW_USD || process.env.MIN_NET_BUY_FLOW_USD || '3500'),
      minPriceChange24hPctAll: parseFloat(process.env.MOMENTUM_MIN_PRICE_CHANGE_24H_PCT_ALL || '1.5'),
      maxPriceChange24hPctAll: parseFloat(process.env.MOMENTUM_MAX_PRICE_CHANGE_24H_PCT_ALL || '110'),
      minPriceChange24hPctKucoin: parseFloat(process.env.MOMENTUM_MIN_PRICE_CHANGE_24H_PCT_KUCOIN || process.env.MOMENTUM_MIN_PRICE_CHANGE_24H_PCT_ALL || '1.5'),
      maxPriceChange24hPctKucoin: parseFloat(process.env.MOMENTUM_MAX_PRICE_CHANGE_24H_PCT_KUCOIN || process.env.MOMENTUM_MAX_PRICE_CHANGE_24H_PCT_ALL || '110'),
      bscExplorationPositionSizeMultiplier: parseFloat(process.env.BSC_EXPLORATION_POSITION_SIZE_MULTIPLIER || '0.75'),
      bscBorderlinePositionSizeMultiplier: parseFloat(process.env.BSC_BORDERLINE_POSITION_SIZE_MULTIPLIER || '0.75'),
      sellTiers: parseJsonArrayEnv(process.env.MOMENTUM_SELL_TIERS, [
        { profitMultiplier: 1.08, sellPct: 0.25 },
        { profitMultiplier: 1.15, sellPct: 0.35 },
        { profitMultiplier: 1.25, sellPct: 0.40 },
      ]),
      // Trailing stop: momentum needs the larger 2x activation since it rides parabolic moves.
      trailingActivationMultiplier: parseFloat(process.env.MOMENTUM_TRAILING_ACTIVATION_MULTIPLIER || '2.0'),
      trailingStopPct: parseFloat(process.env.MOMENTUM_TRAILING_STOP_PCT || '15'),
    },
    swing: {
      enabled: process.env.SWING_ENABLED === 'true',
      enabledChains: String(process.env.SWING_ENABLED_CHAINS || 'kucoin').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean),
      maxConcurrentPositions: parseInt(process.env.SWING_MAX_CONCURRENT_POSITIONS || '5', 10),
      emaFast: parseInt(process.env.SWING_EMA_FAST || '50', 10),
      emaSlow: parseInt(process.env.SWING_EMA_SLOW || '200', 10),
      rsiBuyThreshold: parseFloat(process.env.SWING_RSI_BUY_THRESHOLD || '35'),
      rsiBuyMaxThreshold: parseFloat(process.env.SWING_RSI_BUY_MAX_THRESHOLD || '90'),
      volumeSpikeMultiplier: parseFloat(process.env.SWING_VOLUME_SPIKE_MULTIPLIER || '1.05'),
      // Swing positions target smaller % gains; activate trailing earlier to protect profit.
      trailingActivationMultiplier: parseFloat(process.env.SWING_TRAILING_ACTIVATION_MULTIPLIER || '1.15'),
      trailingStopPct: parseFloat(process.env.SWING_TRAILING_STOP_PCT || '8'),
      minBuyRatioRecentPct: parseFloat(process.env.SWING_MIN_BUY_RATIO_RECENT_PCT || '48'),
      minNetBuyFlowUsd: parseFloat(process.env.SWING_MIN_NET_BUY_FLOW_USD || process.env.MIN_NET_BUY_FLOW_USD || '1500'),
      minPriceChange24hPctAll: parseFloat(process.env.SWING_MIN_PRICE_CHANGE_24H_PCT_ALL || '0'),
      maxPriceChange24hPctAll: parseFloat(process.env.SWING_MAX_PRICE_CHANGE_24H_PCT_ALL || '140'),
      minPriceChange24hPctKucoin: parseFloat(process.env.SWING_MIN_PRICE_CHANGE_24H_PCT_KUCOIN || process.env.SWING_MIN_PRICE_CHANGE_24H_PCT_ALL || '0'),
      maxPriceChange24hPctKucoin: parseFloat(process.env.SWING_MAX_PRICE_CHANGE_24H_PCT_KUCOIN || process.env.SWING_MAX_PRICE_CHANGE_24H_PCT_ALL || '140'),
      minTokenAgeDays: parseInt(process.env.SWING_MIN_TOKEN_AGE_DAYS || '7', 10),
      minLiquidityUsd: parseFloat(process.env.SWING_MIN_LIQUIDITY_USD || '500000'),
      min24hVolumeUsd: parseFloat(process.env.SWING_MIN_24H_VOLUME_USD || '100000'),
      sellTiers: parseJsonArrayEnv(process.env.SWING_SELL_TIERS, [
        { profitMultiplier: 1.15, sellPct: 0.25 },
        { profitMultiplier: 1.30, sellPct: 0.35 },
        { profitMultiplier: 1.60, sellPct: 0.40 },
      ]),
    },
    backes_swing: {
      enabled: process.env.BACKES_SWING_ENABLED != null ? process.env.BACKES_SWING_ENABLED === 'true' : isPaperTrading,
      enabledChains: String(process.env.BACKES_SWING_ENABLED_CHAINS || 'kucoin').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean),
      maxConcurrentPositions: parseInt(process.env.BACKES_SWING_MAX_CONCURRENT_POSITIONS || '3', 10),
      rsiBuyThreshold: parseFloat(process.env.BACKES_SWING_RSI_BUY_THRESHOLD || '35'),
      rsiBuyMaxThreshold: parseFloat(process.env.BACKES_SWING_RSI_BUY_MAX_THRESHOLD || '72'),
      volumeSpikeMultiplier: parseFloat(process.env.BACKES_SWING_VOLUME_SPIKE_MULTIPLIER || '1.25'),
      minBuyRatioRecentPct: parseFloat(process.env.BACKES_SWING_MIN_BUY_RATIO_RECENT_PCT || '48'),
      minNetBuyFlowUsd: parseFloat(process.env.BACKES_SWING_MIN_NET_BUY_FLOW_USD || '1500'),
      minPriceChange24hPctAll: parseFloat(process.env.BACKES_SWING_MIN_PRICE_CHANGE_24H_PCT_ALL || '0.5'),
      maxPriceChange24hPctAll: parseFloat(process.env.BACKES_SWING_MAX_PRICE_CHANGE_24H_PCT_ALL || '60'),
      minPriceChange24hPctKucoin: parseFloat(process.env.BACKES_SWING_MIN_PRICE_CHANGE_24H_PCT_KUCOIN || '0.5'),
      maxPriceChange24hPctKucoin: parseFloat(process.env.BACKES_SWING_MAX_PRICE_CHANGE_24H_PCT_KUCOIN || '60'),
      minTokenAgeDays: parseInt(process.env.BACKES_SWING_MIN_TOKEN_AGE_DAYS || '30', 10),
      minLiquidityUsd: parseFloat(process.env.BACKES_SWING_MIN_LIQUIDITY_USD || '500000'),
      min24hVolumeUsd: parseFloat(process.env.BACKES_SWING_MIN_24H_VOLUME_USD || '100000'),
      stopLossPct: parseFloat(process.env.BACKES_SWING_STOP_LOSS_PCT || '8'),
      takeProfitPct: parseFloat(process.env.BACKES_SWING_TAKE_PROFIT_PCT || '24'),
      sellTiers: parseJsonArrayEnv(process.env.BACKES_SWING_SELL_TIERS, [
        { profitMultiplier: 1.08, sellPct: 0.50 },
        { profitMultiplier: 1.18, sellPct: 0.30 },
        { profitMultiplier: 1.35, sellPct: 0.20 },
      ]),
    },
    bsc_flow_breakout: {
      enabled: process.env.BSC_FLOW_BREAKOUT_ENABLED != null ? process.env.BSC_FLOW_BREAKOUT_ENABLED === 'true' : isPaperTrading,
      enabledChains: String(process.env.BSC_FLOW_BREAKOUT_ENABLED_CHAINS || 'bsc').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean),
      maxConcurrentPositions: parseInt(process.env.BSC_FLOW_BREAKOUT_MAX_CONCURRENT_POSITIONS || '3', 10),
      rsiBuyThreshold: parseFloat(process.env.BSC_FLOW_BREAKOUT_RSI_BUY_THRESHOLD || '42'),
      rsiBuyMaxThreshold: parseFloat(process.env.BSC_FLOW_BREAKOUT_RSI_BUY_MAX_THRESHOLD || '88'),
      volumeSpikeMultiplier: parseFloat(process.env.BSC_FLOW_BREAKOUT_VOLUME_SPIKE_MULTIPLIER || '1.80'),
      minBuyRatioRecentPct: parseFloat(process.env.BSC_FLOW_BREAKOUT_MIN_BUY_RATIO_RECENT_PCT || '54'),
      minNetBuyFlowUsd: parseFloat(process.env.BSC_FLOW_BREAKOUT_MIN_NET_BUY_FLOW_USD || '5000'),
      minPriceChange24hPctAll: parseFloat(process.env.BSC_FLOW_BREAKOUT_MIN_PRICE_CHANGE_24H_PCT_ALL || '4'),
      maxPriceChange24hPctAll: parseFloat(process.env.BSC_FLOW_BREAKOUT_MAX_PRICE_CHANGE_24H_PCT_ALL || '120'),
      minLiquidityUsd: parseFloat(process.env.BSC_FLOW_BREAKOUT_MIN_LIQUIDITY_USD || '50000'),
      min24hVolumeUsd: parseFloat(process.env.BSC_FLOW_BREAKOUT_MIN_24H_VOLUME_USD || '150000'),
      stopLossPct: parseFloat(process.env.BSC_FLOW_BREAKOUT_STOP_LOSS_PCT || '8'),
      takeProfitPct: parseFloat(process.env.BSC_FLOW_BREAKOUT_TAKE_PROFIT_PCT || '35'),
      sellTiers: parseJsonArrayEnv(process.env.BSC_FLOW_BREAKOUT_SELL_TIERS, [
        { profitMultiplier: 1.10, sellPct: 0.35 },
        { profitMultiplier: 1.22, sellPct: 0.35 },
        { profitMultiplier: 1.45, sellPct: 0.30 },
      ]),
    },
    base_dex_momentum_reclaim: {
      enabled: process.env.BASE_DEX_MOMENTUM_RECLAIM_ENABLED != null ? process.env.BASE_DEX_MOMENTUM_RECLAIM_ENABLED === 'true' : isPaperTrading,
      enabledChains: String(process.env.BASE_DEX_MOMENTUM_RECLAIM_ENABLED_CHAINS || 'base').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean),
      maxConcurrentPositions: parseInt(process.env.BASE_DEX_MOMENTUM_RECLAIM_MAX_CONCURRENT_POSITIONS || '2', 10),
      rsiBuyThreshold: parseFloat(process.env.BASE_DEX_MOMENTUM_RECLAIM_RSI_BUY_THRESHOLD || '40'),
      rsiBuyMaxThreshold: parseFloat(process.env.BASE_DEX_MOMENTUM_RECLAIM_RSI_BUY_MAX_THRESHOLD || '82'),
      volumeSpikeMultiplier: parseFloat(process.env.BASE_DEX_MOMENTUM_RECLAIM_VOLUME_SPIKE_MULTIPLIER || '1.50'),
      minBuyRatioRecentPct: parseFloat(process.env.BASE_DEX_MOMENTUM_RECLAIM_MIN_BUY_RATIO_RECENT_PCT || '52'),
      minNetBuyFlowUsd: parseFloat(process.env.BASE_DEX_MOMENTUM_RECLAIM_MIN_NET_BUY_FLOW_USD || '3500'),
      minPriceChange24hPctAll: parseFloat(process.env.BASE_DEX_MOMENTUM_RECLAIM_MIN_PRICE_CHANGE_24H_PCT_ALL || '2'),
      maxPriceChange24hPctAll: parseFloat(process.env.BASE_DEX_MOMENTUM_RECLAIM_MAX_PRICE_CHANGE_24H_PCT_ALL || '90'),
      minLiquidityUsd: parseFloat(process.env.BASE_DEX_MOMENTUM_RECLAIM_MIN_LIQUIDITY_USD || '100000'),
      min24hVolumeUsd: parseFloat(process.env.BASE_DEX_MOMENTUM_RECLAIM_MIN_24H_VOLUME_USD || '250000'),
      stopLossPct: parseFloat(process.env.BASE_DEX_MOMENTUM_RECLAIM_STOP_LOSS_PCT || '10'),
      takeProfitPct: parseFloat(process.env.BASE_DEX_MOMENTUM_RECLAIM_TAKE_PROFIT_PCT || '30'),
      sellTiers: parseJsonArrayEnv(process.env.BASE_DEX_MOMENTUM_RECLAIM_SELL_TIERS, [
        { profitMultiplier: 1.10, sellPct: 0.30 },
        { profitMultiplier: 1.22, sellPct: 0.35 },
        { profitMultiplier: 1.40, sellPct: 0.35 },
      ]),
    },
    solana_bull_flag_v2: {
      enabled: process.env.SOLANA_BULL_FLAG_V2_ENABLED != null ? process.env.SOLANA_BULL_FLAG_V2_ENABLED === 'true' : isPaperTrading,
      enabledChains: String(process.env.SOLANA_BULL_FLAG_V2_ENABLED_CHAINS || 'solana').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean),
      maxConcurrentPositions: parseInt(process.env.SOLANA_BULL_FLAG_V2_MAX_CONCURRENT_POSITIONS || '2', 10),
      rsiBuyThreshold: parseFloat(process.env.SOLANA_BULL_FLAG_V2_RSI_BUY_THRESHOLD || '42'),
      rsiBuyMaxThreshold: parseFloat(process.env.SOLANA_BULL_FLAG_V2_RSI_BUY_MAX_THRESHOLD || '86'),
      volumeSpikeMultiplier: parseFloat(process.env.SOLANA_BULL_FLAG_V2_VOLUME_SPIKE_MULTIPLIER || '1.60'),
      minBuyRatioRecentPct: parseFloat(process.env.SOLANA_BULL_FLAG_V2_MIN_BUY_RATIO_RECENT_PCT || '52'),
      minNetBuyFlowUsd: parseFloat(process.env.SOLANA_BULL_FLAG_V2_MIN_NET_BUY_FLOW_USD || '4000'),
      minPriceChange24hPctAll: parseFloat(process.env.SOLANA_BULL_FLAG_V2_MIN_PRICE_CHANGE_24H_PCT_ALL || '3'),
      maxPriceChange24hPctAll: parseFloat(process.env.SOLANA_BULL_FLAG_V2_MAX_PRICE_CHANGE_24H_PCT_ALL || '100'),
      minLiquidityUsd: parseFloat(process.env.SOLANA_BULL_FLAG_V2_MIN_LIQUIDITY_USD || '150000'),
      min24hVolumeUsd: parseFloat(process.env.SOLANA_BULL_FLAG_V2_MIN_24H_VOLUME_USD || '300000'),
      stopLossPct: parseFloat(process.env.SOLANA_BULL_FLAG_V2_STOP_LOSS_PCT || '9'),
      takeProfitPct: parseFloat(process.env.SOLANA_BULL_FLAG_V2_TAKE_PROFIT_PCT || '32'),
      sellTiers: parseJsonArrayEnv(process.env.SOLANA_BULL_FLAG_V2_SELL_TIERS, [
        { profitMultiplier: 1.10, sellPct: 0.30 },
        { profitMultiplier: 1.24, sellPct: 0.35 },
        { profitMultiplier: 1.45, sellPct: 0.35 },
      ]),
    },
    spot_day_bull_flag: {
      enabled: process.env.BULL_FLAG_ENABLED === 'true',
      maxConcurrentPositions: parseInt(process.env.BULL_FLAG_MAX_CONCURRENT_POSITIONS || '2', 10),
      // Chains where detector runs. Live deployment must stay KuCoin-only.
      enabledChains: String(process.env.BULL_FLAG_ENABLED_CHAINS || 'kucoin').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean),
      // Detector thresholds (pure-function inputs)
      polePctMin: parseFloat(process.env.BULL_FLAG_POLE_PCT_MIN || '5'),
      poleMaxCandles: parseInt(process.env.BULL_FLAG_POLE_MAX_CANDLES || '4', 10),
      flagMinCandles: parseInt(process.env.BULL_FLAG_FLAG_MIN_CANDLES || '2', 10),
      flagMaxCandles: parseInt(process.env.BULL_FLAG_FLAG_MAX_CANDLES || '8', 10),
      flagDepthMaxPct: parseFloat(process.env.BULL_FLAG_FLAG_DEPTH_MAX_PCT || '50'),
      flagVolContractMaxRatio: parseFloat(process.env.BULL_FLAG_FLAG_VOL_CONTRACT_MAX_RATIO || '0.70'),
      breakoutVolMinRatio: parseFloat(process.env.BULL_FLAG_BREAKOUT_VOL_MIN_RATIO || '1.5'),
      // Scanner gates (applied before invoking detector)
      min24hVolumeUsd: parseFloat(process.env.BULL_FLAG_MIN_24H_VOLUME_USD || '5000000'),
      minLiquidityUsd: parseFloat(process.env.BULL_FLAG_MIN_LIQUIDITY_USD || '500000'),
      minNetEdgePct: parseFloat(process.env.BULL_FLAG_MIN_NET_EDGE_PCT || '2.5'),
      // Risk / sizing
      riskPctBase: parseFloat(process.env.BULL_FLAG_RISK_PCT_BASE || '0.35'),
      riskPctAPlus: parseFloat(process.env.BULL_FLAG_RISK_PCT_APLUS || '0.50'),
      aPlusVolumeExpansionMin: parseFloat(process.env.BULL_FLAG_APLUS_VOL_EXPANSION_MIN || '3.0'),
      aPlusFlagDepthMaxPct: parseFloat(process.env.BULL_FLAG_APLUS_FLAG_DEPTH_MAX_PCT || '30'),
      maxStopDistancePct: parseFloat(process.env.BULL_FLAG_MAX_STOP_DISTANCE_PCT || '3.5'),
      maxDailyLossPct: parseFloat(process.env.BULL_FLAG_MAX_DAILY_LOSS_PCT || '1.5'),
      // Exit rules
      manualCutCandlesNoFollowThrough: parseInt(process.env.BULL_FLAG_MANUAL_CUT_CANDLES || '3', 10),
      manualCutTimeframeMinutes: parseInt(process.env.BULL_FLAG_MANUAL_CUT_TIMEFRAME_MIN || '5', 10),
      // Per-chain stricter overrides (optional, looked up by chain key)
      perChainOverrides: {
        bsc: {
          min24hVolumeUsd: parseFloat(process.env.BULL_FLAG_BSC_MIN_24H_VOLUME_USD || '10000000'),
          minTokenAgeDays: parseInt(process.env.BULL_FLAG_BSC_MIN_TOKEN_AGE_DAYS || '30', 10),
        },
        base: {
          min24hVolumeUsd: parseFloat(process.env.BULL_FLAG_BASE_MIN_24H_VOLUME_USD || '10000000'),
        },
      },
    },
  },

  dashboard: {
    bindHost: process.env.DASHBOARD_BIND_HOST || '127.0.0.1',
    adminToken: process.env.DASHBOARD_ADMIN_TOKEN || '',
  },

  webhooks: {
    tradingViewEnabled: process.env.TRADINGVIEW_WEBHOOK_ENABLED === 'true',
    tradingViewSecret: process.env.TRADINGVIEW_WEBHOOK_SECRET || '',
    tradingViewMaxAgeMs: parseInt(process.env.TRADINGVIEW_WEBHOOK_MAX_AGE_MS || '21600000', 10) || 21600000,
  },

  research: {
    scheduledEnabled: process.env.RESEARCH_SCHEDULED_ENABLED !== 'false',
    nightlyHourUtc: parseInt(process.env.RESEARCH_NIGHTLY_HOUR_UTC || '2', 10),
    nightlyMinuteUtc: parseInt(process.env.RESEARCH_NIGHTLY_MINUTE_UTC || '15', 10),
    nightlyMaxTargets: parseInt(process.env.RESEARCH_NIGHTLY_MAX_TARGETS || '3', 10) || 3,
    jobsListLimit: parseInt(process.env.RESEARCH_JOBS_LIST_LIMIT || '12', 10) || 12,
    targetHistoryBars: parseInt(process.env.RESEARCH_TARGET_HISTORY_BARS || '240', 10) || 240,
    minHistoryBars: parseInt(process.env.RESEARCH_MIN_HISTORY_BARS || '120', 10) || 120,
  },

  ml: {
    enabled: process.env.ML_ENABLED !== 'false',
    directInferenceEnabled: process.env.ML_DIRECT_INFERENCE_ENABLED !== 'false',
    featureMinBars: parseInt(process.env.ML_FEATURE_MIN_BARS || '60', 10),
    directBuyThreshold: parseFloat(process.env.ML_DIRECT_BUY_THRESHOLD || '0.68'),
    directSellThreshold: parseFloat(process.env.ML_DIRECT_SELL_THRESHOLD || '0.32'),
    vetoThreshold: parseFloat(process.env.ML_VETO_THRESHOLD || '0.42'),
  },

  externalModels: {
    enabled: process.env.EXTERNAL_MODELS_ENABLED !== 'false',
    failOpen: process.env.EXTERNAL_MODELS_FAIL_OPEN !== 'false',
    artifactRoot: process.env.EXTERNAL_MODELS_ARTIFACT_ROOT || 'artifacts',
  },

  pythonSidecar: {
    enabled: process.env.PYTHON_SIDECAR_ENABLED !== 'false',
    pythonBin: process.env.PYTHON_SIDECAR_BIN || 'python',
    scriptPath: process.env.PYTHON_SIDECAR_SCRIPT || 'scripts/python_model_sidecar.py',
    timeoutMs: parseInt(process.env.PYTHON_SIDECAR_TIMEOUT_MS || '12000', 10),
  },

  sentimentEngine: {
    enabled: process.env.SENTIMENT_ENGINE_ENABLED !== 'false',
    minConfidence: parseFloat(process.env.SENTIMENT_ENGINE_MIN_CONFIDENCE || '0.35'),
    cacheSeconds: parseInt(process.env.SENTIMENT_ENGINE_CACHE_SECONDS || '120', 10),
  },

  xSentiment: {
    enabled: process.env.X_SENTIMENT_ENABLED !== 'false',
    bearerToken: process.env.X_BEARER_TOKEN || '',
    baseUrl: process.env.X_API_BASE_URL || 'https://api.x.com/2',
    maxPosts: parseInt(process.env.X_SENTIMENT_MAX_POSTS || '12', 10),
  },

  rl: {
    enabled: process.env.RL_ENABLED !== 'false',
    liveInferenceEnabled: process.env.RL_LIVE_INFERENCE_ENABLED !== 'false',
    paperTrainingEnabled: process.env.RL_PAPER_TRAINING_ENABLED !== 'false',
    trainingIntervalMinutes: parseInt(process.env.RL_TRAINING_INTERVAL_MINUTES || '45', 10),
    trainingSeriesLimit: parseInt(process.env.RL_TRAINING_SERIES_LIMIT || '12', 10),
    trainingEpisodes: parseInt(process.env.RL_TRAINING_EPISODES || '24', 10),
    directBuyThreshold: parseFloat(process.env.RL_DIRECT_BUY_THRESHOLD || '0.72'),
    directSellThreshold: parseFloat(process.env.RL_DIRECT_SELL_THRESHOLD || '0.28'),
    productionPolicyEngine: process.env.RL_PRODUCTION_POLICY_ENGINE || 'native',
    sb3Algorithm: process.env.RL_SB3_ALGORITHM || 'PPO',
    rllibAlgorithm: process.env.RL_RLLIB_ALGORITHM || 'PPO',
  },

  hybridAgent: {
    enabled: process.env.HYBRID_AGENT_ENABLED !== 'false',
    allowDirectEntryFromHybrid: process.env.HYBRID_AGENT_ALLOW_DIRECT_ENTRY !== 'false',
    allowVetoFromHybrid: process.env.HYBRID_AGENT_ALLOW_VETO !== 'false',
    minConfidence: parseFloat(process.env.HYBRID_AGENT_MIN_CONFIDENCE || '0.28'),
    specialistFrameworkEnabled: process.env.HYBRID_AGENT_SPECIALISTS_ENABLED !== 'false',
    adaptiveRoutingEnabled: process.env.HYBRID_AGENT_ADAPTIVE_ROUTING !== 'false',
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
  tradingWindowsEnabled: process.env.TRADING_WINDOWS_ENABLED === 'true',



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

  backtest: {
    // Walk-forward testing splits (training/validation/test)
    walkForwardTrainPct: parseFloat(process.env.BACKTEST_WALK_FORWARD_TRAIN_PCT || '0.7'),
    walkForwardValidatePct: parseFloat(process.env.BACKTEST_WALK_FORWARD_VALIDATE_PCT || '0.15'),
    
    // Regime classification window size (bars)
    regimeWindowBars: parseInt(process.env.BACKTEST_REGIME_WINDOW_BARS || '20', 10),
    
    // Monte Carlo simulation settings
    monteCarloRuns: parseInt(process.env.BACKTEST_MONTE_CARLO_RUNS || '2000', 10),
    monteCarloMethod: process.env.BACKTEST_MONTE_CARLO_METHOD || 'regime_aware', // regime_aware | i.i.d
    monteCarloRuinThresholdPct: parseFloat(process.env.BACKTEST_MONTE_CARLO_RUIN_THRESHOLD_PCT || '15'),
    
    // Default backtest mode (standard | walk_forward | regime | regime_aware)
    defaultMode: process.env.BACKTEST_DEFAULT_MODE || 'standard',
    
    // Enable overfitting detection (compares train vs test returns)
    overfittingDetectionEnabled: process.env.BACKTEST_OVERFITTING_DETECTION !== 'false',
    overfitSuspicionThreshold: parseFloat(process.env.BACKTEST_OVERFIT_SUSPICION_THRESHOLD || '0.3'), // test < 30% of train
  },

  execution: {
    // Realistic round-trip fees applied to PnL so reported metrics match reality.
    // Bps = basis points (1 bps = 0.01%). Defaults reflect taker fees on each venue.
    feeProfile: {
      kucoin:   { entryBps: parseInt(process.env.KUCOIN_ENTRY_BPS || '10', 10), exitBps: parseInt(process.env.KUCOIN_EXIT_BPS || '10', 10) },
      bsc:      { entryBps: parseInt(process.env.BSC_ENTRY_BPS || '25', 10),    exitBps: parseInt(process.env.BSC_EXIT_BPS || '25', 10) },
      base:     { entryBps: parseInt(process.env.BASE_ENTRY_BPS || '20', 10),   exitBps: parseInt(process.env.BASE_EXIT_BPS || '20', 10) },
      solana:   { entryBps: parseInt(process.env.SOL_ENTRY_BPS || '15', 10),    exitBps: parseInt(process.env.SOL_EXIT_BPS || '15', 10) },
      default:  { entryBps: parseInt(process.env.DEFAULT_ENTRY_BPS || '20', 10), exitBps: parseInt(process.env.DEFAULT_EXIT_BPS || '20', 10) },
    },
    slippageBps: parseInt(process.env.SLIPPAGE_BPS) || 100,
    maxRetries: parseInt(process.env.EXECUTION_MAX_RETRIES) || 3,
    retryDelayMs: parseInt(process.env.EXECUTION_RETRY_DELAY_MS) || 1200,
    buyTimeoutMs: parseInt(process.env.EXECUTION_BUY_TIMEOUT_MS) || 30000,
    solanaPriorityFeeLamports: parseInt(process.env.SOLANA_PRIORITY_FEE_LAMPORTS) || 50000,
    requiredConfirmationsBsc: parseInt(process.env.REQUIRED_CONFIRMATIONS_BSC || '2', 10),
    requiredConfirmationsBase: parseInt(process.env.REQUIRED_CONFIRMATIONS_BASE || '2', 10),
    bscPrivateTxRpcUrl: process.env.BSC_PRIVATE_TX_RPC_URL || '',
    bscMevBlockerUrl: process.env.BSC_MEV_BLOCKER_URL || 'https://bscrpc.pancakeswap.finance',
    bscFlashbotsUrl: process.env.BSC_FLASHBOTS_URL || 'https://bsc-flashbots.rpc.builder.io/',
    bscMaxGasCostPctOfTrade: parseFloat(process.env.BSC_MAX_GAS_COST_PCT_OF_TRADE || '2'),
    bscMaxGasPriceGwei: parseFloat(process.env.BSC_MAX_GAS_PRICE_GWEI || '10'),
    bscSlippageBps: parseInt(process.env.BSC_SLIPPAGE_BPS || '200'),
    bscRequireTaxData: process.env.BSC_REQUIRE_TAX_DATA !== 'false',
    bscMaxBuyTaxPct: parseFloat(process.env.BSC_MAX_BUY_TAX_PCT || '5'),
    bscMaxSellTaxPct: parseFloat(process.env.BSC_MAX_SELL_TAX_PCT || '5'),
    bscMinFillPctOfExpected: parseFloat(process.env.BSC_MIN_FILL_PCT_OF_EXPECTED || '97'),
    mevGuardEnabled: process.env.MEV_GUARD_ENABLED !== 'false',
    requirePrivateTxForBsc: process.env.REQUIRE_PRIVATE_TX_FOR_BSC !== 'false',
    aiNonBlocking: process.env.AI_NON_BLOCKING !== 'false',
    momentumAiNonBlocking: process.env.MOMENTUM_AI_NON_BLOCKING !== 'false',
    momentumAiMaxLatencyMs: parseInt(process.env.MOMENTUM_AI_MAX_LATENCY_MS || '700', 10),
    allowTechnicalFallbackOnAiFailure: process.env.ALLOW_TECHNICAL_FALLBACK_ON_AI_FAILURE !== 'false',
    kucoinPendingAiAdvisory: process.env.KUCOIN_PENDING_AI_ADVISORY === 'true',
    kucoinPendingAiMinConfirmations: parseInt(
      process.env.KUCOIN_PENDING_AI_MIN_CONFIRMATIONS || process.env.AI_UNAVAILABLE_MIN_CONFIRMATIONS || '2',
      10
    ) || 2,
    heatAwareMomentumRotationEnabled: process.env.HEAT_AWARE_MOMENTUM_ROTATION_ENABLED !== 'false',
    momentumRotationHistoryLimit: parseInt(process.env.MOMENTUM_ROTATION_HISTORY_LIMIT || '5', 10),
    momentumRotationPersistenceScans: parseInt(process.env.MOMENTUM_ROTATION_PERSISTENCE_SCANS || '2', 10),
    momentumRotationMinAccelerationScore: parseFloat(process.env.MOMENTUM_ROTATION_MIN_ACCELERATION_SCORE || '2'),
    momentumRotationHealthyPnlPct: parseFloat(process.env.MOMENTUM_ROTATION_HEALTHY_PNL_PCT || '2'),
    momentumRotationExtendedMovePct: parseFloat(process.env.MOMENTUM_ROTATION_EXTENDED_MOVE_PCT || '30'),
    failClosedOnIncompleteFill: process.env.FAIL_CLOSED_ON_INCOMPLETE_FILL !== 'false',
    mevGuardMinLiquidityUsd: parseFloat(process.env.MEV_GUARD_MIN_LIQUIDITY_USD || '150000'),
    solanaOnlyDirectRoutes: process.env.SOLANA_ONLY_DIRECT_ROUTES === 'true',
    solanaMaxPriceImpactPct: parseFloat(process.env.SOLANA_MAX_PRICE_IMPACT_PCT) || 5,
    solanaMaxRealizedVsQuotedSlippagePct: parseFloat(process.env.SOLANA_MAX_REALIZED_VS_QUOTED_SLIPPAGE_PCT || '1.5'),
    kucoinMomentumUseMarketBuy: process.env.KUCOIN_MOMENTUM_USE_MARKET_BUY !== 'false',
    kucoinMaxSlippagePct: parseFloat(process.env.KUCOIN_MAX_SLIPPAGE_PCT) || 1.2,
  },

  antiPattern: {
    positionSizeJitterPct: parseFloat(process.env.ANTI_PATTERN_POSITION_JITTER_PCT || '15'),
    enablePositionJitter: process.env.ANTI_PATTERN_ENABLE_POSITION_JITTER !== 'false',
    enableEntryDelay: process.env.ANTI_PATTERN_ENABLE_ENTRY_DELAY !== 'false',
    maxEntryDelayMs: parseInt(process.env.ANTI_PATTERN_MAX_ENTRY_DELAY_MS || '3000', 10),
    enableSolanaSplits: process.env.ANTI_PATTERN_ENABLE_SOLANA_SPLITS !== 'false',
    solanaSplitThresholdUsd: parseFloat(process.env.ANTI_PATTERN_SOLANA_SPLIT_THRESHOLD_USD || '2000'),
  },

  selfEvolution: {
    enabled: isPaperTrading
      ? process.env.SELF_EVOLUTION_ENABLED !== 'false'
      : process.env.SELF_EVOLUTION_ENABLED === 'true' && process.env.SELF_EVOLUTION_ALLOW_LIVE_MUTATION === 'true',
    autoApply: process.env.SELF_EVOLUTION_AUTO_APPLY !== 'false',
    allowLiveApply: isPaperTrading ? true : process.env.SELF_EVOLUTION_ALLOW_LIVE_APPLY === 'true',
    autoRestart: process.env.SELF_EVOLUTION_AUTO_RESTART !== 'false',
    // Paper-only: after applying changes, automatically promote them to the main bot.
    // Set SELF_EVOLUTION_AUTO_PROMOTE=false to disable and keep promotion manual.
    autoPromote: process.env.SELF_EVOLUTION_AUTO_PROMOTE !== 'false',
    intervalMinutes: parseInt(process.env.SELF_EVOLUTION_INTERVAL_MINUTES || '60', 10),
    minClosedTrades: parseInt(process.env.SELF_EVOLUTION_MIN_CLOSED_TRADES || '12', 10),
    // Holdout window in hours before a patch's outcome is validated and recorded.
    // Each applied patch is queued and only judged after this much trading has elapsed.
    validationHoldoutHours: parseInt(process.env.SELF_EVOLUTION_VALIDATION_HOLDOUT_HOURS || '24', 10),
    governance: {
      minObservationMinutes: parseInt(process.env.SELF_EVOLUTION_MIN_OBSERVATION_MINUTES || '45', 10),
      minClosedTrades: parseInt(process.env.SELF_EVOLUTION_GOV_MIN_CLOSED_TRADES || '3', 10),
      minShadowClosedTrades: parseInt(process.env.SELF_EVOLUTION_MIN_SHADOW_CLOSED_TRADES || '5', 10),
      promoteMinProfitFactorDelta: parseFloat(process.env.SELF_EVOLUTION_PROMOTE_MIN_PF_DELTA || '0'),
      promoteMinWinRateDeltaPct: parseFloat(process.env.SELF_EVOLUTION_PROMOTE_MIN_WINRATE_DELTA_PCT || '0'),
      maxDrawdownDeltaPct: parseFloat(process.env.SELF_EVOLUTION_MAX_DRAWDOWN_DELTA_PCT || '3'),
      rollbackMaxProfitFactorDrop: parseFloat(process.env.SELF_EVOLUTION_ROLLBACK_MAX_PF_DROP || '0.2'),
      rollbackMaxWinRateDropPct: parseFloat(process.env.SELF_EVOLUTION_ROLLBACK_MAX_WINRATE_DROP_PCT || '8'),
      rollbackOnUnhealthy: process.env.SELF_EVOLUTION_ROLLBACK_ON_UNHEALTHY !== 'false',
      maxPromotionFiles: parseInt(process.env.SELF_EVOLUTION_MAX_PROMOTION_FILES || '6', 10),
      promotionCooldownMinutes: parseInt(process.env.SELF_EVOLUTION_PROMOTION_COOLDOWN_MINUTES || '120', 10),
      liveRollbackObservationMinutes: parseInt(process.env.SELF_EVOLUTION_LIVE_ROLLBACK_OBSERVATION_MINUTES || '90', 10),
      maxFalsePositiveRateDeltaPct: parseFloat(process.env.SELF_EVOLUTION_MAX_FALSE_POSITIVE_DELTA_PCT || '6'),
      maxFillSlippageDeltaPct: parseFloat(process.env.SELF_EVOLUTION_MAX_FILL_SLIPPAGE_DELTA_PCT || '0.75'),
      maxFillDiscrepancyDeltaPct: parseFloat(process.env.SELF_EVOLUTION_MAX_FILL_DISCREPANCY_DELTA_PCT || '2'),
      maxPaperLiveDiscrepancyScore: parseFloat(process.env.SELF_EVOLUTION_MAX_PAPER_LIVE_DISCREPANCY_SCORE || '35'),
      minPromotionConfidence: parseFloat(process.env.SELF_EVOLUTION_MIN_PROMOTION_CONFIDENCE || '60'),
      requireManualApprovalForHighImpact: process.env.SELF_EVOLUTION_REQUIRE_MANUAL_APPROVAL_FOR_HIGH_IMPACT !== 'false',
      shadowModeRequired: process.env.SELF_EVOLUTION_SHADOW_MODE_REQUIRED !== 'false',
      canaryLiveSizePct: parseFloat(process.env.SELF_EVOLUTION_CANARY_LIVE_SIZE_PCT || '10'),
    },
  },

  // Recovery mode: autonomous tightening when the bot is in a losing hole
  recovery: {
    enabled: process.env.RECOVERY_MODE_ENABLED !== 'false',
    // Minimum closed trades before recovery mode can activate
    minClosedTrades: parseInt(process.env.RECOVERY_MIN_CLOSED_TRADES || '8', 10),
    // Thresholds that trigger each severity level (profit factor)
    deepProfitFactorThreshold: parseFloat(process.env.RECOVERY_DEEP_PF_THRESHOLD || '0.25'),
    moderateProfitFactorThreshold: parseFloat(process.env.RECOVERY_MODERATE_PF_THRESHOLD || '0.55'),
    lightProfitFactorThreshold: parseFloat(process.env.RECOVERY_LIGHT_PF_THRESHOLD || '0.85'),
    // Win-rate floor (below this also triggers)
    deepWinRateThreshold: parseFloat(process.env.RECOVERY_DEEP_WR_THRESHOLD || '28'),
    moderateWinRateThreshold: parseFloat(process.env.RECOVERY_MODERATE_WR_THRESHOLD || '38'),
    // Position-size multipliers for each severity
    deepSizeMultiplier: parseFloat(process.env.RECOVERY_DEEP_SIZE_MULT || '0.30'),
    moderateSizeMultiplier: parseFloat(process.env.RECOVERY_MODERATE_SIZE_MULT || '0.50'),
    lightSizeMultiplier: parseFloat(process.env.RECOVERY_LIGHT_SIZE_MULT || '0.70'),
    // Volume-spike multiplier boost during recovery (applied on top of strategy threshold)
    deepVolumeSpikeBoost: parseFloat(process.env.RECOVERY_DEEP_VOL_SPIKE_BOOST || '2.0'),
    moderateVolumeSpikeBoost: parseFloat(process.env.RECOVERY_MODERATE_VOL_SPIKE_BOOST || '1.5'),
    lightVolumeSpikeBoost: parseFloat(process.env.RECOVERY_LIGHT_VOL_SPIKE_BOOST || '1.2'),
    // Consecutive wins needed to exit recovery one level
    winsToEscapeDeep: parseInt(process.env.RECOVERY_WINS_ESCAPE_DEEP || '3', 10),
    winsToEscapeModerate: parseInt(process.env.RECOVERY_WINS_ESCAPE_MODERATE || '2', 10),
    winsToEscapeLight: parseInt(process.env.RECOVERY_WINS_ESCAPE_LIGHT || '2', 10),
  },

  // Extracted from src/scoring/momentum-rotation.js (was inline magic numbers).
  scoring: {
    momentumRotation: {
      priceChange24hWeight:           parseFloat(process.env.SCORING_MR_PRICE_CHANGE_WEIGHT           || '0.8'),
      buyRatioOverFiftyWeight:        parseFloat(process.env.SCORING_MR_BUY_RATIO_WEIGHT             || '1.1'),
      volumeSpikeWeight:              parseFloat(process.env.SCORING_MR_VOLUME_SPIKE_WEIGHT          || '6'),
      netBuyFlowLogWeight:            parseFloat(process.env.SCORING_MR_NET_BUY_FLOW_LOG_WEIGHT      || '5'),
      confidenceWeight:               parseFloat(process.env.SCORING_MR_CONFIDENCE_WEIGHT            || '0.2'),
      accelerationWeight:             parseFloat(process.env.SCORING_MR_ACCELERATION_WEIGHT          || '1.2'),
      consecutiveStrongScansWeight:   parseFloat(process.env.SCORING_MR_CONSECUTIVE_STRONG_WEIGHT    || '6'),
      extendedMovePenalty:            parseFloat(process.env.SCORING_MR_EXTENDED_MOVE_PENALTY        || '-12'),
    },
  },

  // Extracted from src/strategy-brain.js getAdaptiveParameters (was inline magic numbers).
  strategyBrain: {
    bounds: {
      rsiBuyMin:                       parseFloat(process.env.BRAIN_BOUNDS_RSI_BUY_MIN                 || '20'),
      rsiBuyMax:                       parseFloat(process.env.BRAIN_BOUNDS_RSI_BUY_MAX                 || '70'),
      rsiBuyMaxAbsoluteCeiling:        parseFloat(process.env.BRAIN_BOUNDS_RSI_BUY_MAX_CEILING         || '90'),
      rsiBuyMaxMinSpread:              parseFloat(process.env.BRAIN_BOUNDS_RSI_BUY_MAX_MIN_SPREAD      || '5'),
      volumeSpikeMin:                  parseFloat(process.env.BRAIN_BOUNDS_VOLUME_SPIKE_MIN            || '1.1'),
      volumeSpikeMax:                  parseFloat(process.env.BRAIN_BOUNDS_VOLUME_SPIKE_MAX            || '4'),
      minPriceChange24hPctAllMax:      parseFloat(process.env.BRAIN_BOUNDS_MIN_PC24_MAX                || '25'),
      maxPriceChange24hPctAllFloor:    parseFloat(process.env.BRAIN_BOUNDS_MAX_PC24_FLOOR              || '20'),
      maxPriceChange24hPctAllCeiling:  parseFloat(process.env.BRAIN_BOUNDS_MAX_PC24_CEILING            || '160'),
    },
  },
};

module.exports = config;
