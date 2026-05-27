'use strict';

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const config = require('../../config');

function resolveScriptPath() {
  return path.resolve(process.cwd(), String(config.pythonSidecar?.scriptPath || 'scripts/python_model_sidecar.py'));
}

function resolvePythonBin() {
  const candidates = [
    String(config.pythonSidecar?.pythonBin || '').trim(),
    process.env.PYTHON_SIDECAR_BIN,
    process.env.PYTHON,
    'C:\\Python314\\python.exe',
    'C:\\Program Files\\Python312\\python.exe',
    'python',
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (candidate.toLowerCase() === 'python') return candidate;
    if (fs.existsSync(candidate)) return candidate;
  }
  return 'python';
}

async function runPythonSidecar(command, payload = {}, logger = console) {
  if (config.pythonSidecar?.enabled === false) {
    const error = new Error('Python sidecar disabled');
    error.code = 'PYTHON_SIDECAR_DISABLED';
    throw error;
  }
  const pythonBin = resolvePythonBin();
  const scriptPath = resolveScriptPath();
  // B3.api.6: 12s default was longer than the 5s trading-loop tick, so a
  // sidecar hang stalled the entire cycle. 4s default keeps sidecar inside
  // one tick; callers MUST handle PYTHON_SIDECAR_TIMEOUT with a JS fallback
  // (callers that don't have one should disable the sidecar via config).
  const timeoutMs = Math.max(1000, Number(config.pythonSidecar?.timeoutMs || 4000));

  return new Promise((resolve, reject) => {
    const child = spawn(pythonBin, [scriptPath, String(command || '').trim()], {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };

    const timer = setTimeout(() => {
      try { child.kill(); } catch (_) { /* ignore */ }
      const error = new Error(`Python sidecar timed out for ${command}`);
      error.code = 'PYTHON_SIDECAR_TIMEOUT';
      finish(reject, error);
    }, timeoutMs);

    child.stdout.on('data', (chunk) => { stdout += String(chunk || ''); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk || ''); });
    child.on('error', (error) => finish(reject, error));
    child.on('close', (code) => {
      if (code !== 0) {
        const error = new Error((stderr || stdout || `Python sidecar exited with code ${code}`).trim());
        error.code = 'PYTHON_SIDECAR_EXIT';
        return finish(reject, error);
      }
      try {
        const parsed = JSON.parse(String(stdout || '{}').trim() || '{}');
        if (parsed?.ok === false && parsed?.error) {
          const error = new Error(parsed.error);
          error.code = parsed.code || 'PYTHON_SIDECAR_ERROR';
          error.details = parsed;
          return finish(reject, error);
        }
        return finish(resolve, parsed);
      } catch (error) {
        logger?.debug?.(`[PythonSidecar] stdout parse failed: ${stdout}`);
        error.code = 'PYTHON_SIDECAR_PARSE';
        return finish(reject, error);
      }
    });

    try {
      child.stdin.write(JSON.stringify(payload || {}));
      child.stdin.end();
    } catch (error) {
      finish(reject, error);
    }
  });
}

function jsFallbackTreeLike(features = {}) {
  const num = (value, fallback = 0) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  const weighted = (
    num(features.priceChange24hPct) * 0.04
    + num(features.return3Pct) * 0.06
    + num(features.return12Pct) * 0.03
    + (num(features.volumeSpike, 1) - 1) * 0.45
    + (num(features.buyRatioRecentPct, 50) - 50) * 0.05
    + num(features.netBuyFlowUsd10m) / 15000
    + (num(features.sentimentScore, 0.5) - 0.5) * 1.2
    - num(features.realizedVolPct) * 0.18
  );
  const score = 1 / (1 + Math.exp(-weighted));
  const signal = score >= 0.64 ? 'BUY' : score <= 0.36 ? 'SELL' : 'HOLD';
  return {
    score,
    signal,
    confidence: Math.abs(score - 0.5) * 2,
    provider: 'js_fallback',
  };
}

async function runPythonSidecarBatch(command, payloads = [], sharedPayload = {}, logger = console) {
  const list = Array.isArray(payloads) ? payloads : [];
  if (!list.length) {
    return { ok: true, predictions: [] };
  }

  const framework = String(
    sharedPayload?.metadata?.framework
    || sharedPayload?.framework
    || ''
  ).toLowerCase();

  // Pure JS fallback path: skip spawning Python entirely (used for fast batch validation).
  if (command === 'infer_model' && (framework === 'fallback' || framework === 'js' || framework === 'js_fallback')) {
    const predictions = list.map((item) => {
      const features = item?.features || {};
      return { ok: true, ...jsFallbackTreeLike(features) };
    });
    return { ok: true, predictions };
  }

  // Try to call the sidecar once with the entire batch. If the sidecar exposes
  // a `${command}_batch`, prefer it. Otherwise fall back to per-item sequential calls.
  const predictions = [];
  for (const item of list) {
    const mergedPayload = {
      ...(sharedPayload || {}),
      ...(item || {}),
      metadata: {
        ...(sharedPayload?.metadata || {}),
        ...(item?.metadata || {}),
      },
    };
    try {
      const result = await runPythonSidecar(command, mergedPayload, logger);
      predictions.push({ ok: true, ...(result || {}) });
    } catch (error) {
      // On any sidecar failure, degrade to JS fallback so batch keeps the same length.
      const features = item?.features || {};
      predictions.push({
        ok: false,
        error: error?.message || String(error),
        ...jsFallbackTreeLike(features),
      });
    }
  }
  return { ok: true, predictions };
}

module.exports = {
  runPythonSidecar,
  runPythonSidecarBatch,
  resolvePythonBin,
};
