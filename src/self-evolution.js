'use strict';

const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');
const { execFile, execFileSync } = require('child_process');
const os = require('os');
const { redactSecretsInText } = require('./utils/redaction');
const MutationEngine = require('./mutation-engine');
const { canPromoteEvolutionPatch, loadThresholds } = require('./policy/preconditions');

class SelfEvolutionEngine {
  constructor({ config, logger, projectRoot, agentMemory = null, portfolio = null }) {
    this.config = config;
    this.logger = logger;
    this.projectRoot = projectRoot;
    this.agentMemory = agentMemory;
    this.portfolio = portfolio;
    this.dataDir = process.env.BOT_DATA_DIR || 'data';
    this.paperExperimentalMode = this.config.paperTrading && process.env.SELF_EVOLUTION_UNSAFE_EXPERIMENTAL === 'true';
    this.locked = false;
    this.lastRunAt = 0;
    this.historyPath = path.join(projectRoot, this.dataDir, 'self-evolution-history.jsonl');
    this.proposalsDir = path.join(projectRoot, this.dataDir, 'self-evolution-proposals');
    this.backupDir = path.join(projectRoot, this.dataDir, 'self-evolution-backups');
    this.pendingValidationsPath = path.join(projectRoot, this.dataDir, 'self-evolution-pending-validations.json');
    this.mutationEngine = new MutationEngine({ logger });
  }

  // Late-bind dependencies that are constructed after this engine in src/index.js.
  bindDependencies({ agentMemory, portfolio } = {}) {
    if (agentMemory && !this.agentMemory) this.agentMemory = agentMemory;
    if (portfolio && !this.portfolio) this.portfolio = portfolio;
  }

  // Snapshot the current performance metrics so we can compute the delta after a patch's
  // holdout window expires. Returns a small structured object.
  capturePerformanceSnapshot() {
    if (!this.portfolio || !this.portfolio.stats) {
      return { profitFactor: 0, winRate: 0, sampleSize: 0, capturedAt: Date.now() };
    }
    const stats = this.portfolio.stats || {};
    const wins = Number(stats.wins || 0);
    const losses = Number(stats.losses || 0);
    const closed = wins + losses;
    return {
      profitFactor: Number(stats.profitFactor || 0),
      winRate: closed > 0 ? (wins / closed) * 100 : 0,
      sampleSize: closed,
      capturedAt: Date.now(),
    };
  }

