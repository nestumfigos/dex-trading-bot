'use strict';
/**
 * JUPITER (Solana) Exchange Adapter
 * Uses Jupiter Aggregator API v6 for best-price routing across all Solana DEXes.
 */
const { Connection, Keypair, PublicKey, VersionedTransaction } = require('@solana/web3.js');
const axios = require('axios');
const bs58 = require('bs58');
const config = require('../../config');
const logger = require('../utils/logger');
const dexscreenerClient = require('../utils/dexscreener-client');

/**
 * Bug 7 — age-adaptive cache TTL for token data.
 * Tokens < 6h old: 15s (configurable via MOMENTUM_TOKEN_CACHE_TTL_MS)
 * Tokens 6–24h old: 30s (configurable via NEW_TOKEN_CACHE_TTL_MS)
 * Older tokens: falls back to BIRDEYE_CACHE_TTL_MS (default 60s)
 */
function tokenDataCacheTtl(listingAgeDays) {
  const ageHours = Number(listingAgeDays || 0) * 24;
  if (ageHours < 6) return Math.round(Number(config.birdeye?.momentumTokenCacheTtlMs ?? 15_000) / 1000);
  if (ageHours < 24) return Math.round(Number(config.birdeye?.newTokenCacheTtlMs ?? 30_000) / 1000);
  return Math.round(Number(config.birdeye?.cacheTtlMs ?? 60_000) / 1000);
}

