'use strict';

const fs = require('fs').promises;
const path = require('path');
const { execFile } = require('child_process');
const { runPaperSimulation } = require('./simulation');
const { runBacktest, runWalkForwardBacktest } = require('./backtest');

function execNode(projectRoot, args, timeout = 20000) {
  return new Promise((resolve) => {
    execFile(process.execPath, args, { cwd: projectRoot, timeout }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
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
    for (const rel of jsTests) {
      const run = await execNode(this.projectRoot, [rel], 25000);
      results.push({
        type: 'script_test',
        target: rel,
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

  async validateCandidate({ changedFiles = [] } = {}) {
    const syntax = await this.runSyntaxChecks(changedFiles);
    const tests = await this.runScriptedTests();
    const backtests = this.runDeterministicBacktests();
    const simulations = this.runDeterministicSimulations();
    const all = [...syntax, ...tests, ...backtests, ...simulations];
    const failed = all.filter((item) => !item.ok);
    return {
      ok: failed.length === 0,
      results: all,
      failed,
      summary: {
        totalChecks: all.length,
        failedChecks: failed.length,
      },
    };
  }
}

module.exports = EvolutionValidator;