  async loadPendingValidations() {
    let raw;
    try {
      raw = await fs.readFile(this.pendingValidationsPath, 'utf8');
    } catch (err) {
      if (err && err.code === 'ENOENT') return [];
      log.warn(`[SelfEvolution] pending-validations read failed: ${err.message}`);
      return [];
    }
    try {
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch (err) {
      log.error(`[SelfEvolution] pending-validations CORRUPT JSON at ${this.pendingValidationsPath}: ${err.message}. Returning empty list — manual recovery required.`);
      return [];
    }
  }

  async savePendingValidations(arr) {
    await fs.mkdir(path.dirname(this.pendingValidationsPath), { recursive: true });
    await fs.writeFile(this.pendingValidationsPath, JSON.stringify(arr || [], null, 2), 'utf8');
  }

  // Process any pending post-apply validations whose holdout window has expired.
  // For each, capture the current metrics, compute deltas, and call agentMemory.
  async processPendingValidations() {
    if (!this.agentMemory || typeof this.agentMemory.recordEvolutionOutcome !== 'function') return;
    const pending = await this.loadPendingValidations();
    if (!pending.length) return;
    const stillPending = [];
    const now = Date.now();
    // TTL: auto-expire entries past 3× their holdout window. Past behavior left them
    // pending forever when the bot restarted mid-window, growing the queue unbounded.
    const ttlMultiplier = Number(this.config.selfEvolution?.pendingValidationTtlMultiplier || 3);
    for (const entry of pending) {
      const elapsedHours = (now - Number(entry.snapshotAt || 0)) / 3_600_000;
      const holdoutHours = Number(entry.holdoutWindowHours || 24);
      if (elapsedHours > holdoutHours * ttlMultiplier) {
        this.logger.warn(`[Evolution] Pending validation ${entry.patchId} expired after ${elapsedHours.toFixed(1)}h (TTL=${(holdoutHours * ttlMultiplier).toFixed(0)}h) — auto-dropping`);
        if (this.agentMemory?.recordEvolutionOutcome) {
          try {
            this.agentMemory.recordEvolutionOutcome({
              patchId: entry.patchId,
              patchType: entry.patchType,
              patchSummary: entry.summary,
              paramsChanged: entry.paramsChanged,
              pfBefore: entry.before?.profitFactor || 0,
              pfAfter: entry.before?.profitFactor || 0,
              wrBefore: entry.before?.winRate || 0,
              wrAfter: entry.before?.winRate || 0,
              sampleSizeBefore: entry.before?.sampleSize || 0,
              sampleSizeAfter: 0,
              holdoutWindowHours: holdoutHours,
              regimeFamily: entry.regimeFamily || 'unknown',
              verdict: 'expired_ttl',
            });
            await this.agentMemory.saveIfDirty?.();
          } catch (_) { /* best-effort */ }
        }
        continue;
      }
      if (elapsedHours < holdoutHours) {
        stillPending.push(entry);
        continue;
      }
      const after = this.capturePerformanceSnapshot();
      const wrDelta = (after.winRate || 0) - (entry.before?.winRate || 0);
      const pnlDelta = (after.pnlUsd || 0) - (entry.before?.pnlUsd || 0);
      const sampleDelta = Math.max(0, (after.sampleSize || 0) - (entry.before?.sampleSize || 0));
      // FAIL-CLOSED: if policy check throws, treat as DENY (not auto-allow).
      let policyVerdict = 'auto_denied_error';
      try {
        const { getPool } = require('./utils/sqlServer');
        const sqlPool = await getPool(this.logger).catch(() => null);
        const scope = String(process.env.BOT_PROFILE || 'global').toLowerCase();
        const thresholds = await loadThresholds({ sql: sqlPool, scope });
        const policy = canPromoteEvolutionPatch({
          winRate: after.winRate,
          pnlUsd: pnlDelta,
          samples: sampleDelta,
          causalDeltaWinRate: wrDelta,
        }, thresholds);
        policyVerdict = policy.allow ? 'auto' : 'auto_denied';
        if (!policy.allow) {
          this.logger.warn(`[Evolution/policy] DENY promote ${entry.patchId}: ${policy.reason}`);
        }
      } catch (err) {
        this.logger.error(`[Evolution/policy] check FAILED for ${entry.patchId}: ${err?.message || err} — fail-closed verdict=auto_denied_error`);
      }
      try {
        this.agentMemory.recordEvolutionOutcome({
          patchId: entry.patchId,
          patchType: entry.patchType,
          patchSummary: entry.summary,
          paramsChanged: entry.paramsChanged,
          pfBefore: entry.before?.profitFactor || 0,
          pfAfter: after.profitFactor,
          wrBefore: entry.before?.winRate || 0,
          wrAfter: after.winRate,
          sampleSizeBefore: entry.before?.sampleSize || 0,
          sampleSizeAfter: sampleDelta,
          holdoutWindowHours: holdoutHours,
          regimeFamily: entry.regimeFamily || 'unknown',
          verdict: policyVerdict,
        });
        await this.agentMemory.saveIfDirty?.();
        this.logger.info(`[Evolution] Validated patch ${entry.patchId}: pfΔ=${(after.profitFactor - (entry.before?.profitFactor || 0)).toFixed(2)} wrΔ=${(after.winRate - (entry.before?.winRate || 0)).toFixed(1)}pp`);
      } catch (err) {
        this.logger.warn(`[Evolution] Failed to record outcome for ${entry.patchId}: ${err.message}`);
      }
    }
    await this.savePendingValidations(stillPending);
  }

  async queuePendingValidation(plan, applyResult) {
    if (!this.agentMemory) return;
    const before = this.capturePerformanceSnapshot();
    const patchId = `evo-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const paramsChanged = (plan.changes || [])
      .filter((c) => c.type === 'env_set')
      .map((c) => ({ key: c.key, value: c.value }));
    const entry = {
      patchId,
      patchType: paramsChanged.length ? 'env_change' : 'code_change',
      summary: plan.summary || '',
      reason: plan.reason || '',
      paramsChanged,
      changedFiles: applyResult.changedFiles || [],
      changedEnvKeys: applyResult.changedEnvKeys || [],
      before,
      snapshotAt: Date.now(),
      holdoutWindowHours: Number(this.config.selfEvolution?.validationHoldoutHours || 24),
      regimeFamily: 'unknown',
    };
    const pending = await this.loadPendingValidations();
    pending.push(entry);
    // Also record the "applied" outcome immediately (with verdict=pending) so the
    // history is consistent. The follow-up validation overwrites with the real verdict.
    try {
      this.agentMemory.recordEvolutionOutcome({
        patchId,
        patchType: entry.patchType,
        patchSummary: entry.summary,
        paramsChanged,
        pfBefore: before.profitFactor,
        pfAfter: before.profitFactor,
        wrBefore: before.winRate,
        wrAfter: before.winRate,
        sampleSizeBefore: before.sampleSize,
        sampleSizeAfter: 0,
        holdoutWindowHours: entry.holdoutWindowHours,
        regimeFamily: 'unknown',
        verdict: 'pending',
      });
      await this.agentMemory.saveIfDirty?.();
    } catch (err) {
      this.logger.warn(`[Evolution] Failed to record initial pending outcome: ${err.message}`);
    }
    await this.savePendingValidations(pending);
    this.logger.info(`[Evolution] Queued post-apply validation for ${patchId} in ${entry.holdoutWindowHours}h`);
  }

  isFileAllowedForPlan(filePath) {
    if (!filePath || typeof filePath !== 'string') return false;
    const normalized = String(filePath).replace(/\\/g, '/');
    if (this.paperExperimentalMode) {
      return (
        (normalized.startsWith('src/') && normalized.endsWith('.js'))
        || (normalized.startsWith('config/') && normalized.endsWith('.js'))
      );
    }
    const allowedFiles = new Set([
      'config/index.js',
      'src/index.js',
      'src/dashboard.js',
      'src/utils/redaction.js',
      'src/agent/marketIntelligence.js',
      'src/strategy/index.js',
    ]);
    return allowedFiles.has(normalized);
  }

  isEnabled() {
    return this.config.selfEvolution?.enabled === true;
  }

  intervalMs() {
    const mins = Math.max(10, Number(this.config.selfEvolution?.intervalMinutes || 120));
    return mins * 60 * 1000;
  }

  getChangeFingerprint(plan = {}) {
    return JSON.stringify({
      summary: String(plan.summary || ''),
      reason: String(plan.reason || ''),
      changes: Array.isArray(plan.changes)
        ? plan.changes.map((change) => ({
          type: change?.type || '',
          file: change?.file || '',
          key: change?.key || '',
          value: change?.value || '',
          pattern: change?.pattern || '',
          replacement: change?.replacement || '',
        }))
        : [],
    });
  }

  async wasPlanRecentlyAttempted(plan, limit = 12) {
    try {
      const raw = await fs.readFile(this.historyPath, 'utf8');
      const lines = raw.trim().split('\n').filter(Boolean);
      const fingerprint = this.getChangeFingerprint(plan);
      for (const line of lines.slice(-limit).reverse()) {
        try {
          const entry = JSON.parse(line);
          if (this.getChangeFingerprint(entry) === fingerprint) {
            return true;
          }
        } catch (_) {
          // Ignore malformed history lines.
        }
      }
    } catch (_) {
      // Ignore missing history.
    }
    return false;
  }

  buildLineScopedRegex(pattern) {
    return new RegExp(`^\\s*${pattern}\\s*$`, 'gm');
  }

  applyLineScopedReplacement(source, change) {
    const lineRegex = this.buildLineScopedRegex(change.pattern);
    const matches = Array.from(source.matchAll(lineRegex));
    if (matches.length === 0) {
      return { ok: false, reason: `Pattern not found for ${change.file}` };
    }
    if (matches.length > 1) {
      return { ok: false, reason: `Pattern match count for ${change.file} was ${matches.length}, expected 1` };
    }

    const matchedLine = matches[0][0];
    const indent = (matchedLine.match(/^\s*/) || [''])[0];
    const replacementLine = `${indent}${String(change.replacement).trimStart()}`;
    const nextSource = source.replace(lineRegex, replacementLine);
    if (nextSource === source) {
      return { ok: false, reason: `No-op replacement for ${change.file}` };
    }
    return { ok: true, nextSource };
  }

  applyStructuredChange(source, change) {
    const normalized = this.mutationEngine.normalizeChange(change) || change;
    if (normalized.type === 'exact_line_replace' && normalized.oldLine) {
      return this.mutationEngine.applyExactLineReplace(source, {
        ...normalized,
        newLine: normalized.newLine || normalized.replacement,
      });
    }
    if (normalized.type === 'template_replace') {
      return this.mutationEngine.applyTemplateReplace(source, normalized);
    }
    return this.applyLineScopedReplacement(source, normalized);
  }

  async runCycle(context = {}) {
    if (!this.isEnabled()) return { skipped: true, reason: 'disabled' };
    const now = Date.now();
    if (this.locked) return { skipped: true, reason: 'locked' };
    if (this.lastRunAt > 0 && now - this.lastRunAt < this.intervalMs()) {
      return { skipped: true, reason: 'interval' };
    }

    this.locked = true;
    this.lastRunAt = now;
    // Process any patches whose holdout window has elapsed before running new cycles.
    // This is what closes the causal loop — we evaluate "did the previous patch help?"
    await this.processPendingValidations().catch((err) => this.logger.warn(`pending validation err: ${err.message}`));

    // Pause self-evolution if recent patches have been net-regressive (causal guardrail).
    if (this.agentMemory && typeof this.agentMemory.shouldPauseEvolution === 'function') {
      const pauseCheck = this.agentMemory.shouldPauseEvolution();
      if (pauseCheck.paused) {
        this.logger.warn(`[Evolution] Pausing this cycle — ${pauseCheck.reason}`);
        await this.recordHistory({ status: 'paused', reason: pauseCheck.reason });
        this.locked = false;
        return { skipped: true, reason: pauseCheck.reason };
      }
    }

    try {
      // Try AI-driven plan first (richer, uses intelligence context)
      let plan = await this.buildAIDrivenPlan(context);

      // If AI plan has no changes, fall through to rule-based
      if (!plan || !plan.changes.length) {
        plan = await this.buildRuleBasedPlan(context);
      }
      if (!plan.changes.length) {
        await this.recordHistory({
          status: 'noop',
          reason: plan.reason || 'no-op',
          summary: plan.summary || 'No safe self-improvements identified',
        });
        return { applied: false, plan };
      }

      if (await this.wasPlanRecentlyAttempted(plan)) {
        await this.recordHistory({
          status: 'skipped_duplicate',
          reason: 'Equivalent self-evolution plan was attempted recently',
          summary: plan.summary || 'Duplicate self-improvement proposal',
          changes: plan.changes,
        });
        return { applied: false, skipped: 'duplicate_plan', plan };
      }

      await fs.mkdir(this.proposalsDir, { recursive: true });
      const proposalPath = path.join(this.proposalsDir, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
      await fs.writeFile(proposalPath, JSON.stringify(plan, null, 2), 'utf8');

      if (this.config.selfEvolution?.autoApply !== true) {
        this.logger.warn(`Self-evolution generated proposal (autoApply=false): ${proposalPath}`);
        await this.recordHistory({
          status: 'proposed',
          summary: plan.summary,
          reason: plan.reason || null,
          proposalPath,
          changes: plan.changes,
        });
        return { applied: false, proposed: true, proposalPath, plan };
      }

      if (!this.config.paperTrading && this.config.selfEvolution?.allowLiveApply !== true) {
        this.logger.warn('Self-evolution skipped apply in live mode (SELF_EVOLUTION_ALLOW_LIVE_APPLY not true)');
        await this.recordHistory({
          status: 'blocked_live_mode',
          summary: plan.summary,
          proposalPath,
          changes: plan.changes,
        });
        return { applied: false, blocked: 'live_mode', proposalPath, plan };
      }

      const applyResult = await this.applyPlan(plan);
      await this.recordHistory({
        status: applyResult.ok ? 'applied' : 'failed',
        summary: plan.summary,
        reason: applyResult.reason || null,
        proposalPath,
        changes: plan.changes,
      });
      // If we successfully applied a patch, queue the post-apply validation so we can
      // record a causal verdict (improved/regressed/inconclusive) once the holdout window expires.
      if (applyResult.ok) {
        await this.queuePendingValidation(plan, applyResult).catch((err) =>
          this.logger.warn(`[Evolution] queue validation failed: ${err.message}`)
        );
      }
      return { applied: applyResult.ok, proposalPath, plan, reason: applyResult.reason || null, applyResult };
    } catch (error) {
      await this.recordHistory({
        status: 'error',
        reason: error.message,
      });
      this.logger.error(`Self-evolution cycle failed: ${error.message}`);
      return { applied: false, error: error.message };
    } finally {
      this.locked = false;
    }
  }

  async buildRuleBasedPlan(context = {}) {
    const stats = context.stats || {};
    const closedTrades = Number(stats.closedTrades || 0);
    const winRate = closedTrades > 0 ? (Number(stats.wins || 0) / closedTrades) * 100 : 0;
    const profitFactor = Number(stats.profitFactor || 0);
    const avgLoss = Number(stats.avgLossUsd || 0);
    const avgWin = Number(stats.avgWinUsd || 0);
    const latestFilterCycles = Array.isArray(context.latestFilterCycles) ? context.latestFilterCycles : [];
    const ops = context.operationalDiagnostics || {};

    const plan = {
      summary: 'Rule-based self-evolution proposal',
      reason: '',
      generatedAt: new Date().toISOString(),
      changes: [],
    };

    // ── OPERATIONAL ISSUES (bypass closed-trades gate) ──────────────────────

    // 1. Slot starvation: too many buys blocked by position cap
    if (ops.slotBlockedCount >= 10) {
      const current = Number(ops.maxConcurrentPositions || 5);
      const proposed = Math.min(current + 3, 15);
      plan.reason = `Slot starvation: ${ops.slotBlockedCount} buy attempts blocked by position cap (current: ${current})`;
      plan.summary = `Increase MAX_CONCURRENT_POSITIONS from ${current} to ${proposed} to allow more trades`;
      plan.changes.push({
        type: 'env_set',
        key: 'MAX_CONCURRENT_POSITIONS',
        value: String(proposed),
        rationale: plan.reason,
      });
      // Also raise per-strategy limits
      plan.changes.push({
        type: 'env_set',
        key: 'MOMENTUM_MAX_CONCURRENT_POSITIONS',
        value: String(Math.min(proposed - 2, 12)),
        rationale: 'Raise momentum strategy cap alongside global cap',
      });
      return plan;
    }

    // 2. Chain monopoly: one chain holds ≥80% of slots across last 5 snapshots
    if (ops.chainConcentration) {
      const totalSlots = Number(ops.maxConcurrentPositions || 5);
      for (const [chain, maxCount] of Object.entries(ops.chainConcentration)) {
        if (maxCount / totalSlots >= 0.8 && chain === 'kucoin') {
          const currentHeat = 95; // default before any cap
          const proposedHeat = 60;
          plan.reason = `Chain monopoly: ${chain} holds ${maxCount}/${totalSlots} slots (${((maxCount/totalSlots)*100).toFixed(0)}%)`;
          plan.summary = `Cap KuCoin heat allowance to ${proposedHeat}% to give other chains room`;
          plan.changes.push({
            type: 'env_set',
            key: 'KUCOIN_MOMENTUM_HEAT_ALLOWANCE_PCT',
            value: String(proposedHeat),
            rationale: plan.reason,
          });
          plan.changes.push({
            type: 'env_set',
            key: 'KUCOIN_SWING_HEAT_ALLOWANCE_PCT',
            value: String(proposedHeat - 10),
            rationale: 'Cap swing allowance too',
          });
          return plan;
        }
      }
    }

    // 3. Native price aborts: BSC buys consistently fail due to stale price cache
    if (ops.nativePriceAbortCount >= 5) {
      plan.reason = `Native price stale: ${ops.nativePriceAbortCount} BSC/Base buys aborted due to missing BNB/ETH price cache`;
      plan.summary = 'Increase native price max age to reduce spurious aborts';
      plan.changes.push({
        type: 'regex_replace_once',
        file: 'config/index.js',
        pattern: "maxNativePriceAgeMs: parseInt\\(process\\.env\\.MAX_NATIVE_PRICE_AGE_MS \\|\\| '[0-9]+'\\)",
        replacement: "maxNativePriceAgeMs: parseInt(process.env.MAX_NATIVE_PRICE_AGE_MS || '300000')",
        rationale: plan.reason,
      });
      return plan;
    }

    // 4. Per-chain daily loss limit repeatedly blocking buys
    if (ops.dailyLossBlockCount >= 8) {
      const currentLimits = ops.maxDailyLossPctByChain || {};
      const currentBsc = Number(currentLimits.bsc || 10);
      const proposedBsc = Math.min(currentBsc + 10, 40);
      plan.reason = `Daily loss gate: ${ops.dailyLossBlockCount} buys blocked by per-chain daily loss limits`;
      plan.summary = `Widen BSC daily loss limit from ${currentBsc}% to ${proposedBsc}%`;
      const newLimits = { ...currentLimits, bsc: proposedBsc };
      plan.changes.push({
        type: 'env_set',
        key: 'MAX_DAILY_LOSS_PCT_BY_CHAIN',
        value: JSON.stringify(newLimits),
        rationale: plan.reason,
      });
      return plan;
    }

    // ── PERFORMANCE ISSUES (require closed trades) ───────────────────────────

    const technicalStarvationCycles = latestFilterCycles
      .filter((cycle) => Number(cycle?.evaluated || 0) > 0)
      .filter((cycle) => {
        const evaluated = Number(cycle?.evaluated || 0);
        const passed = Number(cycle?.passed || 0);
        const technicalBlocked = Number(cycle?.technicalBlocked || 0);
        return passed === 0 && evaluated > 0 && (technicalBlocked / evaluated) >= 0.75;
      });

    if (technicalStarvationCycles.length >= 2) {
      plan.reason = 'Detected technical-entry starvation (high technicalBlocked, zero passed)';
      plan.summary = 'Auto-unblock adaptation: relax entry thresholds and require gate diagnostics';
      plan.changes.push(
        {
          type: 'regex_replace_once',
          file: 'config/index.js',
          pattern: "rsiBuyThreshold: parseFloat\\(process\\.env\\.MOMENTUM_RSI_BUY_THRESHOLD \\|\\| '[0-9.]+'\\),",
          replacement: "rsiBuyThreshold: parseFloat(process.env.MOMENTUM_RSI_BUY_THRESHOLD || '40'),",
        },
        {
          type: 'regex_replace_once',
          file: 'config/index.js',
          pattern: "rsiBuyMaxThreshold: parseFloat\\(process\\.env\\.MOMENTUM_RSI_BUY_MAX_THRESHOLD \\|\\| '[0-9.]+'\\),",
          replacement: "rsiBuyMaxThreshold: parseFloat(process.env.MOMENTUM_RSI_BUY_MAX_THRESHOLD || '75'),",
        },
        {
          type: 'regex_replace_once',
          file: 'config/index.js',
          pattern: "volumeSpikeMultiplier: parseFloat\\(process\\.env\\.MOMENTUM_VOLUME_SPIKE_MULTIPLIER \\|\\| '[0-9.]+'\\),",
          replacement: "volumeSpikeMultiplier: parseFloat(process.env.MOMENTUM_VOLUME_SPIKE_MULTIPLIER || '1.35'),",
        },
        {
          type: 'regex_replace_once',
          file: 'config/index.js',
          pattern: "minPriceChange24hPctAll: parseFloat\\(process\\.env\\.MOMENTUM_MIN_PRICE_CHANGE_24H_PCT_ALL \\|\\| '[0-9.]+'\\),",
          replacement: "minPriceChange24hPctAll: parseFloat(process.env.MOMENTUM_MIN_PRICE_CHANGE_24H_PCT_ALL || '1.5'),",
        },
        {
          type: 'regex_replace_once',
          file: 'config/index.js',
          pattern: "rsiBuyThreshold: parseFloat\\(process\\.env\\.SWING_RSI_BUY_THRESHOLD \\|\\| '[0-9.]+'\\),",
          replacement: "rsiBuyThreshold: parseFloat(process.env.SWING_RSI_BUY_THRESHOLD || '35'),",
        },
        {
          type: 'regex_replace_once',
          file: 'config/index.js',
          pattern: "volumeSpikeMultiplier: parseFloat\\(process\\.env\\.SWING_VOLUME_SPIKE_MULTIPLIER \\|\\| '[0-9.]+'\\),",
          replacement: "volumeSpikeMultiplier: parseFloat(process.env.SWING_VOLUME_SPIKE_MULTIPLIER || '1.05'),",
        }
      );
      return plan;
    }

    if (closedTrades < Math.max(6, Number(this.config.selfEvolution?.minClosedTrades || 12))) {
      plan.reason = `Not enough closed trades (${closedTrades}) for safe adaptation`;
      return plan;
    }

    if (profitFactor < 0.9 || winRate < 40) {
      plan.reason = `Defensive adaptation (profitFactor=${profitFactor.toFixed(2)}, winRate=${winRate.toFixed(1)}%)`;
      plan.summary = 'Defensive adaptation to reduce downside and bad fills';
      plan.changes.push(
        {
          type: 'regex_replace_once',
          file: 'config/index.js',
          pattern: "bscMinFillPctOfExpected: parseFloat\\(process\\.env\\.BSC_MIN_FILL_PCT_OF_EXPECTED \\|\\| '[0-9.]+'\\),",
          replacement: "bscMinFillPctOfExpected: parseFloat(process.env.BSC_MIN_FILL_PCT_OF_EXPECTED || '97'),",
        },
        {
          type: 'regex_replace_once',
          file: 'config/index.js',
          pattern: "bscExplorationPositionSizeMultiplier: parseFloat\\(process\\.env\\.BSC_EXPLORATION_POSITION_SIZE_MULTIPLIER \\|\\| '[0-9.]+'\\),",
          replacement: "bscExplorationPositionSizeMultiplier: parseFloat(process.env.BSC_EXPLORATION_POSITION_SIZE_MULTIPLIER || '0.75'),",
        }
      );

      if (avgWin > 0 && avgLoss > (avgWin * 3)) {
        plan.changes.push({
          type: 'regex_replace_once',
          file: 'src/index.js',
          pattern: "if \\(calculatedSizeUsd < [0-9.]+\\) \\{",
          replacement: "if (calculatedSizeUsd < 6) {",
        });
      }
      return plan;
    }

    if (profitFactor > 1.35 && winRate > 58) {
      plan.reason = `Constructive adaptation (profitFactor=${profitFactor.toFixed(2)}, winRate=${winRate.toFixed(1)}%)`;
      plan.summary = 'Constructive adaptation to responsibly increase opportunity capture';
      plan.changes.push({
        type: 'regex_replace_once',
        file: 'config/index.js',
        pattern: "adaptiveSizingBoostMultiplier: parseFloat\\(process\\.env\\.ADAPTIVE_SIZING_BOOST_MULTIPLIER \\|\\| '[0-9.]+'\\),",
        replacement: "adaptiveSizingBoostMultiplier: parseFloat(process.env.ADAPTIVE_SIZING_BOOST_MULTIPLIER || '1.08'),",
      });
      return plan;
    }

    plan.reason = 'Current performance in neutral band; no safe mutation required';
    return plan;
  }

  async applyPlan(plan) {
    const backupStamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupRoot = path.join(this.backupDir, backupStamp);
    await fs.mkdir(backupRoot, { recursive: true });

    const touched = [];
    const changedFiles = [];
    const changedEnvKeys = [];
    try {
      for (const change of plan.changes) {
        if (change.type === 'env_set') {
          // Write or update a key=value line in .env
          const envPath = path.join(this.projectRoot, '.env');
          if (!this.isAllowedEnvKey(change.key)) {
            return { ok: false, reason: `Blocked unsafe .env key: ${change.key}` };
          }
          const before = await fs.readFile(envPath, 'utf8').catch(() => '');
          const backupPath = path.join(backupRoot, '__env');
          await fs.writeFile(backupPath, before, 'utf8');
          const keyPattern = new RegExp(`^(${change.key}\\s*=.*)$`, 'm');
          let after;
          if (keyPattern.test(before)) {
            after = before.replace(keyPattern, `${change.key}=${change.value}`);
          } else {
            after = before.trimEnd() + `\n${change.key}=${change.value}\n`;
          }
          if (after === before) {
            this.logger.info(`[Evolution] .env key ${change.key} already set to ${change.value} — skipping`);
            continue;
          }
          await fs.writeFile(envPath, after, 'utf8');
          touched.push({ targetPath: envPath, backupPath });
          changedEnvKeys.push(String(change.key));
          this.logger.warn(`[Evolution] .env updated: ${change.key}=${change.value}`);
          continue;
        }

        if (!['regex_replace_once', 'exact_line_replace', 'template_replace'].includes(change.type)) continue;
        const targetPath = path.join(this.projectRoot, change.file);
        if (!this.isAllowedTarget(targetPath)) {
          return { ok: false, reason: `Blocked unsafe target: ${change.file}` };
        }

        const before = await fs.readFile(targetPath, 'utf8');
        const replaceResult = this.applyStructuredChange(before, change);
        if (!replaceResult.ok) {
          return { ok: false, reason: replaceResult.reason };
        }
        const after = replaceResult.nextSource;

        // Syntax-validate `after` BEFORE writing. Bad mutations must not reach disk.
        if (String(change.file).endsWith('.js')) {
          const tmpCheckPath = path.join(backupRoot, `__syntaxcheck__${change.file.replace(/[\\/]/g, '__')}`);
          await fs.writeFile(tmpCheckPath, after, 'utf8');
          const syntaxResult = await new Promise((resolve) => {
            execFile(process.execPath, ['--check', tmpCheckPath], { timeout: 10000 }, (err, _stdout, stderr) => {
              resolve({ ok: !err, stderr: String(stderr || '') });
            });
          });
          await fs.unlink(tmpCheckPath).catch(() => {});
          if (!syntaxResult.ok) {
            return { ok: false, reason: `Syntax check failed for ${change.file}: ${syntaxResult.stderr.slice(0, 500)}` };
          }
        }

        const backupPath = path.join(backupRoot, change.file.replace(/[\\/]/g, '__'));
        await fs.writeFile(backupPath, before, 'utf8');
        await fs.writeFile(targetPath, after, 'utf8');
        touched.push({ targetPath, backupPath });
        changedFiles.push(String(change.file).replace(/\\/g, '/'));
      }

      this.logger.warn(`Self-evolution applied ${touched.length} change(s). Restart required to load new code/config.`);
      await this._pruneOldBackups(10).catch((err) => this.logger.debug(`[Evolution] backup prune failed: ${err.message}`));
      return { ok: true, backupRoot, changedFiles, changedEnvKeys, touched };
    } catch (error) {
      for (const file of touched.reverse()) {
        try {
          const backup = await fs.readFile(file.backupPath, 'utf8');
          await fs.writeFile(file.targetPath, backup, 'utf8');
        } catch (_) {
          // best-effort rollback
        }
      }
      return { ok: false, reason: error.message };
    }
  }

  async _pruneOldBackups(keep = 10) {
    let entries;
    try {
      entries = await fs.readdir(this.backupDir, { withFileTypes: true });
    } catch (err) {
      if (err.code === 'ENOENT') return;
      throw err;
    }
    const dirs = entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    const toDelete = dirs.slice(0, Math.max(0, dirs.length - keep));
    for (const name of toDelete) {
      await fs.rm(path.join(this.backupDir, name), { recursive: true, force: true }).catch(() => {});
    }
    if (toDelete.length > 0) {
      this.logger.info(`[Evolution] Pruned ${toDelete.length} old backup(s), kept newest ${Math.min(keep, dirs.length)}`);
    }
  }

  async rollbackPlan(backupRoot, touchedEntries = []) {
    if (!backupRoot) return { ok: false, reason: 'missing backup root' };
    try {
      for (const entry of [...touchedEntries].reverse()) {
        const backup = await fs.readFile(entry.backupPath, 'utf8');
        await fs.writeFile(entry.targetPath, backup, 'utf8');
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: error.message };
    }
  }

  isAllowedTarget(absPath) {
    const rel = path.relative(this.projectRoot, absPath).replace(/\\/g, '/');
    if (rel === 'config/index.js') return true;
    if (rel.startsWith('src/') && rel.endsWith('.js')) return true;
    return false;
  }
  isAllowedEnvKey(key) {
    if (!key || typeof key !== 'string') return false;
    // Whitelist of env keys self-evolution is allowed to set
    const allowed = new Set([
      'MAX_CONCURRENT_POSITIONS',
      'MOMENTUM_MAX_CONCURRENT_POSITIONS',
      'SWING_MAX_CONCURRENT_POSITIONS',
      'KUCOIN_MOMENTUM_HEAT_ALLOWANCE_PCT',
      'KUCOIN_SWING_HEAT_ALLOWANCE_PCT',
      'MAX_DAILY_LOSS_PCT_BY_CHAIN',
      'MIN_LIQUIDITY_USD_BY_CHAIN',
      'STRATEGY_MOMENTUM_RSI_BUY_MIN',
      'STRATEGY_MOMENTUM_RSI_BUY_MAX',
      'STRATEGY_SWING_RSI_BUY_MIN',
      'STRATEGY_SWING_RSI_BUY_MAX',
      'STRATEGY_MOMENTUM_VOLUME_SPIKE',
      'STRATEGY_SWING_VOLUME_SPIKE',
      'STRATEGY_MOMENTUM_MIN_NET_BUY_FLOW',
      'STRATEGY_MOMENTUM_MIN_BUY_RATIO_PCT_10M',
      'BSC_MIN_LIQUIDITY_USD',
      'MAX_CONSECUTIVE_LOSSES',
    ]);
    return allowed.has(String(key));
  }
  /**
   * AI-driven plan: uses Groq to reason about the bot's state, market intelligence,
   * and performance — then generates concrete regex-replace patches to improve itself.
   */
  async buildAIDrivenPlan(context = {}) {
    const empty = { changes: [], summary: '', reason: '' };

    const stats = context.stats || {};
    const ops = context.operationalDiagnostics || {};
    const closedTrades = Number(stats.closedTrades || 0);

    // Skip performance-based AI analysis when no trades, but still allow if there are
    // significant operational issues the AI should weigh in on.
    const hasOperationalIssues = (ops.slotBlockedCount || 0) >= 5 || (ops.nativePriceAbortCount || 0) >= 3 || (ops.dailyLossBlockCount || 0) >= 5;
    if (closedTrades < Math.max(6, Number(this.config.selfEvolution?.minClosedTrades || 12)) && !hasOperationalIssues) return empty;

    // Read current config/index.js for AI context
    let configSnippet = '';
    try {
      const configPath = path.join(this.projectRoot, 'config', 'index.js');
      const raw = await fs.readFile(configPath, 'utf8');
      // Extract the strategies section (first 200 lines are usually the strategy config)
      configSnippet = raw.split('\n').slice(0, 220).join('\n');
    } catch (_) { /* best effort */ }

    const memory = context.memory || null;
    const intelligence = context.intelligence || null;
    const memoryBlock = memory
      ? `AGENT LONG-TERM MEMORY:
  - Trade lessons (recent losses/wins): ${JSON.stringify((memory.recentLessons || []).slice(0, 5), null, 2)}
  - Strategy discoveries pending: ${JSON.stringify((memory.pendingDiscoveries || []).slice(0, 3), null, 2)}
  - Blacklisted tokens: ${(memory.blacklistedTokens || []).join(', ') || 'none'}
  - Evolution outcomes: improved=${memory.evolutionSummary?.improved || 0} regressed=${memory.evolutionSummary?.regressed || 0} neutral=${memory.evolutionSummary?.neutral || 0}`
      : 'AGENT MEMORY: not yet available';

    const intelligenceBlock = intelligence
      ? `MARKET INTELLIGENCE (from live internet analysis):
  - Macro sentiment: ${intelligence.macroSentiment} (score: ${intelligence.sentimentScore}/100)
  - Hot sectors: ${(intelligence.hotSectors || []).join(', ') || 'none'}
  - Cold sectors: ${(intelligence.coldSectors || []).join(', ') || 'none'}
  - Narrative themes: ${(intelligence.narrativeThemes || []).join(', ') || 'none'}
  - Strategy recommendation: ${intelligence.strategyRecommendation?.preferredType || 'both'} / ${intelligence.strategyRecommendation?.aggressiveness || 'normal'}
  - Risk warnings: ${(intelligence.riskWarnings || []).join('; ') || 'none'}
  - Self-improvement insights from AI reading the market:
${(intelligence.selfImprovementInsights || []).map((i) => `    [${i.urgency.toUpperCase()}] ${i.observation} → ${i.suggestedAction}`).join('\n') || '    none'}`
      : 'MARKET INTELLIGENCE: not yet available';

    const prompt = `You are a senior quant engineer and autonomous trading agent. You have full write access to your own source code and a persistent memory of past mistakes and discoveries.

  ${memoryBlock}

  PERFORMANCE STATS:
  - Closed trades: ${closedTrades}
  - Win rate: ${closedTrades > 0 ? ((stats.wins || 0) / closedTrades * 100).toFixed(1) : 0}%
  - Profit factor: ${Number(stats.profitFactor || 0).toFixed(3)}
  - Avg win: $${Number(stats.avgWinUsd || 0).toFixed(2)} | Avg loss: $${Number(stats.avgLossUsd || 0).toFixed(2)}
  - Consecutive losses: ${stats.consecutiveLosses || 0}
  - Consecutive wins: ${stats.consecutiveWins || 0}
  - Open positions: ${context.openPositions || 0}

${intelligenceBlock}

OPERATIONAL DIAGNOSTICS (execution-phase failures since last reset):
${JSON.stringify({
  slotBlockedCount: ops?.slotBlockedCount || 0,
  nativePriceAbortCount: ops?.nativePriceAbortCount || 0,
  dailyLossBlockCount: ops?.dailyLossBlockCount || 0,
  chainConcentration: ops?.chainConcentration || {},
  maxConcurrentPositions: ops?.maxConcurrentPositions,
  maxDailyLossPctByChain: ops?.maxDailyLossPctByChain || {},
  uptimeHours: ((ops?.uptimeMs || 0) / 3600000).toFixed(1),
}, null, 2)}
NOTE: To fix operational issues you may also use "env_set" change type: { "type": "env_set", "key": "MAX_CONCURRENT_POSITIONS", "value": "12", "rationale": "..." }
Allowed env keys: MAX_CONCURRENT_POSITIONS, MOMENTUM_MAX_CONCURRENT_POSITIONS, SWING_MAX_CONCURRENT_POSITIONS, KUCOIN_MOMENTUM_HEAT_ALLOWANCE_PCT, KUCOIN_SWING_HEAT_ALLOWANCE_PCT, MAX_DAILY_LOSS_PCT_BY_CHAIN, MIN_LIQUIDITY_USD_BY_CHAIN, STRATEGY_MOMENTUM_RSI_BUY_MIN, STRATEGY_MOMENTUM_RSI_BUY_MAX, STRATEGY_SWING_RSI_BUY_MIN, STRATEGY_SWING_RSI_BUY_MAX, STRATEGY_MOMENTUM_VOLUME_SPIKE, STRATEGY_SWING_VOLUME_SPIKE, MAX_CONSECUTIVE_LOSSES.

LATEST FILTER CYCLES (for gate diagnostics):
${JSON.stringify((context.latestFilterCycles || []).slice(0, 6).map((c) => ({
  strategy: c.strategy,
  evaluated: c.evaluated,
  passed: c.passed,
  technicalBlocked: c.technicalBlocked,
  aiBlocked: c.aiBlocked,
  gateRejectCounts: c.gateRejectCounts || {},
})), null, 2)}

CURRENT CONFIG EXCERPT (config/index.js):
\`\`\`js
${configSnippet.slice(0, 3000)}
\`\`\`

RECENT TRADES (last 10):
${JSON.stringify((context.recentTrades || []).slice(0, 10).map((t) => ({
  symbol: t.symbol,
  chain: t.chain,
  pnl: t.pnl,
  strategy: t.strategy,
  reason: t.reason,
})), null, 2)}

Your task: Reason about the bot's full context — performance, market intelligence, AND memory of past mistakes — and generate up to 3 targeted code improvements.

Rules for patches:
- Target files: ${this.paperExperimentalMode ? 'any src/*.js or config/*.js file (paper experimental mode)' : 'config/index.js, src/index.js, src/dashboard.js, src/agent/marketIntelligence.js, src/strategy/index.js'}
- Prefer structured changes. Allowed change types:
  1. "env_set" with { "type": "env_set", "key": "...", "value": "...", "rationale": "..." }
  2. "exact_line_replace" with { "type": "exact_line_replace", "file": "...", "oldLine": "exact current line", "replacement": "exact new line", "rationale": "..." }
  3. "regex_replace_once" only as fallback when exact_line_replace is not practical
- Pattern or oldLine must be unambiguous (match exactly one place in the target file)
- Apply lessons from memory: if a pattern of losses is identified, tighten that specific filter
- Apply discoveries: if intelligence suggests a hot sector, consider boosting relevant thresholds
- If latest cycles show passed=0 with dominant technicalBlocked, prioritize unblocking entries by adapting momentum/swing thresholds in config/index.js.
- Ensure diagnostics are rich: if src/index.js lacks per-gate percentages, add/keep gateRejectPct logging.
- Prevent secret leakage: if any debug output logs full provider config objects, patch to use src/utils/redaction.js and avoid raw apiKey output.
- Prefer defensive changes when PF < 0.5, aggressive when PF > 1.5
- Changes are sandbox-validated with node --check before applying — complex changes are safe

Return ONLY valid JSON:
{
  "reasoning": "2-3 sentences explaining your analysis",
  "changes": [
    {
      "type": "exact_line_replace",
      "file": "config/index.js",
      "rationale": "why this change",
      "oldLine": "exact current line",
      "replacement": "new line replacing it"
    }
  ]
}

If no safe changes are needed, return: { "reasoning": "...", "changes": [] }`;

    const maxRetries = 3;

    // Helper: call one provider endpoint and return parsed plan or null
    const callProvider = async (providerName, postFn) => {
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          const text = await postFn();
          if (!text) return null;
          const jsonMatch = text.match(/\{[\s\S]*\}/);
          if (!jsonMatch) return null;
          const parsed = JSON.parse(jsonMatch[0]);
          this.logger.info(`[Evolution/AI] Reasoning (${providerName}): ${parsed.reasoning || '(none)'}`);
          if (!Array.isArray(parsed.changes) || parsed.changes.length === 0) {
            return { ...empty, reason: `AI reasoning complete: ${parsed.reasoning || 'no changes needed'}` };
          }
          const changes = [];
          for (const c of parsed.changes.slice(0, 3)) {
            // Handle env_set changes — validate key is whitelisted
            if (c.type === 'env_set') {
              if (!c.key || !c.value) continue;
              if (!this.isAllowedEnvKey(String(c.key))) {
                this.logger.warn(`[Evolution/AI] Blocked env_set for non-whitelisted key: ${c.key}`);
                continue;
              }
              changes.push({
                type: 'env_set',
                key: String(c.key),
                value: String(c.value),
                rationale: String(c.rationale || '').slice(0, 200),
              });
              continue;
            }

            if ((!c.pattern && !c.oldLine) || !c.replacement || !c.file) continue;
            const filePath = String(c.file).replace(/\\/g, '/');
            if (!this.isFileAllowedForPlan(filePath)) continue;
            // Sandbox validation: apply patch to temp file and run node --check
            const absPath = path.join(this.projectRoot, filePath);
            let valid = true;
            try {
              const original = await fs.readFile(absPath, 'utf8');
              const patched = this.applyStructuredChange(original, {
                type: c.type || (c.oldLine ? 'exact_line_replace' : 'regex_replace_once'),
                file: filePath,
                oldLine: c.oldLine,
                pattern: c.pattern,
                replacement: String(c.replacement),
              }).nextSource;
              if (patched === original) continue; // pattern didn't match — skip
              const tmpPath = path.join(os.tmpdir(), `evo-check-${Date.now()}.js`);
              await fs.writeFile(tmpPath, patched, 'utf8');
              await new Promise((resolve) => {
                execFile(process.execPath, ['--check', tmpPath], { timeout: 8000 }, (err) => {
                  if (err) { valid = false; this.logger.warn(`[Evolution/AI] Sandbox check failed for ${filePath}: ${err.message.slice(0, 120)}`); }
                  fs.unlink(tmpPath).catch(() => {});
                  resolve();
                });
              });
            } catch (sandboxErr) {
              valid = false;
              this.logger.warn(`[Evolution/AI] Sandbox error for ${filePath}: ${sandboxErr.message}`);
            }
            if (!valid) continue;
            changes.push({
              type: 'regex_replace_once',
              file: filePath,
              pattern: String(c.pattern),
              replacement: String(c.replacement),
              rationale: String(c.rationale || '').slice(0, 200),
            });
          }
          if (!changes.length) return null;
          this.logger.warn(`[Evolution/AI] Generated ${changes.length} AI-driven code improvement(s) via ${providerName}`);
          return {
            summary: `AI-driven self-improvement: ${parsed.reasoning?.slice(0, 100) || 'performance-based adaptation'}`,
            reason: parsed.reasoning || '',
            changes,
            _source: 'ai_driven',
          };
        } catch (err) {
          const status = err.response?.status;
          if (status === 429 && attempt < maxRetries) {
            const delayMs = attempt * 15000;
            this.logger.warn(`[Evolution/AI] ${providerName} 429 — retrying in ${delayMs / 1000}s (attempt ${attempt}/${maxRetries})`);
            await new Promise((r) => setTimeout(r, delayMs));
            continue;
          }
          this.logger.warn(`[Evolution/AI] ${providerName} plan generation failed: ${redactSecretsInText(err.message || '')}`);
          return null;
        }
      }
      return null;
    };