function withTimeoutValue(promise, timeoutMs, fallback = null) {
  const ms = Math.max(1, Number(timeoutMs) || 1);
  return Promise.race([
    Promise.resolve(promise).catch(() => fallback),
    new Promise((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

const { getTokenMetrics } = require('../utils/coingecko');
const { getNativeAssetPrice } = require('../utils/market-data');
const { getTokenHolders, getTokenInfo } = require('../utils/onchain/solscan');
const { getTokenTVL } = require('../utils/onchain/defillama');

const JUPITER_QUOTE_API = 'https://quote-api.jup.ag/v6';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const DISCOVERY_FEEDS = [
  'https://api.dexscreener.com/token-profiles/latest/v1',
  'https://api.dexscreener.com/token-boosts/latest/v1',
  'https://api.dexscreener.com/token-boosts/top/v1',
];

class JupiterExchange {
  constructor(cache) {
    this.connection = new Connection(config.solana.rpcUrl, 'confirmed');
    this.wallet = config.solana.privateKey
      ? Keypair.fromSecretKey(bs58.decode(config.solana.privateKey))
      : null;
    this.name = 'Jupiter (Solana)';
    this.cache = cache;
    this._birdeyeCooldownUntil = 0; // rate-limit backoff tracker
    this._mintDecimalsCache = new Map();
    this._birdeyeWindowStartedAt = Date.now();
    this._birdeyeRequestCount = 0;
    this._newTokensCache = { tokens: [], fetchedAt: 0 };
    this._dexscreenerTokensCache = { tokens: [], fetchedAt: 0 };
    this._solPriceCache = {
      value: null,
      expiresAt: 0,
    };
    // 2026-05-23: cache + cooldown so public Solana RPC 429/network errors don't
    // flood logs every minute. Returns last-good balance during cooldown.
    this._balanceCache = { value: 0, expiresAt: 0 };
    this._balanceErrorCooldownUntil = 0;
    this._balanceErrorLoggedAt = 0;
  }

  refreshBirdeyeWindowIfNeeded() {
    const now = Date.now();
    if (now - this._birdeyeWindowStartedAt >= 60_000) {
      this._birdeyeWindowStartedAt = now;
      this._birdeyeRequestCount = 0;
    }
  }

  consumeBirdeyeQuota() {
    this.refreshBirdeyeWindowIfNeeded();
    const rpmLimit = Math.max(1, Number(config.birdeye?.rpmLimit || 30));
    if (this._birdeyeRequestCount >= rpmLimit) {
      return false;
    }
    this._birdeyeRequestCount += 1;
    return true;
  }

  getCachedNewTokens() {
    const ttlMs = Math.max(5_000, Number(config.birdeye?.cacheTtlMs || 60_000));
    const fresh = Date.now() - Number(this._newTokensCache.fetchedAt || 0) <= ttlMs;
    if (!fresh) return [];
    return Array.isArray(this._newTokensCache.tokens) ? this._newTokensCache.tokens : [];
  }

  getCachedDexScreenerTokens() {
    const ttlMs = Math.max(5_000, Number(config.birdeye?.dexscreenerCacheTtlMs || 90_000));
    const fresh = Date.now() - Number(this._dexscreenerTokensCache.fetchedAt || 0) <= ttlMs;
    if (!fresh) return [];
    return Array.isArray(this._dexscreenerTokensCache.tokens) ? this._dexscreenerTokensCache.tokens : [];
  }

  async fetchDexScreenerFallbackTokens() {
    const cached = this.getCachedDexScreenerTokens();
    if (cached.length > 0) return cached;

    try {
      const response = await axios.get('https://api.dexscreener.com/latest/dex/tokens/solana', { timeout: 10000 });
      const rows = Array.isArray(response.data)
        ? response.data
        : (Array.isArray(response.data?.pairs) ? response.data.pairs : []);
      const addresses = new Set();
      rows.forEach((row) => {
        const address = String(row?.tokenAddress || row?.address || row?.baseToken?.address || '').trim();
        if (!address) return;
        addresses.add(address);
      });

      const tokens = Array.from(addresses);
      this._dexscreenerTokensCache = {
        tokens,
        fetchedAt: Date.now(),
      };
      return tokens;
    } catch (error) {
      logger.debug(`Jupiter DexScreener fallback failed: ${error.message}`);
      return [];
    }
  }

  async initialize() {
    // Jupiter doesn't need explicit initialization beyond constructor
    logger.info('Jupiter (Solana) initialized');
  }

  async getTokenPrice(mintAddress) {
    try {
      const res = await axios.get(`${JUPITER_QUOTE_API}/quote`, {
        params: {
          inputMint: USDC_MINT,
          outputMint: mintAddress,
          amount: 1_000_000,
          slippageBps: 50,
        },
        timeout: 10000,
      });
      return 1 / (parseInt(res.data.outAmount, 10) / 1e9);
    } catch (err) {
      logger.error(`Jupiter getTokenPrice failed for ${mintAddress}: ${err.message}`);
      return null;
    }
  }

  async getTokenData(mintAddress) {
    const cacheKey = `token:${mintAddress}`;
    const cached = await this.cache.get(cacheKey);
    if (cached) return cached;

    try {
      const requests = [
        dexscreenerClient.throttledFetch(
          `https://api.dexscreener.com/latest/dex/tokens/${mintAddress}`,
          {
            timeoutMs: Math.max(1000, Number(config.risk?.dexscreenerTokenLookupTimeoutMs || 5000)),
            cacheTtlMs: Math.max(1000, Number(config.risk?.dexscreenerTokenCacheTtlMs || 60_000)),
          }
        ),
      ];
      const birdeyeOnCooldown = Date.now() < this._birdeyeCooldownUntil;
      if (config.birdeye.apiKey && !birdeyeOnCooldown && this.consumeBirdeyeQuota()) {
        requests.push(
          axios.get(`https://public-api.birdeye.so/defi/token_overview?address=${mintAddress}`, {
            headers: {
              'X-API-KEY': config.birdeye.apiKey,
              'x-chain': 'solana',
              'accept': 'application/json',
            },
            timeout: 10000,
          })
        );
      } else if (config.birdeye.apiKey && !birdeyeOnCooldown) {
        logger.debug('Birdeye token_overview skipped due to RPM cap', {
          mintAddress,
          limit: Number(config.birdeye?.rpmLimit || 30),
        });
      }

      // All external calls wrapped in allSettled so one failure can't crash the whole lookup
      const onchainTimeoutMs = Math.max(250, Number(config.risk?.solanaOptionalMetricsTimeoutMs || 1200));
      const [responses, onchainResults] = await Promise.all([
        Promise.allSettled(requests),
        withTimeoutValue(Promise.allSettled([
          getTokenHolders(mintAddress, 10),
          getTokenInfo(mintAddress),
        ]), onchainTimeoutMs, []),
      ]);

      const pairs = responses[0].status === 'fulfilled' ? responses[0].value?.pairs || [] : [];
      const dexPair = pairs.find((pair) => pair.chainId === 'solana') || pairs[0] || null;

      // Handle Birdeye result — 404/400 expected for fresh tokens or rate-limits
      let birdeye = null;
      if (responses[1]) {
        if (responses[1].status === 'fulfilled') {
          birdeye = responses[1].value.data?.data || null;
        } else {
          const birdeyeStatus = responses[1].reason?.response?.status;
          if (birdeyeStatus === 400) {
            // CU rate-limit — back off for 60s
            this._birdeyeCooldownUntil = Date.now() + 60_000;
            logger.debug(`Birdeye rate-limited on ${mintAddress}, cooling down 60s`);
          } else if (birdeyeStatus !== 404) {
            // Only log unexpected statuses
            logger.debug(`Birdeye token_overview ${mintAddress} returned ${birdeyeStatus || 'network error'}`);
          }
        }
      }

      if (!dexPair && !birdeye) {
        return null;
      }

      // Extract onchain results (all allSettled, so always safe)
      const holders = onchainResults[0]?.status === 'fulfilled' ? onchainResults[0].value : null;
      const tokenInfo = onchainResults[1]?.status === 'fulfilled' ? onchainResults[1].value : null;

      const listingAgeDays = dexPair?.pairCreatedAt ? (Date.now() - dexPair.pairCreatedAt) / 86400000 : 30;
      let tvl = null;
      const shouldTryDefiLlama = config.filters?.defillama?.enabled !== false && listingAgeDays >= 1;
      if (shouldTryDefiLlama) {
        const tvlTimeoutMs = Math.max(400, Number(config.risk?.defillamaLookupTimeoutMs || 1200));
        tvl = await Promise.race([
          getTokenTVL(mintAddress, 'solana').catch(() => null),
          new Promise((resolve) => setTimeout(() => resolve(null), tvlTimeoutMs)),
        ]).catch(() => null);
      }

      // Whale tracking: % held by top 10 holders
      let topHoldersPct = 0;
      if (Array.isArray(holders) && holders.length > 0 && tokenInfo?.supply) {
        const total = Number(tokenInfo.supply);
        const topSum = holders.slice(0, 10).reduce((sum, h) => sum + Number(h.amount || 0), 0);
        topHoldersPct = total > 0 ? (topSum / total) * 100 : 0;
      }

      const metricsTimeoutMs = Math.max(250, Number(config.risk?.tokenMetricsLookupTimeoutMs || 1200));
      const metrics = await withTimeoutValue(getTokenMetrics(
        mintAddress,
        'solana',
        birdeye?.symbol || dexPair?.baseToken?.symbol,
        birdeye?.name || dexPair?.baseToken?.name
      ), metricsTimeoutMs, null);
      const result = {
        address: mintAddress,
        symbol: birdeye?.symbol || dexPair?.baseToken?.symbol || 'UNKNOWN',
        price: birdeye?.price || parseFloat(dexPair?.priceUsd || 0),
        liquidityUsd: birdeye?.liquidity || parseFloat(dexPair?.liquidity?.usd || 0),
        liquidityChange24hPct: Number(birdeye?.liquidityChange24hPercent || 0),
        volume24h: birdeye?.v24hUSD || parseFloat(dexPair?.volume?.h24 || 0),
        priceChange24h: birdeye?.priceChange24hPercent || parseFloat(dexPair?.priceChange?.h24 || 0),
        priceChange7d: Number(birdeye?.priceChange7dPercent || 0),
        buyTx10m: Number(birdeye?.buy10m || dexPair?.txns?.m5?.buys || 0),
        sellTx10m: Number(birdeye?.sell10m || dexPair?.txns?.m5?.sells || 0),
        buyTx1h: Number(birdeye?.buy1h || dexPair?.txns?.h1?.buys || 0),
        sellTx1h: Number(birdeye?.sell1h || dexPair?.txns?.h1?.sells || 0),
        txCountFirstHour: Number((birdeye?.buy1h || dexPair?.txns?.h1?.buys || 0) + (birdeye?.sell1h || dexPair?.txns?.h1?.sells || 0)),
        uniqueBuyers10m: Number(birdeye?.uniqueWalletBuy10m || birdeye?.uniqBuyer10m || 0),
        isHoneypot: false,
        topHoldersPct,
        holderCount: Number(tokenInfo?.holder || tokenInfo?.holderCount || 0),
        teamWalletUnlocked: false,
        listingAgeDays,
        listingDate: dexPair?.pairCreatedAt ? new Date(dexPair.pairCreatedAt).toISOString() : null,
        chain: 'Solana',
        pairAddress: dexPair?.pairAddress,
        sentimentUpPct: metrics?.sentimentUpPct || null,
        sentimentDownPct: metrics?.sentimentDownPct || null,
        communityScore: metrics?.communityScore || null,
        developerScore: metrics?.developerScore || null,
        publicInterestScore: metrics?.publicInterestScore || null,
        coingeckoId: metrics?.coingeckoId || null,
        listedOnCoinGecko: Boolean(metrics?.listedOnCoinGecko || metrics?.coingeckoId),
        listedOnCoinMarketCap: Boolean(metrics?.listedOnCoinMarketCap),
        tvl: tvl || null,
      };

      // Bug 7: use a shorter TTL for new/momentum tokens so stale data expires faster.
      await this.cache.set(cacheKey, result, tokenDataCacheTtl(result.listingAgeDays));
      return result;
    } catch (err) {
      logger.error(`Jupiter getTokenData failed for ${mintAddress}: ${err.message}`);
      return null;
    }
  }

  async getQuote(inputMint, outputMint, amountLamports, slippageBps = 100) {
    const res = await axios.get(`${JUPITER_QUOTE_API}/quote`, {
      params: {
        inputMint,
        outputMint,
        amount: amountLamports,
        slippageBps,
        onlyDirectRoutes: Boolean(config.execution.solanaOnlyDirectRoutes),
        restrictIntermediateTokens: true,
        asLegacyTransaction: false,
      },
      timeout: 15000,
    });
    return res.data;
  }

  async withRetry(label, fn) {
    const retries = Math.max(1, Number(config.execution.maxRetries || 3));
    const delayMs = Math.max(200, Number(config.execution.retryDelayMs || 1200));
    // B1.5 idempotency: track every broadcasted txid + its result across retries.
    // If a prior attempt's tx actually landed on-chain, never broadcast a second swap.
    const state = { broadcastedTxids: [] };
    // B3.exec.4: errors that are permanent (price-impact-too-high, token-blacklisted,
    // etc.) MUST not retry — each retry escalates slippage by 20bps and burns
    // toward the 2000bps cap on tokens that were never going to fill anyway.
    // Patterns matched against error.message to fail-fast.
    const PERMANENT_ERROR_PATTERNS = [
      /Price impact .* above limit/i,
      /Quote returned 0 out/i,
      /no route/i,
      /insufficient funds/i,
      /token .* blacklisted/i,
    ];

    for (let attempt = 1; attempt <= retries; attempt += 1) {
      try {
        if (state.broadcastedTxids.length > 0) {
          const landed = await this._findLandedTxid(state.broadcastedTxids);
          if (landed) {
            logger.warn(`${label}: prior attempt landed (${landed.txid}); skipping retry to avoid double-fill`);
            return landed.result;
          }
        }
        return await fn(attempt, state);
      } catch (error) {
        // B3.exec.4: fail-fast on permanent errors — don't retry into the
        // slippage cap on a token that the venue has already classified as
        // not-routable.
        if (PERMANENT_ERROR_PATTERNS.some((re) => re.test(String(error.message || '')))) {
          logger.warn(`${label} attempt ${attempt}/${retries}: PERMANENT error, aborting retries: ${error.message}`);
          throw error;
        }
        if (attempt >= retries) {
          if (state.broadcastedTxids.length > 0) {
            const landed = await this._findLandedTxid(state.broadcastedTxids);
            if (landed) {
              logger.warn(`${label}: final attempt errored but ${landed.txid} landed; returning that fill`);
              return landed.result;
            }
          }
          throw error;
        }
        logger.warn(`${label} attempt ${attempt}/${retries} failed: ${error.message}`);
        await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
      }
    }

    throw new Error(`${label} failed`);
  }

  async _findLandedTxid(broadcastedRecords) {
    if (!Array.isArray(broadcastedRecords) || broadcastedRecords.length === 0) return null;
    try {
      const txids = broadcastedRecords.map((r) => r.txid).filter(Boolean);
      if (!txids.length) return null;
      const statuses = await this.connection.getSignatureStatuses(txids, { searchTransactionHistory: true });
      if (!Array.isArray(statuses?.value)) return null;
      for (let i = 0; i < statuses.value.length; i += 1) {
        const status = statuses.value[i];
        if (status && !status.err && (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized')) {
          return broadcastedRecords[i];
        }
      }
    } catch (e) {
      logger.warn(`Jupiter idempotency landed-check failed: ${e?.message || e}`);
    }
    return null;
  }

  async getMintDecimals(mintAddress) {
    const key = String(mintAddress || '').trim();
    if (!key) return 6;
    if (this._mintDecimalsCache.has(key)) {
      return this._mintDecimalsCache.get(key);
    }

    let decimals = 6;
    try {
      const parsed = await this.connection.getParsedAccountInfo(new PublicKey(key), 'confirmed');
      const parsedDecimals = parsed?.value?.data?.parsed?.info?.decimals;
      if (Number.isFinite(Number(parsedDecimals))) {
        decimals = Number(parsedDecimals);
      }
    } catch (_) {
      // fall through to Solscan fallback
    }

    if (!Number.isFinite(decimals) || decimals < 0) {
      decimals = 6;
    }

    this._mintDecimalsCache.set(key, decimals);
    return decimals;
  }

  async toRawTokenAmount(tokenMint, tokenAmountUi) {
    const ui = Number(tokenAmountUi || 0);
    if (!Number.isFinite(ui) || ui <= 0) return 0;
    const decimals = await this.getMintDecimals(tokenMint);
    const raw = Math.floor(ui * (10 ** decimals));
    return Math.max(0, raw);
  }

  async executeSwapFromQuote(quote, slippageBps, sideLabel, state) {
    const priorityFeeLamports = Number(config.execution.solanaPriorityFeeLamports || 50000);

    const swapRes = await axios.post(`${JUPITER_QUOTE_API}/swap`, {
      quoteResponse: quote,
      userPublicKey: this.wallet.publicKey.toString(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: priorityFeeLamports,
    }, { timeout: 15000 });

    const swapTx = Buffer.from(swapRes.data.swapTransaction, 'base64');
    const tx = VersionedTransaction.deserialize(swapTx);
    tx.sign([this.wallet]);

    // Explicit simulation guard before broadcast; catches compute or account issues early.
    const sim = await this.connection.simulateTransaction(tx, {
      sigVerify: false,
      replaceRecentBlockhash: true,
      commitment: 'processed',
    });
    if (sim?.value?.err) {
      throw new Error(`${sideLabel} simulation failed: ${JSON.stringify(sim.value.err)}`);
    }

    const txid = await this.connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      maxRetries: Number(config.execution.maxRetries || 3),
    });

    // B1.5: register the broadcast BEFORE confirm so a timeout/throw on confirm
    // still leaves a trail withRetry can re-check before issuing another swap.
    const broadcastRecord = { txid, result: null };
    if (state && Array.isArray(state.broadcastedTxids)) {
      state.broadcastedTxids.push(broadcastRecord);
    }

    await this.connection.confirmTransaction(txid, 'confirmed');
    logger.info(
      `${sideLabel} confirmed: https://solscan.io/tx/${txid} ` +
      `(slippage=${slippageBps}bps, priorityFee=${priorityFeeLamports})`
    );

    const fill = await this.extractFillFromParsedTransaction(txid, quote).catch(() => ({}));
    const result = {
      txid,
      slippageBps,
      quotedPriceImpactPct: Number(quote?.priceImpactPct || 0) * 100,
      ...fill,
    };
    broadcastRecord.result = result;
    return result;
  }

  async extractFillFromParsedTransaction(txid, quote) {
    const walletAddress = this.wallet?.publicKey?.toString();
    if (!walletAddress) return { hasExchangeFilledData: false };

    let parsed = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      parsed = await this.connection.getParsedTransaction(txid, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      }).catch(() => null);
      if (parsed?.meta) break;
      await new Promise((resolve) => setTimeout(resolve, 350 * attempt));
    }
    if (!parsed?.meta) {
      return { hasExchangeFilledData: false };
    }

    const pre = Array.isArray(parsed.meta.preTokenBalances) ? parsed.meta.preTokenBalances : [];
    const post = Array.isArray(parsed.meta.postTokenBalances) ? parsed.meta.postTokenBalances : [];
    const inputMint = String(quote?.inputMint || '');
    const outputMint = String(quote?.outputMint || '');

    const sumMintByOwner = (rows, mint) => rows
      .filter((row) => String(row?.mint || '') === mint && String(row?.owner || '') === walletAddress)
      .reduce((sum, row) => {
        const amount = Number(row?.uiTokenAmount?.uiAmountString ?? row?.uiTokenAmount?.uiAmount ?? 0);
        return sum + (Number.isFinite(amount) ? amount : 0);
      }, 0);

    const findMintDecimals = (mint) => {
      const candidate = [...post, ...pre].find((row) => String(row?.mint || '') === mint);
      const decimals = Number(candidate?.uiTokenAmount?.decimals);
      return Number.isFinite(decimals) ? decimals : null;
    };

    const preIn = sumMintByOwner(pre, inputMint);
    const postIn = sumMintByOwner(post, inputMint);
    const preOut = sumMintByOwner(pre, outputMint);
    const postOut = sumMintByOwner(post, outputMint);

    const inputSpent = Math.max(0, preIn - postIn);
    const outputReceived = Math.max(0, postOut - preOut);
    let filledQuoteUsd = 0;
    let filledBaseQty = 0;

    if (inputMint === USDC_MINT) {
      filledQuoteUsd = inputSpent;
      filledBaseQty = outputReceived;
    } else if (outputMint === USDC_MINT) {
      filledQuoteUsd = outputReceived;
      filledBaseQty = inputSpent;
    }

    if (!(filledQuoteUsd > 0 && filledBaseQty > 0)) {
      return { hasExchangeFilledData: false };
    }

    const outDecimals = findMintDecimals(outputMint);
    const expectedOutRaw = Number(quote?.outAmount || 0);
    const expectedOutQty = Number.isFinite(outDecimals) && Number.isFinite(expectedOutRaw) && expectedOutRaw > 0
      ? (expectedOutRaw / (10 ** outDecimals))
      : 0;
    const realizedVsQuoteSlippagePct = expectedOutQty > 0
      ? ((expectedOutQty - filledBaseQty) / expectedOutQty) * 100
      : null;

    return {
      hasExchangeFilledData: true,
      filledQuoteUsd,
      filledBaseQty,
      executedPriceUsd: filledBaseQty > 0 ? (filledQuoteUsd / filledBaseQty) : null,
      realizedVsQuoteSlippagePct,
    };
  }

  async executeBuy(tokenMint, usdcAmount) {
    if (config.paperTrading) {
      logger.info(`[PAPER] Jupiter BUY ${tokenMint} with $${usdcAmount.toFixed(2)} USDC`);
      return { txid: `paper_tx_${Date.now()}`, simulated: true };
    }

    if (!this.wallet) throw new Error('Solana wallet not configured');

    try {
      return await this.withRetry('Jupiter BUY', async (attempt, state) => {
        const amountLamports = Math.floor(usdcAmount * 1_000_000);
        const slippageBps = Math.min(2000, Math.max(30, Number(config.execution.slippageBps || 100) + (attempt - 1) * 20));
        const quote = await this.getQuote(USDC_MINT, tokenMint, amountLamports, slippageBps);
        const priceImpactPct = Number(quote?.priceImpactPct || 0) * 100;
        if (priceImpactPct > Number(config.execution.solanaMaxPriceImpactPct || 5)) {
          throw new Error(`Price impact ${priceImpactPct.toFixed(2)}% above limit ${config.execution.solanaMaxPriceImpactPct}%`);
        }

        return this.executeSwapFromQuote(quote, slippageBps, 'Jupiter BUY', state);
      });
    } catch (err) {
      logger.error(`Jupiter BUY failed: ${err.message}`);
      throw err;
    }
  }

  async executeSell(tokenMint, tokenAmount) {
    if (config.paperTrading) {
      logger.info(`[PAPER] Jupiter SELL ${tokenAmount} of ${tokenMint}`);
      return { txid: `paper_tx_${Date.now()}`, simulated: true };
    }

    if (!this.wallet) throw new Error('Solana wallet not configured');

    try {
      return await this.withRetry('Jupiter SELL', async (attempt, state) => {
        const rawTokenAmount = await this.toRawTokenAmount(tokenMint, tokenAmount);
        if (!rawTokenAmount) {
          throw new Error(`Invalid token amount for Jupiter SELL: ${tokenAmount}`);
        }
        const slippageBps = Math.min(2000, Math.max(30, Number(config.execution.slippageBps || 100) + (attempt - 1) * 20));
        const quote = await this.getQuote(tokenMint, USDC_MINT, rawTokenAmount, slippageBps);
        const priceImpactPct = Number(quote?.priceImpactPct || 0) * 100;
        if (priceImpactPct > Number(config.execution.solanaMaxPriceImpactPct || 5)) {
          throw new Error(`Price impact ${priceImpactPct.toFixed(2)}% above limit ${config.execution.solanaMaxPriceImpactPct}%`);
        }

        return this.executeSwapFromQuote(quote, slippageBps, 'Jupiter SELL', state);
      });
    } catch (err) {
      logger.error(`Jupiter SELL failed: ${err.message}`);
      throw err;
    }
  }

  async getNewTokens() {
    const cachedTokens = this.getCachedNewTokens();
    if (Date.now() - Number(this._newTokensCache.fetchedAt || 0) <= Math.max(5_000, Number(config.birdeye?.cacheTtlMs || 60_000))
      && cachedTokens.length > 0) {
      return cachedTokens;
    }

    const addresses = new Set();
    const MIN_LIQUIDITY = Number(config.risk.minLiquidityUsd || 10000);
    const MIN_AGE_MS = 3 * 60 * 1000; // skip tokens younger than 3 minutes

    if (config.birdeye.apiKey) {
      const birdeyeHeaders = {
        'X-API-KEY': config.birdeye.apiKey,
        'x-chain': 'solana',
        'accept': 'application/json',
      };

      // Try the v2 new_listing endpoint; fall back without meme_platform_enabled if 400
      const endpoints = [
        'https://public-api.birdeye.so/defi/v2/tokens/new_listing?limit=50&meme_platform_enabled=true',
        'https://public-api.birdeye.so/defi/v2/tokens/new_listing?limit=50',
      ];

      // Skip Birdeye entirely if we're still in CU rate-limit cooldown
      if (Date.now() < this._birdeyeCooldownUntil) {
        logger.debug('Jupiter getNewTokens: Birdeye on cooldown, using cached results if available');
        return cachedTokens;
      }

      this.refreshBirdeyeWindowIfNeeded();
      const rpmLimit = Math.max(1, Number(config.birdeye?.rpmLimit || 30));
      if (this._birdeyeRequestCount >= rpmLimit) {
        logger.debug('Jupiter getNewTokens skipped: Birdeye RPM cap reached', {
          requestCount: this._birdeyeRequestCount,
          rpmLimit,
        });
        if (cachedTokens.length > 0) {
          return cachedTokens;
        }
        const fallbackTokens = await this.fetchDexScreenerFallbackTokens();
        if (fallbackTokens.length > 0) {
          return fallbackTokens;
        }
        logger.debug('Jupiter getNewTokens returning empty set after RPM cap with no cache and DexScreener miss');
        return [];
      } else {
        for (const url of endpoints) {
          if (!this.consumeBirdeyeQuota()) {
            logger.debug('Jupiter getNewTokens skipped mid-cycle: Birdeye RPM cap reached');
            if (cachedTokens.length > 0) {
              return cachedTokens;
            }
            const fallbackTokens = await this.fetchDexScreenerFallbackTokens();
            if (fallbackTokens.length > 0) {
              return fallbackTokens;
            }
            logger.debug('Jupiter getNewTokens returning empty set after mid-cycle RPM cap with no cache and DexScreener miss');
            return [];
          }

          try {
            const res = await axios.get(url, { headers: birdeyeHeaders, timeout: 10000 });
            const items = res.data?.data?.items || res.data?.data?.tokens || [];
            const now = Date.now();
            items.forEach((token) => {
              if (!token?.address) return;
              // Skip tokens with known low liquidity
              if (token.liquidity != null && Number(token.liquidity) < MIN_LIQUIDITY) return;
              // Skip ultra-fresh tokens (< 3 min old) — they won't be indexed yet
              if (token.createdAt && (now - new Date(token.createdAt).getTime()) < MIN_AGE_MS) return;
              addresses.add(token.address);
            });
            const freshTokens = Array.from(addresses);
            this._newTokensCache = { tokens: freshTokens, fetchedAt: Date.now() };
            break; // first successful endpoint wins
          } catch (err) {
            const status = err.response?.status;
            const body = err.response?.data ? JSON.stringify(err.response.data).slice(0, 200) : '';
            const isRateLimit = body.includes('limit exceeded') || body.includes('Compute units');
            if (status === 400 && body.includes('Compute units usage limit exceeded')) {
              logger.warn('Jupiter getNewTokens Birdeye compute unit limit reached', {
                reason: 'Compute units usage limit exceeded',
                status,
              });
              this._birdeyeCooldownUntil = Date.now() + 60_000;
              return cachedTokens;
            }
            logger.warn(`Jupiter getNewTokens Birdeye failed (${status || 'network'}): ${err.message}${body ? ' — ' + body : ''}`);
            if (isRateLimit) {
              // CU rate-limit — cool down 60s and use cached results only.
              this._birdeyeCooldownUntil = Date.now() + 60_000;
              return cachedTokens;
            }
            if (status !== 400) break; // only retry next endpoint on param 400
          }
        }
      }
    }

    // DexScreener fallback when Birdeye yields nothing
    if (addresses.size === 0) {
      await Promise.allSettled(
        DISCOVERY_FEEDS.map(async (url) => {
          const res = await axios.get(url, { timeout: 10000 });
          const items = Array.isArray(res.data) ? res.data : [];
          items
            .filter((item) => item.chainId === 'solana' && item.tokenAddress)
            .forEach((item) => addresses.add(item.tokenAddress));
        })
      );
    }

    const discovered = Array.from(addresses);
    this._newTokensCache = { tokens: discovered, fetchedAt: Date.now() };
    return discovered;
  }

  async getBalance() {
    if (!this.wallet) return 0;
    const now = Date.now();
    if (now < this._balanceErrorCooldownUntil) {
      return Number(this._balanceCache.value || 0);
    }
    if (Number.isFinite(this._balanceCache.value) && now < Number(this._balanceCache.expiresAt || 0)) {
      return Number(this._balanceCache.value);
    }
    try {
      const solBalance = await this.connection.getBalance(this.wallet.publicKey);
      const solPrice = await this.getSolPrice();
      const usd = (solBalance / 1e9) * solPrice;
      this._balanceCache = { value: usd, expiresAt: now + 60_000 };
      return usd;
    } catch (err) {
      const msg = String(err?.message || '');
      const transient = /429|Too Many Requests|fetch failed|ETIMEDOUT|ECONNRESET|ENOTFOUND|503|504/i.test(msg);
      if (transient) {
        this._balanceErrorCooldownUntil = now + 5 * 60_000;
        // Log once per cooldown window to avoid log flooding (was every 60s ERROR).
        if (now - this._balanceErrorLoggedAt > 5 * 60_000) {
          logger.warn(`Jupiter getBalance transient failure, cooling down 5m: ${msg.slice(0, 200)}`);
          this._balanceErrorLoggedAt = now;
        }
      } else {
        logger.error(`Jupiter getBalance failed: ${msg}`);
      }
      return Number(this._balanceCache.value || 0);
    }
  }

  async getWalletPositions() {
    return [];
  }

  async getSwingCandidates() {
    return [];
  }

  async getSolPrice() {
    const now = Date.now();
    if (Number.isFinite(this._solPriceCache.value) && now < Number(this._solPriceCache.expiresAt || 0)) {
      return Number(this._solPriceCache.value);
    }

    const ttlMs = Math.max(1_000, Number(config.solana?.priceCacheTtlMs || 30_000));
    try {
      const quote = await getNativeAssetPrice('solana');
      const price = Number(quote?.price || 0);
      if (Number.isFinite(price) && price > 0) {
        this._solPriceCache = {
          value: price,
          expiresAt: now + ttlMs,
          cachedAt: now,
        };
        return price;
      }
      throw new Error('invalid solana price payload');
    } catch (err) {
      if (Number.isFinite(this._solPriceCache.value) && this._solPriceCache.value > 0) {
        this._solPriceCache.expiresAt = now + 60_000;
        this._solPriceCache.cachedAt = now;
        // 2026-05-23: throttle warn to once per 5min.
        if (now - (this._priceWarnAt || 0) > 5 * 60_000) {
          logger.warn('Jupiter getSolPrice provider chain failed, extending cached price', {
            reason: err.message,
          });
          this._priceWarnAt = now;
        }
        return Number(this._solPriceCache.value);
      }

      const fallback = Number(config.solana?.fallbackPriceUsd || 200);
      logger.error(`Jupiter getSolPrice failed: ${err.message}`);
      this._solPriceCache = {
        value: fallback,
        expiresAt: now + 60_000,
        cachedAt: now,
      };
      return fallback;
    }
  }
}

module.exports = JupiterExchange;
