# Phase A — Dashboard / Frontend Audit

## Critical

### 1. Unauthenticated Bot Control (LIVE only!)
- File: `src/dashboard.js:787-800` (LIVE)
- `/api/admin/sell-position` endpoint **has NO auth**.
- PAPER equivalent (`paper/src/dashboard.js:984`) properly uses `requireAdminToken`.
- **Impact:** Anyone on LAN / SSRF can force-sell any position.
- **Fix:** Backport `requireAdminToken` middleware. Cannot ship paper→live promotion until this is closed.

### 2. Admin Token in LocalStorage Unencrypted
- File: `public/dashboard.js:600-607`
- `dt.adminToken` stored plaintext in browser localStorage. XSS = full admin.
- **Fix:** Session-only sessionStorage with explicit TTL, or HttpOnly cookie via dedicated login endpoint.

### 3. Admin Token Prompt Has No Timeout
- File: `public/dashboard.js` (`promptAdminToken()`)
- Token never expires. Stale token persists indefinitely.
- **Fix:** Expire after N min idle; re-prompt before destructive actions.

## High

### 4. 24h PnL Computed Client-Side With Fallback
- Dashboard computes from `pnlHistory` array; falls back to `unrealizedPnl`.
- **Impact:** Computed differently than backend; UI shows phantom PnL when backend hasn't snapshotted yet.
- **Fix:** Backend exposes canonical `pnl24hUsd`; UI displays only.

### 5. Missing Timestamp on KPI Cards
- Total Balance, Invested, Total PnL no "fetched at" tag.
- **Fix:** Show age in seconds; gray out if >30s old.

### 6. Polling Rate Too Fast (5s) vs Status Lag (10-30s)
- Creates real-time illusion on stale data.
- **Fix:** Backend pushes `dataFreshnessMs`; UI tints stale.

### 7. Invested % Drift
- UI = `(exposureUsd / equity) * 100`; backend may differ.
- **Fix:** Backend canonical value; UI displays only.

### 8. Force-Sell Button: confirm() Only
- No "type YES to confirm" or 2FA. JS-injectable.
- **Fix:** Server requires token-bound confirmation phrase; frontend typed challenge.

## Medium

### 9. Chart CDN Fallback Soft-Fails
- unpkg + jsdelivr blocked → "chart unavailable" but trading UI usable on blind data.
- **Fix:** Bundle chart lib locally OR hard-disable trading UI when chart fails.

### 10. Risk Rules PATCH Accepts Arbitrary Severity
- Frontend form value not enum-validated server-side.
- **Fix:** Server validates `severity ∈ {block, warn, log}`; reject otherwise.

## Live ↔ Paper Drift
- LIVE missing `requireAdminToken` on sell-position. **Sync from paper.**
- Likely other admin endpoints diverge — full audit of `/api/admin/*` needed.

## Suggested Priorities
1. **#1** — close the unauth endpoint immediately. Single-line middleware patch.
2. **#2 + #3** — token hygiene.
3. **#4 + #7** — backend canonical values for PnL/exposure.
4. Audit ALL `/api/admin/*` for similar drift.
