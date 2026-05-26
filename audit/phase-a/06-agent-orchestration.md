# Phase A — Agent Orchestration Audit

## Critical

### 1. Decision-Queue Race: Same Token Routed Twice
- File: `src/ai/decision-queue.js:146-242` (`pumpAiDecisionQueue`)
- Single `aiDecisionInFlightKey` string guard. Two enqueues of same token can overwrite at L234 without dedup. First completes, clears at L209, second runs immediately.
- **Impact:** Double AI calls, double signals, potential duplicate execution.
- **Fix:** `Set<cacheKey>` for in-flight tracking, or per-token semaphore.

### 2. Stale AI Decision Reuse Beyond TTL
- File: `src/ai/decision-queue.js:41-45` (`hasFreshAiDecision`)
- TTL only checked at cache-hit. Decision with `updatedAt` at TTL-edge can pass freshness by microseconds.
- **Impact:** Trades on stale market sentiment after regime shift.
- **Fix:** Apply safety margin (TTL * 0.9) on freshness comparison.

### 3. Hybrid Decision Silent Fallthrough on Null Deps
- File: `src/utils/hybrid-agent-orchestrator.js:138-159`
- When `registry`, `rlPolicyManager`, or `featureSnapshot` null, function silently continues, returns technical-only decision (L180-188).
- **Impact:** Degraded routing without log/flag — orchestrator silently drops ML/RL/sentiment weight.
- **Fix:** Explicit null-check guards; either early return or logged fallback mode.

## High

### 4. evaluation.details Mutation Without Merge
- File: `src/ai/intelligent-model-review.js:70-84, 161-193`
- Direct property assignment (`evaluation.details.hybridDecision = {...}`); no deep-merge. Reused objects across async chain overwrite prior fields (`aiReason`, `aiConfidence`).
- **Fix:** Immutable spread or explicit Object.assign of known keys.

### 5. AI Budget Runaway — No Daily/Hourly Cap
- File: `src/ai/decision-queue.js:20-22`; `token-decision-pipeline.js:131-176`
- No per-hour/per-day call limit. Only throttle is single in-flight semaphore.
- **Impact:** 100 tokens/cycle * 30s cycle → ~12k calls/day uncontrolled spend.
- **Fix:** Add `dailyAiCallsRemaining` counter; reject enqueue when exhausted.

### 6. Signal Cascade Without Sentiment Direction Check
- File: `src/utils/token-decision-pipeline.js:288-307`
- 2-of-3 cascade counts sentiment BUY only if `aggregateScore >= 0.55` but doesn't check `sentimentSignalStr === 'BUY'`. HOLD with 0.65 score counts as confirmation.
- **Fix:** Add explicit signal-string check alongside numeric threshold.

### 7. Hybrid Direct Entry Without RL Alignment
- File: `src/ai/intelligent-model-review.js:171-181`
- Hybrid promotion (`evaluation.signal = 'BUY'`) checks confidence >= minConfidence but doesn't verify RL & ML agree. Weak RL with high aggregate gets promoted.
- **Fix:** Require ≥2 of {ML, RL, sentiment} agree on BUY before promotion.

## Medium

### 8. Regime Adaptive Adjustments Applied With Stale Data
- File: `src/ai/intelligent-model-review.js:111-142, 99`
- Adjustments written even with thin price history (≥22 bars). Downstream consumes regardless.
- **Fix:** Tag `staleDataFlag`; skip application if regime confidence <0.7.

### 9. Telemetry Double-Approval in Rotation Path
- File: `src/utils/token-decision-pipeline.js:389, 493`
- Two `approvalDecisionId` calls when rotation succeeds; second overwrites first.
- **Fix:** Early return from rotation branch with first ID.

## Live ↔ Paper Drift

### 10. Bayesian Fusion: Paper-Only
- LIVE `hybrid-agent-orchestrator.js`: no Bayesian fusion.
- PAPER: fused = `aggregateScore 0.62 + bayesian.posterior 0.23 + bayesianNetwork.probability 0.15`.
- **Impact:** LIVE executes at 0.60 aggregate where paper requires 0.64 fused. Systematic confidence inflation in LIVE → ~2-4% higher false-positive rate.
- **Fix:** Port to LIVE or remove from paper (decide direction).

## Suggested Priorities
1. **#1 race + #5 budget cap** — immediate (cost + duplicate-trade risk).
2. #3 silent fallthrough + #10 bayesian parity — correctness.
3. #2 stale TTL + #6 sentiment direction + #7 RL alignment — signal-quality.
