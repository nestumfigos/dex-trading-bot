'use strict';
const { ethers } = require('ethers');
const axios = require('axios');
const config = require('../../config');
const logger = require('../utils/logger');
const { getTokenMetrics } = require('../utils/coingecko');
const { getNativeAssetPrice } = require('../utils/market-data');

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

const BSC_RPCS = [
  config.bsc.rpcUrl,
  'https://bsc-dataseed.binance.org/',
  'https://bsc-dataseed1.defibit.io/',
  'https://bsc-dataseed1.ninicoin.io/',
  'https://bsc-dataseed2.defibit.io/',
  'https://bsc-dataseed2.ninicoin.io/',
  'https://bsc-dataseed3.defibit.io/',
  'https://bsc-dataseed3.ninicoin.io/',
  'https://bsc-dataseed4.defibit.io/',
  'https://bsc-dataseed4.ninicoin.io/',
  'https://bsc-mainnet.public.blastapi.io',
  'https://bsc.nodereal.io',
  'https://rpc.ankr.com/bsc',
  'https://bsc.publicnode.com',
  'https://rpc-bsc.48.club',
  'https://binance.llamarpc.com',
];

const DISCOVERY_FEEDS = [
  'https://api.dexscreener.com/token-profiles/latest/v1',
  'https://api.dexscreener.com/token-boosts/latest/v1',
  'https://api.dexscreener.com/token-boosts/top/v1',
];
const GECKO_BASE_URL = 'https://api.geckoterminal.com/api/v2';
const DISCOVERY_CACHE_MS = 5 * 60 * 1000;

async function getWorkingProvider(rpcs, maxRetries = 3) {
  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    for (const rpc of rpcs) {
      try {
        const provider = new ethers.JsonRpcProvider(rpc);
        await provider.getBlockNumber();
        return provider;
      } catch (error) {
        logger.debug(`Failed BSC RPC ${rpc}: ${error.message}`);
      }
    }
    logger.warn(`BSC RPC attempt ${attempt + 1} failed, retrying...`);
    await new Promise((resolve) => setTimeout(resolve, 5000 * (attempt + 1)));
  }
  throw new Error('All BSC RPCs failed!');
}

const ROUTER_ABI = [
  'function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)',
  'function swapExactTokensForTokensSupportingFeeOnTransferTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external',
  'function swapExactETHForTokensSupportingFeeOnTransferTokens(uint amountOutMin, address[] calldata path, address to, uint deadline) external payable',
  'function swapExactTokensForETHSupportingFeeOnTransferTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external',
];

const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
];

class PancakeSwapExchange {
  constructor(cache) {
    this.name = 'PancakeSwap (BSC)';
    this.provider = null;
    this.wallet = null;
    this.router = null;
    this.privateProvider = null;
    this.privateWallet = null;
    this.privateRouter = null;
    this.discoveryCache = { tokens: [], fetchedAt: 0 };
    this.cache = cache;
    this._bnbPriceCache = { value: null, cachedAt: null };
    this._frictionCache = new Map();
    this._nonceManager = null;
  }

  async initialize() {
    this.provider = await getWorkingProvider(BSC_RPCS);
    this.wallet = config.bsc.privateKey ? new ethers.Wallet(config.bsc.privateKey, this.provider) : null;
    this.router = new ethers.Contract(config.bsc.pancakeRouterV2, ROUTER_ABI, this.wallet || this.provider);
    if (config.execution?.bscPrivateTxRpcUrl && config.bsc.privateKey) {
      try {
        this.privateProvider = new ethers.JsonRpcProvider(config.execution.bscPrivateTxRpcUrl);
        await this.privateProvider.getBlockNumber();
        this.privateWallet = new ethers.Wallet(config.bsc.privateKey, this.privateProvider);
        this.privateRouter = new ethers.Contract(config.bsc.pancakeRouterV2, ROUTER_ABI, this.privateWallet);
        logger.info('PancakeSwap private transaction route enabled');
      } catch (error) {
        this.privateProvider = null;
        this.privateWallet = null;
        this.privateRouter = null;
        logger.warn(`PancakeSwap private transaction route unavailable: ${error.message}`);
      }
    }
    if (this.wallet) {
      this._nonceManager = new NonceManager(this.privateProvider || this.provider, this.wallet.address);
    }
  }

  hasPrivateTxRoute() {
    return Boolean(this.privateRouter && this.privateProvider);
  }