    // Sanitize prompt before sending to external LLMs — strip API keys, wallet addresses, secret-like tokens.
    const sanitizedPrompt = redactSecretsInText(prompt);
    const fullPrompt = `${sanitizedPrompt}\n\nIMPORTANT: Respond with ONLY a valid JSON object. No markdown, no code fences, no extra text — just the raw JSON starting with {`;

    // 1. Try Mistral first (1B tokens/month, strong reasoning, own rate pool)
    const mistralKey = process.env.MISTRAL_API_KEY || '';
    if (mistralKey) {
      const mistralModel = process.env.MISTRAL_EVOLUTION_MODEL || process.env.MISTRAL_MODEL || 'mistral-small-latest';
      const result = await callProvider('mistral', async () => {
        const res = await axios.post(
          'https://api.mistral.ai/v1/chat/completions',
          {
            model: mistralModel,
            messages: [{ role: 'user', content: fullPrompt }],
            temperature: 0.2,
            max_tokens: 1500,
          },
          { headers: { Authorization: `Bearer ${mistralKey}`, 'Content-Type': 'application/json' }, timeout: 45000 }
        );
        return res.data?.choices?.[0]?.message?.content || '';
      });
      if (result) return result;
    }

    // 2. Fallback: Groq (8b-instant, separate pool)
    const groqKey = process.env.GROQ_API_KEY || '';
    if (groqKey) {
      const groqModel = process.env.GROQ_EVOLUTION_MODEL || 'llama-3.1-8b-instant';
      const result = await callProvider('groq', async () => {
        const res = await axios.post(
          'https://api.groq.com/openai/v1/chat/completions',
          {
            model: groqModel,
            messages: [{ role: 'user', content: fullPrompt }],
            temperature: 0.2,
            max_tokens: 1500,
          },
          { headers: { Authorization: `Bearer ${groqKey}`, 'Content-Type': 'application/json' }, timeout: 40000 }
        );
        return res.data?.choices?.[0]?.message?.content || '';
      });
      if (result) return result;
    }

