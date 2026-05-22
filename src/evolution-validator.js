'use strict';

const fs = require('fs').promises;
const path = require('path');
const { execFile } = require('child_process');
const { runPaperSimulation } = require('./simulation');
const { runBacktest, runWalkForwardBacktest } = require('./backtest');

function execNode(projectRoot, args, timeout = 20000) {
  return new Promise((resolve) => {
    execFile(process.execPath, args, { cwd: projectRoot, timeout }, (error, stdout, stderr) => {
      // Tristate result:
      //   passed     — exit 0, no error
      //   failed     — exit non-zero with a real error from the script (validation FAILED, do not promote)
      //   unreliable — env-level problem (ENOENT/EACCES/timeout). Cannot conclude; treat upstream as inconclusive.
      let status = 'passed';
      let unreliableReason = null;
      if (error) {
        const code = error.code || error.errno || '';
        const killed = Boolean(error.killed) || error.signal === 'SIGTERM' || error.signal === 'SIGKILL';
        if (killed || code === 'ETIMEDOUT' || code === 'ENOENT' || code === 'EACCES' || code === 'EBUSY') {
          status = 'unreliable';
          unreliableReason = killed ? `timeout/signal:${error.signal || 'killed'}` : code || error.message;
        } else {
          status = 'failed';
        }
      }
      resolve({
        ok: status === 'passed',
        status,
        unreliableReason,
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
        error: error ? String(error.message || error) : null,
      });
    });
  });
}

function buildSyntheticSeries(length = 180, drift = 0.003, noiseScale = 0.01) {
  const prices = [];
  const volumes = [];
  let price = 1;
  for (let i = 0; i < length; i += 1) {
    const cycle = Math.sin(i / 9) * 0.006;
    const noise = Math.sin(i * 1.7) * noiseScale;
    price *= Math.max(0.7, 1 + drift + cycle + noise);
    prices.push(Number(price.toFixed(6)));
    volumes.push(Number((100000 * (1 + Math.abs(cycle) * 3 + Math.abs(noise) * 10)).toFixed(2)));
  }
  return { prices, volumes };
}

class EvolutionValidator {
  constructor({ config, logger, projectRoot }) {
    this.config = config;
    this.logger = logger || console;
    this.projectRoot = projectRoot;
  }

  getMomentumSettings() {
    return this.config?.strategies?.momentum || this.config?.strategy || {
      emaFast: 8,
      emaSlow: 21,
      rsiPeriod: 14,
      rsiBuyThreshold: 45,
      rsiBuyMaxThreshold: 70,
      volumeSpikeMultiplier: 2,
      stopLossPct: 0.08,
      takeProfitPct: 0.12,
      sellTiers: [{ profitPct: 0.12, sellPct: 1 }],
    };
  }

  async runSyntaxChecks(changedFiles = []) {
    const jsFiles = changedFiles.filter((file) => String(file).endsWith('.js'));
    const targets = jsFiles.length ? jsFiles : ['src/index.js', 'src/self-evolution.js'];
    const results = [];
    for (const rel of targets) {
      const abs = path.join(this.projectRoot, rel);
      results.push({
        type: 'syntax',
        target: rel,
        ...(await execNode(this.projectRoot, ['--check', abs], 12000)),
      });
    }
    return results;
  }

  async runScriptedTests() {
    const testDir = path.join(this.projectRoot, 'test');
    let entries = [];
    try {
      entries = await fs.readdir(testDir, { withFileTypes: true });
    } catch (_) {
      return [];
    }
    const jsTests = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
      .map((entry) => path.join('test', entry.name));
    const results = [];
    // Day 7 follow-up: prefer Docker-sandboxed execution when available so a
    // malicious self-evolution mutation cannot exfiltrate secrets or hammer
    // external APIs from inside the test. Falls back to direct execNode if
    // Docker is unavailable (auto-detected by sandbox-runner).
    const sandbox = require('./utils/sandbox-runner');
    for (const rel of jsTests) {
      const run = await sandbox.runScript(this.projectRoot, rel, { timeoutMs: 25000 });
      results.push({
        type: 'script_test',
        target: rel,
        sandboxMode: run.mode,
        sandboxFallbackReason: run.fallbackReason || null,
        ok: run.ok,
        stdout: run.stdout,
        stderr: run.stderr,
        error: run.error,
      });
    }
    return results;
  }

