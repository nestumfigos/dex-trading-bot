'use strict';

// K1: symbol normalization between internal canonical (Binance-style, BTCUSDT)
// and KuCoin Futures (XBTUSDTM). Internal stays Binance-style so strategies,
// scanner, telemetry, and persistence layer keep their existing shape — only
// the I/O boundary (REST/WS) crosses the translation.
//
// Rules:
//   - Suffix: canonical `<BASE>USDT` <-> kucoin `<BASE>USDTM`.
//   - Base aliases: KuCoin uses XBT for Bitcoin, canonical uses BTC.
//   - All other bases pass through unchanged (PEPE, WIF, DOGE, XRP, etc).
//   - Only USDT-margined contracts are supported (KuCoin also has USD-margined
//     inverse perps `XBTUSDM` — explicitly rejected to prevent confusion).

const BASE_ALIASES_CANONICAL_TO_KUCOIN = Object.freeze({
  BTC: 'XBT',
});
const BASE_ALIASES_KUCOIN_TO_CANONICAL = Object.freeze({
  XBT: 'BTC',
});

function isString(value) {
  return typeof value === 'string' && value.length > 0;
}

function toKucoinSymbol(canonicalSymbol) {
  if (!isString(canonicalSymbol)) {
    throw new Error('toKucoinSymbol: canonicalSymbol must be a non-empty string');
  }
  const upper = canonicalSymbol.toUpperCase();
  if (!upper.endsWith('USDT')) {
    throw new Error(`toKucoinSymbol: only USDT-margined perps supported (got ${canonicalSymbol})`);
  }
  const base = upper.slice(0, -4);
  if (base.length === 0) {
    throw new Error(`toKucoinSymbol: empty base in ${canonicalSymbol}`);
  }
  const mappedBase = BASE_ALIASES_CANONICAL_TO_KUCOIN[base] || base;
  return `${mappedBase}USDTM`;
}

function fromKucoinSymbol(kucoinSymbol) {
  if (!isString(kucoinSymbol)) {
    throw new Error('fromKucoinSymbol: kucoinSymbol must be a non-empty string');
  }
  const upper = kucoinSymbol.toUpperCase();
  if (!upper.endsWith('USDTM')) {
    // USD-margined inverse perps (XBTUSDM) are NOT supported by this layer —
    // they have different PnL semantics (settled in base currency, not USDT).
    throw new Error(`fromKucoinSymbol: only USDT-margined perps supported (got ${kucoinSymbol})`);
  }
  const base = upper.slice(0, -5);
  if (base.length === 0) {
    throw new Error(`fromKucoinSymbol: empty base in ${kucoinSymbol}`);
  }
  const mappedBase = BASE_ALIASES_KUCOIN_TO_CANONICAL[base] || base;
  return `${mappedBase}USDT`;
}

function isCanonicalUsdtPerp(canonicalSymbol) {
  if (!isString(canonicalSymbol)) return false;
  try {
    toKucoinSymbol(canonicalSymbol);
    return true;
  } catch (_err) {
    return false;
  }
}

function isKucoinUsdtmPerp(kucoinSymbol) {
  if (!isString(kucoinSymbol)) return false;
  try {
    fromKucoinSymbol(kucoinSymbol);
    return true;
  } catch (_err) {
    return false;
  }
}

module.exports = {
  toKucoinSymbol,
  fromKucoinSymbol,
  isCanonicalUsdtPerp,
  isKucoinUsdtmPerp,
};