    // 3. SambaNova — free, no CC required (cloud.sambanova.ai)
    const sambanovaKey = process.env.SAMBANOVA_API_KEY || '';
    if (sambanovaKey) {
      const sambanovaModel = process.env.SAMBANOVA_EVOLUTION_MODEL || process.env.SAMBANOVA_MODEL || 'Meta-Llama-3.3-70B-Instruct';
      const result = await callProvider('sambanova', async () => {
        const res = await axios.post(
          'https://api.sambanova.ai/v1/chat/completions',
          { model: sambanovaModel, messages: [{ role: 'user', content: fullPrompt }], temperature: 0.2, max_tokens: 1500 },
          { headers: { Authorization: `Bearer ${sambanovaKey}`, 'Content-Type': 'application/json' }, timeout: 40000 }
        );
        return res.data?.choices?.[0]?.message?.content || '';
      });
      if (result) return result;
    }

    // 4. Together AI — $25 free credits on signup (api.together.xyz)
    const togetherKey = process.env.TOGETHER_API_KEY || '';
    if (togetherKey) {
      const togetherModel = process.env.TOGETHER_EVOLUTION_MODEL || process.env.TOGETHER_MODEL || 'meta-llama/Llama-3.3-70B-Instruct-Turbo';
      const result = await callProvider('together', async () => {
        const res = await axios.post(
          'https://api.together.xyz/v1/chat/completions',
          { model: togetherModel, messages: [{ role: 'user', content: fullPrompt }], temperature: 0.2, max_tokens: 1500 },
          { headers: { Authorization: `Bearer ${togetherKey}`, 'Content-Type': 'application/json' }, timeout: 40000 }
        );
        return res.data?.choices?.[0]?.message?.content || '';
      });
      if (result) return result;
    }