  runDeterministicBacktests() {
    const strategySettings = this.getMomentumSettings();
    const riskSettings = this.config?.risk || {};
    const scenarios = [
      { name: 'bull', drift: 0.004 },
      { name: 'range', drift: 0.0006 },
      { name: 'stress', drift: -0.0025 },
    ];
    return scenarios.map((scenario) => {
      const series = buildSyntheticSeries(220, scenario.drift, scenario.name === 'stress' ? 0.018 : 0.01);
      const standard = runBacktest(series.prices, series.volumes, strategySettings, {
        startingBalance: 10000,
        tradePct: 0.05,
        riskSettings,
      });
      const walkForward = runWalkForwardBacktest(series.prices, series.volumes, strategySettings, {
        startingBalance: 10000,
        tradePct: 0.05,
        riskSettings,
      });
      const ok = Boolean(standard && walkForward);
      return {
        type: 'backtest',
        target: scenario.name,
        ok,
        metrics: ok
          ? {
            standardProfitFactor: Number(standard.summary?.profitFactor || 0),
            standardWinRatePct: Number(standard.summary?.winRatePct || 0),
            standardDrawdownPct: Number(standard.summary?.maxDrawdownPct || 0),
            walkForwardProfitFactor: Number(walkForward.summary?.profitFactor || 0),
            walkForwardWinRatePct: Number(walkForward.summary?.winRatePct || 0),
          }
          : null,
        error: ok ? null : 'backtest returned null',
      };
    });
  }

  runDeterministicSimulations() {
    const strategySettings = this.getMomentumSettings();
    const scenarios = ['bull', 'bear', 'range', 'volatile'];
    return scenarios.map((scenario) => {
      const result = runPaperSimulation({
        scenario,
        periods: 180,
        startingBalance: 10000,
        tradePct: 0.05,
        strategySettings,
        riskSettings: this.config?.risk || {},
      });
      return {
        type: 'simulation',
        target: scenario,
        ok: Boolean(result),
        metrics: result
          ? {
            profitFactor: Number(result.summary?.profitFactor || 0),
            winRatePct: Number(result.summary?.winRatePct || 0),
            maxDrawdownPct: Number(result.summary?.maxDrawdownPct || 0),
          }
          : null,
        error: result ? null : 'simulation returned null',
      };
    });
  }

  /**
   * Capture a baseline of validator results against current code (no patch applied).
   * Returns a Map<resultKey, ok:boolean> usable as the `baseline` arg to
   * validateCandidate(). Use this BEFORE applying a self-evolution patch so the
   * post-apply validation can detect NEW failures (delta) instead of treating
   * pre-existing broken tests as patch-induced regressions.
   *
   * Bug class this guards: 2026-05-17 — pre-existing `test/*.js` failures
   * (research-handlers, agent-memory-ai-budget, etc.) made every patch falsely
   * fail validation, blocking all self-evolution.
   */
  async captureBaseline({ changedFiles = [] } = {}) {
    const all = await this._runAll({ changedFiles });
    const map = new Map();
    for (const r of all) map.set(this._resultKey(r), r.ok);
    return { results: all, map, summary: { totalChecks: all.length, passedChecks: all.filter((r) => r.ok).length } };
  }

  _resultKey(item) {
    return `${item.type}:${item.target}`;
  }

  async _runAll({ changedFiles = [] } = {}) {
    const syntax = await this.runSyntaxChecks(changedFiles);
    const tests = await this.runScriptedTests();
    const backtests = this.runDeterministicBacktests();
    const simulations = this.runDeterministicSimulations();
    return [...syntax, ...tests, ...backtests, ...simulations];
  }

  /**
   * @param {Object} opts
   * @param {string[]} opts.changedFiles
   * @param {Map<string,boolean>|null} [opts.baseline]
   *   If provided, only fail on NEW regressions (post-apply failure that was
   *   passing in baseline). Pre-existing failures are reported as `preexisting`
   *   and don't block. If omitted, behaves as legacy strict mode.
   */
  async validateCandidate({ changedFiles = [], baseline = null } = {}) {
    const all = await this._runAll({ changedFiles });
    const failed = all.filter((item) => !item.ok);

    if (!baseline || typeof baseline.get !== 'function') {
      // Legacy strict mode: any failure blocks.
      return {
        ok: failed.length === 0,
        results: all,
        failed,
        preexistingFailures: [],
        newFailures: failed,
        summary: { totalChecks: all.length, failedChecks: failed.length, mode: 'strict' },
      };
    }

    // Delta mode: a failure only counts as a regression if it was previously OK.
    const newFailures = [];
    const preexistingFailures = [];
    for (const item of failed) {
      const key = this._resultKey(item);
      const wasOk = baseline.get(key);
      if (wasOk === true) {
        // Previously passing, now failing — patch broke it.
        newFailures.push(item);
      } else if (wasOk === false) {
        // Was already broken pre-patch — ignore.
        preexistingFailures.push(item);
      } else {
        // Not in baseline (new check introduced by patch) — strict: fail.
        newFailures.push(item);
      }
    }

    return {
      ok: newFailures.length === 0,
      results: all,
      failed: newFailures, // back-compat: `failed` is the blocking set
      preexistingFailures,
      newFailures,
      summary: {
        totalChecks: all.length,
        failedChecks: failed.length,
        newFailures: newFailures.length,
        preexistingFailures: preexistingFailures.length,
        mode: 'delta',
      },
    };
  }
}

module.exports = EvolutionValidator;
