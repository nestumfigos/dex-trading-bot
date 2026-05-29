#!/usr/bin/env node
'use strict';

// K2/K4 smoke test: pull candles via REST feed for BTCUSDT then open WS
// for 8s and verify mark-price ticks arrive. Logs counts + first sample.

const { createKucoinPublicPerpsFeed } = require('../src/market/kucoin-public-perps');
const { createKucoinPerpsWsConsumer } = require('../src/market/kucoin-perps-ws');

(async () => {
  const feed = createKucoinPublicPerpsFeed();
  console.log('[verify] requesting 50x 15m candles for BTCUSDT ...');
  const candles = await feed.getCompletedCandles('BTCUSDT', '15m', 50);
  console.log(`[verify] REST OK: ${candles.length} candles. sample last=`, candles[candles.length - 1]);

  console.log('[verify] opening WS, subscribing BTC/ETH/SOL ...');
  if (typeof WebSocket !== 'function') {
    console.error('[verify] global WebSocket missing — Node 18+ required (or install `ws`).');
    process.exit(1);
  }
  const ws = createKucoinPerpsWsConsumer();
  ws.subscribe(['BTCUSDT', 'ETHUSDT', 'SOLUSDT']);

  await new Promise((resolve) => setTimeout(resolve, 8000));
  console.log('[verify] WS status:', JSON.stringify(ws.getStatus()));
  for (const sym of ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']) {
    console.log(`[verify] latest ${sym}:`, ws.getLatest(sym));
  }
  ws.close();
  process.exit(0);
})().catch((err) => {
  console.error(`[verify] FAILED: ${err.message}`);
  process.exit(1);
});