    // 5. Gemini (free 1500 req/day — already used for trading, separate key pool)
    const geminiKey = process.env.GEMINI_API_KEY || '';
    if (geminiKey) {
      const geminiModel = process.env.GEMINI_EVOLUTION_MODEL || process.env.GEMINI_MODEL || 'gemini-2.5-flash';
      const result = await callProvider('gemini', async () => {
        const res = await axios.post(
          `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent`,
          { contents: [{ role: 'user', parts: [{ text: fullPrompt }] }], generationConfig: { temperature: 0.2, maxOutputTokens: 1500 } },
          { headers: { 'Content-Type': 'application/json', 'x-goog-api-key': geminiKey }, timeout: 45000 }
        );
        return res.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      });
      if (result) return result;
    }

    // 6. Cerebras (free tier — api.cerebras.ai)
    const cerebrasKey = process.env.CEREBRAS_API_KEY || '';
    if (cerebrasKey) {
      const cerebrasModel = process.env.CEREBRAS_EVOLUTION_MODEL || process.env.CEREBRAS_MODEL || 'llama-3.3-70b';
      const result = await callProvider('cerebras', async () => {
        const res = await axios.post(
          'https://api.cerebras.ai/v1/chat/completions',
          { model: cerebrasModel, messages: [{ role: 'user', content: fullPrompt }], temperature: 0.2, max_tokens: 1500 },
          { headers: { Authorization: `Bearer ${cerebrasKey}`, 'Content-Type': 'application/json' }, timeout: 35000 }
        );
        return res.data?.choices?.[0]?.message?.content || '';
      });
      if (result) return result;
    }

