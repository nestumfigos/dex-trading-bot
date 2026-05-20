'use strict';

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const config = require('../../config');

let activeSidecars = 0;
const sidecarQueue = [];

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

function resolveMaxConcurrent() {
  return Math.max(1, Number(config.pythonSidecar?.maxConcurrent || 1));
}

function resolveMaxQueue() {
  return Math.max(0, Number(config.pythonSidecar?.maxQueue || 10));
}

function acquireSidecarSlot(command) {
  if (activeSidecars < resolveMaxConcurrent()) {
    activeSidecars += 1;
    return Promise.resolve();
  }

  if (sidecarQueue.length >= resolveMaxQueue()) {
    const error = new Error(`Python sidecar queue full for ${command}`);
    error.code = 'PYTHON_SIDECAR_QUEUE_FULL';
    return Promise.reject(error);
  }

  return new Promise((resolve) => {
    sidecarQueue.push(resolve);
  }).then(() => {
    activeSidecars += 1;
  });
}

function releaseSidecarSlot() {
  activeSidecars = Math.max(0, activeSidecars - 1);
  const next = sidecarQueue.shift();
  if (next) {
    next();
  }
}

async function runPythonSidecarProcess(command, payload = {}, logger = console) {
  const pythonBin = resolvePythonBin();
  const scriptPath = resolveScriptPath();
  const timeoutMs = Math.max(1000, Number(config.pythonSidecar?.timeoutMs || 12000));

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

async function runPythonSidecar(command, payload = {}, logger = console) {
  if (config.pythonSidecar?.enabled === false) {
    const error = new Error('Python sidecar disabled');
    error.code = 'PYTHON_SIDECAR_DISABLED';
    throw error;
  }

  await acquireSidecarSlot(command);
  try {
    return await runPythonSidecarProcess(command, payload, logger);
  } finally {
    releaseSidecarSlot();
  }
}

async function runPythonSidecarBatch(command, rows = [], payload = {}, logger = console) {
  const normalizedRows = Array.isArray(rows) ? rows : [];
  if (!normalizedRows.length) {
    return { ok: true, predictions: [], provider: 'empty_batch' };
  }
  const batchCommand = command === 'infer_model' ? 'infer_model_batch' : `${String(command || '').trim()}_batch`;
  return runPythonSidecar(batchCommand, {
    ...(payload || {}),
    rows: normalizedRows,
  }, logger);
}

module.exports = {
  runPythonSidecar,
  runPythonSidecarBatch,
  resolvePythonBin,
};
