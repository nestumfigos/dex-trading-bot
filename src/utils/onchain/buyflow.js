'use strict';

const axios = require('axios');
const config = require('../../../config');
const logger = require('../logger');

const cache = new Map();
const CACHE_MS = 60_000;

function getCached(key) {
  const row = cache.get(key);
  if (!row) return null;
  if (row.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }
  return row.value;
}

function setCached(key, value) {
  cache.set(key, { value, expiresAt: Date.now() + CACHE_MS });
}

function pickNumber(data, candidates) {
  for (const key of candidates) {
    const parts = key.split('.');
    let node = data;
    for (const part of parts) {
      if (!node || typeof node !== 'object') {
        node = undefined;
        break;
      }
      node = node[part];
    }

    const num = Number(node);
    if (Number.isFinite(num)) return num;
  }
  return null;
}

async function getNetBuyFlowUsd(tokenAddress, chainKey) {
  const normalizedChain = String(chainKey || '').toLowerCase();
  if (normalizedChain !== 'solana' || !config.birdeye.apiKey || !tokenAddress) {
    return null;
  }

  const key = `${normalizedChain}:${String(tokenAddress).toLowerCase()}`;
  const cached = getCached(key);
  if (cached !== null) {
    return cached;
  }

  const headers = {
    'X-API-KEY': config.birdeye.apiKey,
    'x-chain': 'solana',
    'accept': 'application/json',
  };
  const endpoints = [
    `${config.birdeye.baseUrl}/defi/v3/token/trade-data/single?address=${encodeURIComponent(tokenAddress)}`,
    `${config.birdeye.baseUrl}/defi/token_overview?address=${encodeURIComponent(tokenAddress)}`,
  ];

  for (const url of endpoints) {
    try {
      const res = await axios.get(url, { headers, timeout: 10000 });
      const data = res.data?.data || res.data || {};

      const buy10m = pickNumber(data, [
        'buy10mUsd',
        'vBuy10mUSD',
        'volume.buy10mUsd',
        'volume.buy_10m_usd',
        'trade_data.buy10mUsd',
      ]);
      const sell10m = pickNumber(data, [
        'sell10mUsd',
        'vSell10mUSD',
        'volume.sell10mUsd',
        'volume.sell_10m_usd',
        'trade_data.sell10mUsd',
      ]);

      if (buy10m !== null && sell10m !== null) {
        const net = buy10m - sell10m;
        setCached(key, net);
        return net;
      }
    } catch (error) {
      logger.debug(`Buy-flow endpoint failed (${url}): ${error.message}`);
    }
  }

  setCached(key, null);
  return null;
}

module.exports = { getNetBuyFlowUsd };
