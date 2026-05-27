'use strict';

// B6P.live-flip: conditional live wire.
//
// Default: keep the guard stub so any accidental import in a misconfigured env
// throws NotImplementedError (preserves scaffold-guards.test.js behavior).
//
// Live: when PERPS_LIVE_ENABLED === 'true' AND BINANCE_PERPS_API_KEY + SECRET
// are present, export the real REST adapter. Operator promotes by setting
// these three env vars per PERPS_BOOTSTRAP D.14 canary plan.
//
// We refuse to load the live adapter unless BOTH the flag AND credentials are
// present — half-credentials would crash mid-trade.

const liveEnabled = process.env.PERPS_LIVE_ENABLED === 'true';
const apiKey = process.env.BINANCE_PERPS_API_KEY || '';
const apiSecret = process.env.BINANCE_PERPS_API_SECRET || '';

if (liveEnabled && apiKey && apiSecret) {
  // eslint-disable-next-line global-require
  const { createBinancePerpsRest } = require('./binance-perps-rest');
  module.exports = createBinancePerpsRest({
    apiKey,
    apiSecret,
    baseUrl: process.env.BINANCE_PERPS_BASE_URL || undefined,
    recvWindowMs: Number(process.env.BINANCE_PERPS_RECV_WINDOW_MS) || undefined,
  });
} else {
  // eslint-disable-next-line global-require
  const { guard } = require('../_not-implemented');
  module.exports = guard('exchanges/binance-perps.js live execution disabled until evidence gates pass');
  if (liveEnabled && (!apiKey || !apiSecret)) {
    // Loud diagnostic so the operator doesn't accidentally think live is on
    // when credentials are missing.
    // eslint-disable-next-line no-console
    console.warn('[binance-perps] PERPS_LIVE_ENABLED=true but BINANCE_PERPS_API_KEY/SECRET missing — staying in guard mode');
  }
}