    // 7. OpenRouter (has free :free models — openrouter.ai)
    const openrouterKey = process.env.OPENROUTER_API_KEY || '';
    if (openrouterKey) {
      const openrouterModel = process.env.OPENROUTER_EVOLUTION_MODEL || 'meta-llama/llama-3.3-70b-instruct:free';
      const result = await callProvider('openrouter', async () => {
        const res = await axios.post(
          'https://openrouter.ai/api/v1/chat/completions',
          { model: openrouterModel, messages: [{ role: 'user', content: fullPrompt }], temperature: 0.2, max_tokens: 1500 },
          { headers: { Authorization: `Bearer ${openrouterKey}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://github.com/dex-trading-bot', 'X-Title': 'dex-trading-bot' }, timeout: 40000 }
        );
        return res.data?.choices?.[0]?.message?.content || '';
      });
      if (result) return result;
    }

    return empty;
  }

  /**
   * Promote paper worktree changes to the main repo and restart the main bot.
   * Only callable from paper mode. Runs scripts/promote-paper-to-main.js.
   * Returns { ok, reason }.
   */
  async promoteToMain(candidatePath = null) {
    if (!this.config.paperTrading) {
      return { ok: false, reason: 'promoteToMain called from non-paper bot — skipped' };
    }
    const promoteScript = path.join(this.projectRoot, 'scripts', 'promote-paper-to-main.js');
    try {
      // Run promote script from the MAIN repo's node so it can access its own files.
      // PAPER_WORKTREE_PATH is already set in the paper PM2 env so promote script finds it.
      execFileSync(process.execPath, [promoteScript], {
        stdio: 'inherit',
        timeout: 120_000,
        env: {
          ...process.env,
          ...(candidatePath ? { EVOLUTION_CANDIDATE_PATH: candidatePath } : {}),
        },
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: redactSecretsInText(err.message?.slice(0, 300) || 'unknown') };
    }
  }

  async recordHistory(entry) {
    await fs.mkdir(path.dirname(this.historyPath), { recursive: true });
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      ...entry,
    });
    await fs.appendFile(this.historyPath, `${line}\n`, 'utf8');
  }
}

module.exports = SelfEvolutionEngine;