  async getTokenData(tokenAddress) {
    const cacheKey = `token:${tokenAddress}`;
    const cached = await this.cache.get(cacheKey);
    if (cached) return cached;

    try {
      const [dexRes, honeypotRes] = await Promise.allSettled([
        axios.get(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`, { timeout: 10000 }),
        axios.get(`https://api.honeypot.is/v2/IsHoneypot?address=${tokenAddress}&chainID=56`, { timeout: 8000 }),
      ]);

      const pairs = dexRes.status === 'fulfilled' ? dexRes.value.data?.pairs || [] : [];
      const pair = pairs.find((item) => item.chainId === 'bsc') || pairs[0] || null;
      if (!pair) return null;

      const honeypot = honeypotRes.status === 'fulfilled' ? honeypotRes.value.data : null;
      const metrics = await getTokenMetrics(tokenAddress, 'bsc', pair.baseToken?.symbol, pair.baseToken?.name);

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
        isHoneypot: honeypot?.isHoneypot || false,
        honeypotReason: honeypot?.honeypotReason || '',
        buyTax: honeypot?.simulationResult?.buyTax || 0,
        sellTax: honeypot?.simulationResult?.sellTax || 0,
        topHoldersPct: 0,
        teamWalletUnlocked: false,
        listingAgeDays: pair.pairCreatedAt ? (Date.now() - pair.pairCreatedAt) / 86400000 : 30,
        listingDate: pair.pairCreatedAt ? new Date(pair.pairCreatedAt).toISOString() : null,
        chain: 'BSC',
        pairAddress: pair.pairAddress,
        coingeckoId: metrics?.coingeckoId || null,
        listedOnCoinGecko: Boolean(metrics?.listedOnCoinGecko || metrics?.coingeckoId),
        listedOnCoinMarketCap: Boolean(metrics?.listedOnCoinMarketCap),
      };

      const liqBase = parseFloat(pair.liquidity?.base || 0);
      const liqQuote = parseFloat(pair.liquidity?.quote || 0);
      if (liqBase > 0 && liqQuote > 0) {
        const reserveRatio = Math.max(liqBase, liqQuote) / Math.min(liqBase, liqQuote);
        if (reserveRatio > Number(config.risk?.maxReserveImbalanceRatio ?? 1000)) {
          result.reserveImbalanced = true;
          result.reserveRatio = reserveRatio;
        }
      }

      // Bug 7: use a shorter TTL for new/momentum tokens so stale data expires faster.
      await this.cache.set(cacheKey, result, tokenDataCacheTtl(result.listingAgeDays));
      return result;
    } catch (err) {
      logger.error(`PancakeSwap getTokenData failed for ${tokenAddress}: ${err.message}`);
      return null;
    }
  }

  async getAmountOut(amountInBnb, tokenAddress) {
    const amounts = await this.router.getAmountsOut(amountInBnb, [config.bsc.wbnb, tokenAddress]);
    return amounts[1];
  }

