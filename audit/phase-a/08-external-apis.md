# Phase A — External APIs / Integrations Audit

## Critical

### 1. CoinMarketCap API Key in Plaintext Header Logs
- File: `src/utils/coinmarketcap.js:21`
- API key plaintext in HTTP header; leaks to proxy logs.
- **Fix:** Vault key, redact `X-CMC_PRO_API_KEY` in any logger.

### 2. NVIDIA API Bearer Token Unredacted
- File: `src/utils/nvidia-ai.js:25`
- Authorization header logged; no request-tracing UUID.
- **Fix:** Strip `Authorization:` from logs, add request UUID.

### 3. Silent Failed Fetches Treated as Valid
- Files: `defillama.js`, `solscan.js`, `onchain.js`
- Network errors return null/[] indistinguishable from "no data".
- **Impact:** Bot trades blindly when data feed dead.
- **Fix:** Return `{ data, error, statusCode }` shape; treat error≠null as no-trade.

## High

### 4. No 429 Backoff
- Files: `coinpaprika`, `defillama`, `solscan`
- No exponential retry on rate limits; risks IP ban.
- **Fix:** 1s→60s backoff with jitter; detect HTTP 429.

### 5. X/Twitter Silent Fail
- File: `src/utils/x-sentiment.js:34`
- All errors → empty array; sentiment signal lost.
- **Fix:** Log error type; fallback to last-known sentiment with stale flag.

### 6. Python Sidecar Blocks Trading Loop
- File: `src/utils/python-sidecar.js:36`
- 12s timeout > 5s trading-loop tick. Sequential inference stalls bot.
- **Fix:** Reduce to 4s; JS fallback on timeout.

### 7. Jito Bundle Poll Infinite Loop
- File: `src/utils/jito-bundle.js:303`
- Stalls 30s+ if endpoint returns garbage.
- **Fix:** `maxAttempts=15`; make poll non-blocking task.

### 8. Merkle Relay Score Unvalidated
- File: `src/utils/merkle-bundle.js:85-112`
- Marks relay "ok" on HTTP success, not on bundle land.
- **Fix:** Cross-check `bundleStats` to confirm inclusion.

### 9. WebSocket Subs Lost Silently
- File: `src/discovery/ws-discovery.js:89-93`
- Reconnect ok but subscription may fail. New listings missed.
- **Fix:** Re-validate subs on reconnect; emit metric on resub success/fail.

## Medium

### 10. DeFiLlama Macro Errors Unlogged
- File: `src/utils/onchain-macro.js:74`
- Errors swallowed.
- **Fix:** Log URL+timestamp, return error flag.

### 11. CoinGecko False-Negative Cache
- File: `src/utils/coingecko.js:67`
- Failed searches cached 1h (too long).
- **Fix:** Reduce TTL to 5min for not-found.

## Suggested Priorities
1. **#1 + #2** — credential hygiene (security audit gate).
2. **#3 + #5** — silent data-blackouts that drive bad trades.
3. **#6 + #7** — anything that blocks trading loop.
