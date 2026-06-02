'use strict';
const { ethers } = require('ethers');
const axios = require('axios');
const config = require('../../config');
const logger = require('../utils/logger');
const { getTokenMetrics } = require('../utils/coingecko');
const { getNativeAssetPrice } = require('../utils/market-data');
const dexscreenerClient = require('../utils/dexscreener-client');

/**
 * Bug 7 — age-adaptive cache TTL for token data.
 * Tokens < 6h old: 15s  |  6–24h: 30s  |  older: 60s (all configurable via env)
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

// Tracks the next pending nonce to prevent nonce reuse across concurrent txs.
class NonceManager {
  constructor(provider, address) {
    this._provider = provider;
    this._address = address;
    this._nonce = null;
  }

  async nextNonce() {
    if (this._nonce === null) {
      this._nonce = await this._provider.getTransactionCount(this._address, 'pending');
    } else {
      this._nonce += 1;
    }
    return this._nonce;
  }

  reset() { this._nonce = null; }
}

const ROUTER_ABI = [
  'function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)',
  'function swapExactETHForTokensSupportingFeeOnTransferTokens(uint amountOutMin, address[] calldata path, address to, uint deadline) external payable',
  'function swapExactTokensForETHSupportingFeeOnTransferTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external',
  'function swapExactTokensForTokensSupportingFeeOnTransferTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external',
];

const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
];

const DISCOVERY_FEEDS = [
  'https://api.dexscreener.com/token-profiles/latest/v1',
  'https://api.dexscreener.com/token-boosts/latest/v1',
  'https://api.dexscreener.com/token-boosts/top/v1',
];
const GECKO_BASE_URL = 'https://api.geckoterminal.com/api/v2';
const DISCOVERY_CACHE_MS = 5 * 60 * 1000;

class BaseSwapExchange {
  constructor(cache) {
    this.name = 'BaseSwap (Base)';
    this.provider = null;
    this.wallet = null;
    this.router = null;
    this.discoveryCache = { tokens: [], fetchedAt: 0 };
    this.cache = cache;
    this._ethPriceCache = {
      value: null,
      expiresAt: 0,
      cachedAt: null,
    };
    this._frictionCache = new Map();
    this._nonceManager = null;
    // 2026-05-23: cache + cooldown so public Base RPC 504/timeouts don't flood logs.
    this._balanceCache = { value: 0, expiresAt: 0 };
    this._balanceErrorCooldownUntil = 0;
    this._balanceErrorLoggedAt = 0;
  }

  async initialize() {
    const baseRpcs = [
      config.base.rpcUrl,
      config.base.alchemyKey ? `https://base-mainnet.g.alchemy.com/v2/${config.base.alchemyKey}` : null,
      'https://mainnet.base.org',
      'https://rpc.ankr.com/base',
      'https://base.publicnode.com',
      'https://base.llamarpc.com',
      'https://base-mainnet.public.blastapi.io',
    ].filter(Boolean);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      for (const rpc of baseRpcs) {
        try {
          this.provider = new ethers.JsonRpcProvider(rpc);
          await this.provider.getBlockNumber();
          break;
        } catch (error) {
          logger.debug(`Failed Base RPC ${rpc}: ${error.message}`);
        }
      }
      if (this.provider) break;
      logger.warn(`Base RPC attempt ${attempt + 1} failed, retrying...`);
      await new Promise((resolve) => setTimeout(resolve, 5000 * (attempt + 1)));
    }

    if (!this.provider) {
      throw new Error('All Base RPCs failed!');
    }

    this.wallet = config.base.privateKey ? new ethers.Wallet(config.base.privateKey, this.provider) : null;
    this.router = new ethers.Contract(config.base.baseswapRouter, ROUTER_ABI, this.wallet || this.provider);
    if (this.wallet) {
      this._nonceManager = new NonceManager(this.provider, this.wallet.address);
    }
  }

  async reconnectProvider() {
    const baseRpcs = [
      config.base.rpcUrl,
      config.base.alchemyKey ? `https://base-mainnet.g.alchemy.com/v2/${config.base.alchemyKey}` : null,
      'https://mainnet.base.org',
      'https://rpc.ankr.com/base',
    ].filter(Boolean);
    for (const rpc of baseRpcs) {
      try {
        const newProvider = new ethers.JsonRpcProvider(rpc);
        await newProvider.getBlockNumber();
        this.provider = newProvider;
        if (this.wallet) {
          this.wallet = this.wallet.connect(newProvider);
        }
        this.router = new ethers.Contract(config.base.baseswapRouter, ROUTER_ABI, this.wallet || this.provider);
        if (this._nonceManager && this.wallet) {
          this._nonceManager.reset();
        }
        logger.info(`[RPC] BaseSwap provider reconnected via ${rpc} (nonce manager preserved)`);
        return;
      } catch (err) {
        logger.debug(`BaseSwap reconnect RPC ${rpc} failed: ${err.message}`);
      }
    }
    throw new Error('All Base RPCs failed during reconnect');
  }

  hasPrivateTxRoute() {
    return false;
  }

  async getTokenData(tokenAddress) {
    const cacheKey = `token:${tokenAddress}`;
    const cached = await this.cache?.get(cacheKey);
    if (cached) return cached;

    try {
      const dexData = await dexscreenerClient.throttledFetch(
        `https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`,
        {
          timeoutMs: Math.max(1000, Number(config.risk?.dexscreenerTokenLookupTimeoutMs || 5000)),
          cacheTtlMs: Math.max(1000, Number(config.risk?.dexscreenerTokenCacheTtlMs || 60_000)),
        }
      ).catch(() => null);

      const pairs = Array.isArray(dexData?.pairs) ? dexData.pairs : [];
      const pair = pairs.find((item) => item.chainId === 'base') || pairs[0] || null;
      if (!pair) return null;
      const metricsTimeoutMs = Math.max(250, Number(config.risk?.tokenMetricsLookupTimeoutMs || 1200));
      const metrics = await withTimeoutValue(
        getTokenMetrics(tokenAddress, 'base', pair.baseToken?.symbol, pair.baseToken?.name),
        metricsTimeoutMs,
        null
      );

      const result = {
        address: tokenAddress,
        symbol: pair.baseToken?.symbol || 'UNKNOWN',
        name: pair.baseToken?.name || '',
        price: parseFloat(pair.priceUsd || 0),
        liquidityUsd: parseFloat(pair.liquidity?.usd || 0),
        liquidityChange24hPct: 0,
        volume24h: parseFloat(pair.volume?.h24 || 0),
        priceChange24h: parseFloat(pair.priceChange?.h24 || 0),
        priceChange7d: parseFloat(pair.priceChange?.h7d || 0),
        buyTx10m: Number(pair.txns?.m5?.buys || 0),
        sellTx10m: Number(pair.txns?.m5?.sells || 0),
        buyTx1h: Number(pair.txns?.h1?.buys || 0),
        sellTx1h: Number(pair.txns?.h1?.sells || 0),
        txCountFirstHour: Number((pair.txns?.h1?.buys || 0) + (pair.txns?.h1?.sells || 0)),
        uniqueBuyers10m: 0,
        isHoneypot: false,
        topHoldersPct: 0,
        teamWalletUnlocked: false,
        listingAgeDays: pair.pairCreatedAt ? (Date.now() - pair.pairCreatedAt) / 86400000 : 30,
        listingDate: pair.pairCreatedAt ? new Date(pair.pairCreatedAt).toISOString() : null,
        chain: 'Base',
        pairAddress: pair.pairAddress,
        dex: pair.dexId || 'baseswap',
        coingeckoId: metrics?.coingeckoId || null,
        listedOnCoinGecko: Boolean(metrics?.listedOnCoinGecko || metrics?.coingeckoId),
        listedOnCoinMarketCap: Boolean(metrics?.listedOnCoinMarketCap),
      };

      const liqBase = parseFloat(pair.liquidity?.base || 0);
      const liqQuote = parseFloat(pair.liquidity?.quote || 0);
      const totalLiquidityUsd = Number(result.liquidityUsd || 0);
      const basePriceUsd = Number(result.price || 0);
      if (liqBase > 0 && liqQuote > 0) {
        let reserveRatio = 0;
        const baseReserveUsd = liqBase * basePriceUsd;
        const quoteReserveUsd = Math.max(0, totalLiquidityUsd - baseReserveUsd);

        if (baseReserveUsd > 0 && quoteReserveUsd > 0) {
          reserveRatio = Math.max(baseReserveUsd, quoteReserveUsd) / Math.min(baseReserveUsd, quoteReserveUsd);
        } else {
          reserveRatio = Math.max(liqBase, liqQuote) / Math.min(liqBase, liqQuote);
        }

        if (reserveRatio > Number(config.risk?.maxReserveImbalanceRatio ?? 1000)) {
          result.reserveImbalanced = true;
          result.reserveRatio = reserveRatio;
        }
      }

      // Bug 7: use a shorter TTL for new/momentum tokens so stale data expires faster.
      await this.cache?.set(cacheKey, result, tokenDataCacheTtl(result.listingAgeDays));
      return result;
    } catch (err) {
      logger.error(`BaseSwap getTokenData failed for ${tokenAddress}: ${err.message}`);
      return null;
    }
  }

  async ensureApproval(tokenAddress, amount) {
    const token = new ethers.Contract(tokenAddress, ERC20_ABI, this.wallet);
    const allowance = await token.allowance(this.wallet.address, config.base.baseswapRouter);
    if (allowance < amount) {
      const tx = await token.approve(config.base.baseswapRouter, ethers.MaxUint256);
      await tx.wait(Math.max(1, Number(config.execution?.requiredConfirmationsBase || 2)));
    }
  }

  async toRawTokenAmount(tokenAddress, tokenAmount) {
    if (typeof tokenAmount === 'bigint') return tokenAmount;
    const token = new ethers.Contract(tokenAddress, ERC20_ABI, this.provider);
    const decimals = await token.decimals();
    return ethers.parseUnits(String(tokenAmount), Number(decimals));
  }

  async getAmountOut(amountInEth, tokenAddress) {
    const amounts = await this.router.getAmountsOut(amountInEth, [config.base.weth, tokenAddress]);
    return amounts[1];
  }

  async checkRoundTripFriction(tokenAddress, testAmountEth = 0.01) {
    const FRICTION_CACHE_TTL_MS = 5 * 60 * 1000;
    const cached = this._frictionCache.get(tokenAddress);
    if (cached && Date.now() - cached.cachedAt < FRICTION_CACHE_TTL_MS) {
      return { blocked: cached.blocked, frictionPct: cached.frictionPct, reason: cached.reason };
    }
    try {
      const amountIn = ethers.parseEther(testAmountEth.toString());
      const buyAmounts = await this.router.getAmountsOut(amountIn, [config.base.weth, tokenAddress]);
      const tokenOut = buyAmounts[1];
      if (!tokenOut || tokenOut <= 0n) {
        const result = { blocked: false, frictionPct: 0 };
        this._frictionCache.set(tokenAddress, { ...result, cachedAt: Date.now() });
        return result;
      }
      const sellAmounts = await this.router.getAmountsOut(tokenOut, [tokenAddress, config.base.weth]);
      const finalEth = Number(ethers.formatEther(sellAmounts[1]));
      const frictionPct = (1 - finalEth / testAmountEth) * 100;
      const threshold = Number(config.risk?.maxRoundTripFrictionPct ?? 15);
      const blocked = frictionPct > threshold;
      const reason = blocked ? 'round-trip friction too high' : '';
      const result = { blocked, frictionPct, reason };
      this._frictionCache.set(tokenAddress, { ...result, cachedAt: Date.now() });
      return result;
    } catch (err) {
      logger.debug(`checkRoundTripFriction failed for ${tokenAddress}: ${err.message}`);
      return { blocked: false, frictionPct: 0 };
    }
  }

  async executeBuy(tokenAddress, ethAmount) {
    if (config.paperTrading) {
      logger.info(`[PAPER] BaseSwap BUY ${tokenAddress} with ${ethAmount} ETH`);
      return { txid: `paper_tx_${Date.now()}`, simulated: true };
    }

    if (!this.wallet) throw new Error('Base wallet not configured');

    try {
      const retries = Math.max(1, Number(config.execution.maxRetries || 3));
      const baseSlippageBps = Math.max(30, Number(config.execution.slippageBps || 100));
      const requiredConfirmations = Math.max(1, Number(config.execution?.requiredConfirmationsBase || 2));

      for (let attempt = 1; attempt <= retries; attempt += 1) {
        try {
          const amountIn = ethers.parseEther(ethAmount.toString());
          const amountOut = await this.getAmountOut(amountIn, tokenAddress);
          const slippageBps = Math.min(3000, baseSlippageBps + (attempt - 1) * 25);
          const amountOutMin = (amountOut * BigInt(10000 - slippageBps)) / 10000n;
          const deadline = Math.floor(Date.now() / 1000) + 300;
          const feeData = await this.provider.getFeeData();

          const txRequest = await this.router.swapExactETHForTokensSupportingFeeOnTransferTokens.populateTransaction(
            amountOutMin,
            [config.base.weth, tokenAddress],
            this.wallet.address,
            deadline,
            { value: amountIn }
          );
          const estimatedGas = await this.provider.estimateGas({ ...txRequest, from: this.wallet.address, value: amountIn });

          const txNonce = this._nonceManager ? await this._nonceManager.nextNonce() : undefined;
          const tx = await this.router.swapExactETHForTokensSupportingFeeOnTransferTokens(
            amountOutMin,
            [config.base.weth, tokenAddress],
            this.wallet.address,
            deadline,
            {
              value: amountIn,
              gasLimit: (estimatedGas * 120n) / 100n,
              maxFeePerGas: feeData.maxFeePerGas,
              maxPriorityFeePerGas: feeData.maxPriorityFeePerGas,
              ...(txNonce !== undefined ? { nonce: txNonce } : {}),
            }
          );

          const receipt = await tx.wait(requiredConfirmations);
          if (!receipt || receipt.status === 0) {
            if (this._nonceManager) this._nonceManager.reset();
            throw new Error(`BUY transaction reverted (hash=${tx.hash})`);
          }

          // Parse confirmed tokens received from Transfer events on the token contract.
          const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
          let filledBaseQty = 0;
          try {
            const tokenIface = new ethers.Interface(['event Transfer(address indexed from, address indexed to, uint256 value)']);
            const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, this.provider);
            const decimals = Number(await tokenContract.decimals());
            for (const log of receipt.logs) {
              if (log.address.toLowerCase() !== tokenAddress.toLowerCase()) continue;
              if (log.topics[0] !== TRANSFER_TOPIC) continue;
              const parsed = tokenIface.parseLog({ topics: log.topics, data: log.data });
              if (parsed && parsed.args.to.toLowerCase() === this.wallet.address.toLowerCase()) {
                filledBaseQty += Number(ethers.formatUnits(parsed.args.value, decimals));
              }
            }
          } catch (parseErr) {
            logger.warn(`BaseSwap BUY log parse failed for ${tokenAddress}: ${parseErr.message}`);
          }
          const ethSpent = Number(ethAmount);
          const ethPriceUsd = await this.getEthPrice().catch(() => 0);
          const filledQuoteUsd = ethPriceUsd > 0 ? ethSpent * ethPriceUsd : 0;
          return {
            txid: receipt.hash,
            slippageBps,
            filledBaseQty,
            filledQuoteUsd,
            hasExchangeFilledData: Boolean(filledBaseQty > 0 && filledQuoteUsd > 0),
            blockNumber: receipt.blockNumber,
            confirmations: requiredConfirmations,
          };
        } catch (error) {
          if (attempt >= retries) throw error;
          logger.warn(`BaseSwap BUY retry ${attempt}/${retries} failed: ${error.message}`);
          await new Promise((resolve) => setTimeout(resolve, Number(config.execution.retryDelayMs || 1200) * attempt));
        }
      }

      throw new Error('BaseSwap BUY failed after retries');
    } catch (err) {
      logger.error(`BaseSwap BUY failed: ${err.message}`);
      throw err;
    }
  }

  async executeSell(tokenAddress, tokenAmount) {
    if (config.paperTrading) {
      logger.info(`[PAPER] BaseSwap SELL ${tokenAmount} of ${tokenAddress}`);
      return { txid: `paper_tx_${Date.now()}`, simulated: true };
    }

    if (!this.wallet) throw new Error('Base wallet not configured');

    try {
      const retries = Math.max(1, Number(config.execution.maxRetries || 3));
      const baseSlippageBps = Math.max(30, Number(config.execution.slippageBps || 100));
      const requiredConfirmations = Math.max(1, Number(config.execution?.requiredConfirmationsBase || 2));

      for (let attempt = 1; attempt <= retries; attempt += 1) {
        try {
          const rawTokenAmount = await this.toRawTokenAmount(tokenAddress, tokenAmount);
          await this.ensureApproval(tokenAddress, rawTokenAmount);
          const amounts = await this.router.getAmountsOut(rawTokenAmount, [tokenAddress, config.base.weth]);
          const slippageBps = Math.min(3000, baseSlippageBps + (attempt - 1) * 25);
          const amountOutMin = (amounts[1] * BigInt(10000 - slippageBps)) / 10000n;
          const deadline = Math.floor(Date.now() / 1000) + 300;
          const feeData = await this.provider.getFeeData();

          const txRequest = await this.router.swapExactTokensForETHSupportingFeeOnTransferTokens.populateTransaction(
            rawTokenAmount,
            amountOutMin,
            [tokenAddress, config.base.weth],
            this.wallet.address,
            deadline
          );
          const estimatedGas = await this.provider.estimateGas({ ...txRequest, from: this.wallet.address });

          const txNonce = this._nonceManager ? await this._nonceManager.nextNonce() : undefined;
          const tx = await this.router.swapExactTokensForETHSupportingFeeOnTransferTokens(
            rawTokenAmount,
            amountOutMin,
            [tokenAddress, config.base.weth],
            this.wallet.address,
            deadline,
            {
              gasLimit: (estimatedGas * 120n) / 100n,
              maxFeePerGas: feeData.maxFeePerGas,
              maxPriorityFeePerGas: feeData.maxPriorityFeePerGas,
              ...(txNonce !== undefined ? { nonce: txNonce } : {}),
            }
          );

          const receipt = await tx.wait(requiredConfirmations);
          if (!receipt || receipt.status === 0) {
            if (this._nonceManager) this._nonceManager.reset();
            throw new Error(`SELL transaction reverted (hash=${tx.hash})`);
          }

          // Parse actual token debit from wallet via Transfer event (from=wallet) on the token contract.
          // Using swapExactTokensForETHSupportingFeeOnTransferTokens means the router calls
          // transferFrom(wallet → pair); the Transfer from=wallet is the real on-chain debit.
          const routerAddress = String(this.router?.target || config.base.baseswapRouter || '').toLowerCase();
          const SWAP_TOPIC = '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822';
          const swapPairAddresses = new Set();
          const swapDecoder = ethers.AbiCoder.defaultAbiCoder();
          for (const log of receipt.logs) {
            if (log.topics?.[0] !== SWAP_TOPIC) continue;
            try {
              const [amount0In, amount1In] = swapDecoder.decode(['uint256', 'uint256', 'uint256', 'uint256'], log.data);
              if (amount0In > 0n || amount1In > 0n) {
                swapPairAddresses.add(String(log.address || '').toLowerCase());
              }
            } catch (_) {
              // Ignore malformed swap logs and rely on router fallback matching.
            }
          }
          const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
          let filledBaseQty = 0;
          try {
            const tokenIface = new ethers.Interface(['event Transfer(address indexed from, address indexed to, uint256 value)']);
            const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, this.provider);
            const decimals = Number(await tokenContract.decimals());
            for (const log of receipt.logs) {
              if (log.address.toLowerCase() !== tokenAddress.toLowerCase()) continue;
              if (log.topics[0] !== TRANSFER_TOPIC) continue;
              const parsed = tokenIface.parseLog({ topics: log.topics, data: log.data });
              const transferTo = parsed?.args?.to ? String(parsed.args.to).toLowerCase() : '';
              const transferFrom = parsed?.args?.from ? String(parsed.args.from).toLowerCase() : '';
              const validDestination = transferTo === routerAddress || swapPairAddresses.has(transferTo);
              if (parsed && transferFrom === this.wallet.address.toLowerCase() && validDestination) {
                filledBaseQty += Number(ethers.formatUnits(parsed.args.value, decimals));
              }
            }
          } catch (parseErr) {
            logger.warn(`BaseSwap SELL log parse failed for ${tokenAddress}: ${parseErr.message}`);
          }
          if (filledBaseQty <= 0) {
            logger.warn('BaseSwap SELL transfer event not found, using requested amount', {
              chain: 'base',
              tokenAddress,
              txHash: receipt.hash,
              reason: 'transfer event not found, using requested amount',
            });
            filledBaseQty = Number(tokenAmount);
          }

          // Parse native ETH received from WETH Withdrawal events.
          const WITHDRAWAL_TOPIC = '0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65';
          let nativeEthReceived = 0;
          try {
            for (const log of receipt.logs) {
              if (log.address.toLowerCase() !== config.base.weth.toLowerCase()) continue;
              if (log.topics[0] !== WITHDRAWAL_TOPIC) continue;
              nativeEthReceived += Number(ethers.formatEther(log.data));
            }
          } catch (parseErr) {
            logger.warn(`BaseSwap SELL ETH log parse failed for ${tokenAddress}: ${parseErr.message}`);
          }
          const ethPriceUsd = await this.getEthPrice().catch(() => 0);
          const filledQuoteUsd = nativeEthReceived > 0 && ethPriceUsd > 0 ? nativeEthReceived * ethPriceUsd : 0;
          return {
            txid: receipt.hash,
            slippageBps,
            filledBaseQty,
            filledQuoteUsd,
            hasExchangeFilledData: Boolean(filledBaseQty > 0 && filledQuoteUsd > 0),
            blockNumber: receipt.blockNumber,
            confirmations: requiredConfirmations,
          };
        } catch (error) {
          if (attempt >= retries) throw error;
          logger.warn(`BaseSwap SELL retry ${attempt}/${retries} failed: ${error.message}`);
          await new Promise((resolve) => setTimeout(resolve, Number(config.execution.retryDelayMs || 1200) * attempt));
        }
      }

      throw new Error('BaseSwap SELL failed after retries');
    } catch (err) {
      logger.error(`BaseSwap SELL failed: ${err.message}`);
      throw err;
    }
  }

  async getNewTokens() {
    if (Date.now() - this.discoveryCache.fetchedAt < DISCOVERY_CACHE_MS && this.discoveryCache.tokens.length) {
      return this.discoveryCache.tokens;
    }

    const addresses = new Set();

    const parseGeckoResponse = (payload) => {
      const pools = Array.isArray(payload?.data) ? payload.data : [];
      const included = Array.isArray(payload?.included) ? payload.included : [];
      const includedTokens = new Map(
        included
          .filter((item) => item?.type === 'token' && item?.id && item?.attributes?.address)
          .map((item) => [item.id, item.attributes.address])
      );

      pools.forEach((pool) => {
        const relationshipId = pool?.relationships?.base_token?.data?.id;
        if (relationshipId) {
          const address = includedTokens.get(relationshipId) || relationshipId.replace(/^base_/, '');
          if (address) {
            addresses.add(address);
          }
        }
      });
    };

    await Promise.allSettled([
      axios.get(`${GECKO_BASE_URL}/networks/base/new_pools`, {
        params: { include: 'base_token', page: 1 },
        headers: { accept: 'application/json' },
        timeout: 12000,
      }).then((res) => parseGeckoResponse(res.data)),
      axios.get(`${GECKO_BASE_URL}/networks/base/trending_pools`, {
        params: { include: 'base_token', page: 1 },
        headers: { accept: 'application/json' },
        timeout: 12000,
      }).then((res) => parseGeckoResponse(res.data)),
    ]);

    for (const url of DISCOVERY_FEEDS) {
      try {
        const data = await dexscreenerClient.throttledFetch(url, { timeoutMs: 10000, cacheTtlMs: 60_000 });
        const items = Array.isArray(data) ? data : [];
        items
          .filter((item) => item.chainId === 'base' && item.tokenAddress)
          .forEach((item) => addresses.add(item.tokenAddress));
      } catch (err) {
        logger.debug(`[BaseSwap] discovery feed ${url} failed: ${err.message}`);
      }
    }

    const tokens = Array.from(addresses);
    this.discoveryCache = { tokens, fetchedAt: Date.now() };
    return tokens;
  }

  async getSwingCandidates() {
    return [];
  }

  async getEthPrice() {
    const now = Date.now();
    if (Number.isFinite(this._ethPriceCache.value) && now < Number(this._ethPriceCache.expiresAt || 0)) {
      return Number(this._ethPriceCache.value);
    }

    const ttlMs = Math.max(1_000, Number(config.base?.priceCacheTtlMs || 30_000));
    try {
      const quote = await getNativeAssetPrice('ethereum');
      const price = Number(quote?.price || 0);
      if (Number.isFinite(price) && price > 0) {
        this._ethPriceCache = {
          value: price,
          expiresAt: now + ttlMs,
          cachedAt: now,
        };
        return price;
      }
      throw new Error('invalid ethereum price payload');
    } catch (error) {
      if (Number.isFinite(this._ethPriceCache.value) && this._ethPriceCache.value > 0) {
        this._ethPriceCache.expiresAt = now + 60_000;
        this._ethPriceCache.cachedAt = now;
        // 2026-05-23: throttle warn to once per 5min.
        if (now - (this._priceWarnAt || 0) > 5 * 60_000) {
          logger.warn('BaseSwap getEthPrice provider chain failed, extending cached price', {
            reason: error.message,
          });
          this._priceWarnAt = now;
        }
        return Number(this._ethPriceCache.value);
      }

      const fallback = Number(config.base?.fallbackPriceUsd || 3000);
      logger.warn(`BaseSwap getEthPrice failed: ${error.message}`);
      this._ethPriceCache = {
        value: fallback,
        expiresAt: now + 60_000,
        cachedAt: now,
      };
      return fallback;
    }
  }

  getCachedEthPrice() {
    return { price: this._ethPriceCache.value, cachedAt: this._ethPriceCache.cachedAt };
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
      const ethBalance = await this.provider.getBalance(this.wallet.address);
      const ethPrice = await this.getEthPrice();
      const usd = Number(ethers.formatEther(ethBalance)) * ethPrice;
      this._balanceCache = { value: usd, expiresAt: now + 60_000 };
      return usd;
    } catch (error) {
      const msg = String(error?.message || '');
      const transient = /429|Too Many Requests|fetch failed|ETIMEDOUT|ECONNRESET|ENOTFOUND|503|504|Gateway Timeout|SERVER_ERROR/i.test(msg);
      if (transient) {
        this._balanceErrorCooldownUntil = now + 5 * 60_000;
        if (now - this._balanceErrorLoggedAt > 5 * 60_000) {
          logger.warn(`BaseSwap getBalance transient failure, cooling down 5m: ${msg.slice(0, 200)}`);
          this._balanceErrorLoggedAt = now;
        }
      } else {
        logger.error(`BaseSwap getBalance failed: ${msg}`);
      }
      return Number(this._balanceCache.value || 0);
    }
  }

  async getWalletPositions() {
    return [];
  }
}

module.exports = BaseSwapExchange;