  async checkRoundTripFriction(tokenAddress, testAmountBnb = 0.01) {
    const FRICTION_CACHE_TTL_MS = 5 * 60 * 1000;
    const cached = this._frictionCache.get(tokenAddress);
    if (cached && Date.now() - cached.cachedAt < FRICTION_CACHE_TTL_MS) {
      return { blocked: cached.blocked, frictionPct: cached.frictionPct, reason: cached.reason };
    }
    try {
      const amountIn = ethers.parseEther(testAmountBnb.toString());
      const buyAmounts = await this.router.getAmountsOut(amountIn, [config.bsc.wbnb, tokenAddress]);
      const tokenOut = buyAmounts[1];
      if (!tokenOut || tokenOut <= 0n) {
        const result = { blocked: false, frictionPct: 0 };
        this._frictionCache.set(tokenAddress, { ...result, cachedAt: Date.now() });
        return result;
      }
      const sellAmounts = await this.router.getAmountsOut(tokenOut, [tokenAddress, config.bsc.wbnb]);
      const finalBnb = Number(ethers.formatEther(sellAmounts[1]));
      const frictionPct = (1 - finalBnb / testAmountBnb) * 100;
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

  async ensureApproval(tokenAddress, amount) {
    const activeWallet = this.privateWallet || this.wallet;
    const token = new ethers.Contract(tokenAddress, ERC20_ABI, activeWallet);
    const allowance = await token.allowance(this.wallet.address, config.bsc.pancakeRouterV2);
    if (allowance < amount) {
      const tx = await token.approve(config.bsc.pancakeRouterV2, ethers.MaxUint256);
      await tx.wait(Math.max(1, Number(config.execution?.requiredConfirmationsBsc || 2)));
    }
  }

  async toRawTokenAmount(tokenAddress, tokenAmount) {
    if (typeof tokenAmount === 'bigint') return tokenAmount;
    const token = new ethers.Contract(tokenAddress, ERC20_ABI, this.provider);
    const decimals = await token.decimals();
    return ethers.parseUnits(String(tokenAmount), Number(decimals));
  }

  async executeBuy(tokenAddress, bnbAmount) {
    if (config.paperTrading) {
      logger.info(`[PAPER] PancakeSwap BUY ${tokenAddress} with ${bnbAmount} BNB`);
      return { txid: `paper_tx_${Date.now()}`, simulated: true };
    }

    if (!this.wallet) throw new Error('BSC wallet not configured');

    try {
      const retries = Math.max(1, Number(config.execution.maxRetries || 3));
      const baseSlippageBps = Math.max(30, Number(config.execution.slippageBps || 100));
      const activeRouter = (config.execution?.mevGuardEnabled !== false && this.privateRouter) ? this.privateRouter : this.router;
      const activeProvider = activeRouter?.runner?.provider || this.privateProvider || this.provider;
      const requiredConfirmations = Math.max(1, Number(config.execution?.requiredConfirmationsBsc || 2));

      for (let attempt = 1; attempt <= retries; attempt += 1) {
        try {
          const amountIn = ethers.parseEther(bnbAmount.toString());
          const amountOut = await this.getAmountOut(amountIn, tokenAddress);
          const slippageBps = Math.min(3000, baseSlippageBps + (attempt - 1) * 25);
          const amountOutMin = (amountOut * BigInt(10000 - slippageBps)) / 10000n;
          const deadline = Math.floor(Date.now() / 1000) + 300;

          const txRequest = await activeRouter.swapExactETHForTokensSupportingFeeOnTransferTokens.populateTransaction(
            amountOutMin,
            [config.bsc.wbnb, tokenAddress],
            this.wallet.address,
            deadline,
            { value: amountIn }
          );
          const estimatedGas = await activeProvider.estimateGas({ ...txRequest, from: this.wallet.address, value: amountIn });

          const txNonce = this._nonceManager ? await this._nonceManager.nextNonce() : undefined;
          const tx = await activeRouter.swapExactETHForTokensSupportingFeeOnTransferTokens(
            amountOutMin,
            [config.bsc.wbnb, tokenAddress],
            this.wallet.address,
            deadline,
            { value: amountIn, gasLimit: (estimatedGas * 120n) / 100n, ...(txNonce !== undefined ? { nonce: txNonce } : {}) }
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
            logger.warn(`PancakeSwap BUY log parse failed for ${tokenAddress}: ${parseErr.message}`);
          }
          const bnbSpent = Number(bnbAmount);
          const bnbPriceUsd = await this.getBnbPrice().catch(() => 0);
          const filledQuoteUsd = bnbPriceUsd > 0 ? bnbSpent * bnbPriceUsd : 0;
          return {
            txid: receipt.hash,
            slippageBps,
            filledBaseQty,
            filledQuoteUsd,
            blockNumber: receipt.blockNumber,
            confirmations: requiredConfirmations,
            privateRouteUsed: Boolean(activeRouter === this.privateRouter),
          };
        } catch (error) {
          if (attempt >= retries) throw error;
          logger.warn(`PancakeSwap BUY retry ${attempt}/${retries} failed: ${error.message}`);
          await new Promise((resolve) => setTimeout(resolve, Number(config.execution.retryDelayMs || 1200) * attempt));
        }
      }

      throw new Error('PancakeSwap BUY failed after retries');
    } catch (err) {
      logger.error(`PancakeSwap BUY failed: ${err.message}`);
      throw err;
    }
  }

  async executeSell(tokenAddress, tokenAmount) {
    if (config.paperTrading) {
      logger.info(`[PAPER] PancakeSwap SELL ${tokenAmount} of ${tokenAddress}`);
      return { txid: `paper_tx_${Date.now()}`, simulated: true };
    }

    if (!this.wallet) throw new Error('BSC wallet not configured');

    try {
      const retries = Math.max(1, Number(config.execution.maxRetries || 3));
      const baseSlippageBps = Math.max(30, Number(config.execution.slippageBps || 100));
      const activeRouter = (config.execution?.mevGuardEnabled !== false && this.privateRouter) ? this.privateRouter : this.router;
      const activeProvider = activeRouter?.runner?.provider || this.privateProvider || this.provider;
      const requiredConfirmations = Math.max(1, Number(config.execution?.requiredConfirmationsBsc || 2));

      for (let attempt = 1; attempt <= retries; attempt += 1) {
        try {
          const rawTokenAmount = await this.toRawTokenAmount(tokenAddress, tokenAmount);
          await this.ensureApproval(tokenAddress, rawTokenAmount);
          const amounts = await this.router.getAmountsOut(rawTokenAmount, [tokenAddress, config.bsc.wbnb]);
          const slippageBps = Math.min(3000, baseSlippageBps + (attempt - 1) * 25);
          const amountOutMin = (amounts[1] * BigInt(10000 - slippageBps)) / 10000n;
          const deadline = Math.floor(Date.now() / 1000) + 300;

          const txRequest = await activeRouter.swapExactTokensForETHSupportingFeeOnTransferTokens.populateTransaction(
            rawTokenAmount,
            amountOutMin,
            [tokenAddress, config.bsc.wbnb],
            this.wallet.address,
            deadline
          );
          const estimatedGas = await activeProvider.estimateGas({ ...txRequest, from: this.wallet.address });

          const txNonce = this._nonceManager ? await this._nonceManager.nextNonce() : undefined;
          const tx = await activeRouter.swapExactTokensForETHSupportingFeeOnTransferTokens(
            rawTokenAmount,
            amountOutMin,
            [tokenAddress, config.bsc.wbnb],
            this.wallet.address,
            deadline,
            { gasLimit: (estimatedGas * 120n) / 100n, ...(txNonce !== undefined ? { nonce: txNonce } : {}) }
          );

          const receipt = await tx.wait(requiredConfirmations);
          if (!receipt || receipt.status === 0) {
            if (this._nonceManager) this._nonceManager.reset();
            throw new Error(`SELL transaction reverted (hash=${tx.hash})`);
          }

          // Parse actual token debit from wallet via Transfer event (from=wallet) on the token contract.
          // Using swapExactTokensForETHSupportingFeeOnTransferTokens means the router calls
          // transferFrom(wallet → pair); the Transfer from=wallet is the real on-chain debit.
          const routerAddress = String(this.router?.target || config.bsc.pancakeRouterV2 || '').toLowerCase();
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
            logger.warn(`PancakeSwap SELL log parse failed for ${tokenAddress}: ${parseErr.message}`);
          }
          if (filledBaseQty <= 0) {
            logger.warn('PancakeSwap SELL transfer event not found, using requested amount', {
              chain: 'bsc',
              tokenAddress,
              txHash: receipt.hash,
              reason: 'transfer event not found, using requested amount',
            });
            filledBaseQty = Number(tokenAmount);
          }

          // Parse native BNB received from WBNB Withdrawal events.
          const WITHDRAWAL_TOPIC = '0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65';
          let nativeBnbReceived = 0;
          try {
            for (const log of receipt.logs) {
              if (log.address.toLowerCase() !== config.bsc.wbnb.toLowerCase()) continue;
              if (log.topics[0] !== WITHDRAWAL_TOPIC) continue;
              nativeBnbReceived += Number(ethers.formatEther(log.data));
            }
          } catch (parseErr) {
            logger.warn(`PancakeSwap SELL BNB log parse failed for ${tokenAddress}: ${parseErr.message}`);
          }
          const bnbPriceUsd = await this.getBnbPrice().catch(() => 0);
          const filledQuoteUsd = nativeBnbReceived > 0 && bnbPriceUsd > 0 ? nativeBnbReceived * bnbPriceUsd : 0;
          return {
            txid: receipt.hash,
            slippageBps,
            filledBaseQty,
            filledQuoteUsd,
            blockNumber: receipt.blockNumber,
            confirmations: requiredConfirmations,
            privateRouteUsed: Boolean(activeRouter === this.privateRouter),
          };
        } catch (error) {
          if (attempt >= retries) throw error;
          logger.warn(`PancakeSwap SELL retry ${attempt}/${retries} failed: ${error.message}`);
          await new Promise((resolve) => setTimeout(resolve, Number(config.execution.retryDelayMs || 1200) * attempt));
        }
      }

      throw new Error('PancakeSwap SELL failed after retries');
    } catch (err) {
      logger.error(`PancakeSwap SELL failed: ${err.message}`);
      throw err;
    }
  }

  async getNewTokens() {
    if (Date.now() - this.discoveryCache.fetchedAt < DISCOVERY_CACHE_MS && this.discoveryCache.tokens.length) {
      return this.discoveryCache.tokens;
    }

    const addresses = new Set();

    const geckoTokenIds = new Set();

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
          geckoTokenIds.add(relationshipId);
          const address = includedTokens.get(relationshipId) || relationshipId.replace(/^bsc_/, '');
          if (address) {
            addresses.add(address);
          }
        }
      });
    };

    await Promise.allSettled([
      axios.get(`${GECKO_BASE_URL}/networks/bsc/new_pools`, {
        params: { include: 'base_token', page: 1 },
        headers: { accept: 'application/json' },
        timeout: 12000,
      }).then((res) => parseGeckoResponse(res.data)),
      axios.get(`${GECKO_BASE_URL}/networks/bsc/new_pools`, {
        params: { include: 'base_token', page: 2 },
        headers: { accept: 'application/json' },
        timeout: 12000,
      }).then((res) => parseGeckoResponse(res.data)),
      axios.get(`${GECKO_BASE_URL}/networks/bsc/trending_pools`, {
        params: { include: 'base_token', page: 1 },
        headers: { accept: 'application/json' },
        timeout: 12000,
      }).then((res) => parseGeckoResponse(res.data)),
      axios.get(`${GECKO_BASE_URL}/networks/bsc/trending_pools`, {
        params: { include: 'base_token', page: 2 },
        headers: { accept: 'application/json' },
        timeout: 12000,
      }).then((res) => parseGeckoResponse(res.data)),
    ]);

    await Promise.allSettled(
      DISCOVERY_FEEDS.map(async (url) => {
        const res = await axios.get(url, { timeout: 10000 });
        const items = Array.isArray(res.data) ? res.data : [];
        items
          .filter((item) => item.chainId === 'bsc' && item.tokenAddress)
          .forEach((item) => addresses.add(item.tokenAddress));
      })
    );

    const tokens = Array.from(addresses);
    this.discoveryCache = { tokens, fetchedAt: Date.now() };
    return tokens;
  }

  async getSwingCandidates() {
    return [];
  }

  async getBnbPrice() {
    try {
      const quote = await getNativeAssetPrice('binancecoin');
      const price = Number(quote?.price || 0);
      if (Number.isFinite(price) && price > 0) {
        this._bnbPriceCache = { value: price, cachedAt: Date.now() };
        return price;
      }
      throw new Error('invalid binancecoin price payload');
    } catch (error) {
      if (Number.isFinite(this._bnbPriceCache.value) && this._bnbPriceCache.value > 0) {
        this._bnbPriceCache.cachedAt = Date.now();
        logger.warn('PancakeSwap getBnbPrice provider chain failed, extending cached BNB price', {
          reason: error.message,
          cachedPrice: this._bnbPriceCache.value,
        });
        return Number(this._bnbPriceCache.value);
      }
      try {
        const binanceRes = await axios.get('https://api.binance.com/api/v3/ticker/price?symbol=BNBUSDT', { timeout: 5000 });
        const binancePrice = parseFloat(binanceRes.data?.price || 0);
        if (Number.isFinite(binancePrice) && binancePrice > 0) {
          logger.debug('PancakeSwap getBnbPrice: using Binance REST fallback', { price: binancePrice });
          this._bnbPriceCache = { value: binancePrice, cachedAt: Date.now() };
          return binancePrice;
        }
      } catch (_) {
        // Binance fallback also failed; proceed to hardcoded constant.
      }
      const fallback = Number(config.bsc?.fallbackPriceUsd || 300);
      logger.error('PancakeSwap getBnbPrice failed with no live provider; using fallback price', {
        reason: error.message,
        fallback,
      });
      this._bnbPriceCache = { value: fallback, cachedAt: Date.now() };
      return fallback;
    }
  }

  getCachedBnbPrice() {
    return { price: this._bnbPriceCache.value, cachedAt: this._bnbPriceCache.cachedAt };
  }

  async getBalance() {
    if (!this.wallet) return 0;
    try {
      const bnbBalance = await this.provider.getBalance(this.wallet.address);
      const bnbPrice = await this.getBnbPrice();
      return (parseFloat(ethers.formatEther(bnbBalance))) * bnbPrice;
    } catch (err) {
      logger.error(`PancakeSwap getBalance failed: ${err.message}`);
      return 0;
    }
  }

  async getWalletPositions() {
    return [];
  }
}

module.exports = PancakeSwapExchange;
