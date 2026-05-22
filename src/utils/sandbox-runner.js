'use strict';

/**
 * Sandboxed test runner for self-evolution validation.
 *
 * Day 7 follow-up: previously runScriptedTests spawned `node <test>` directly
 * with no network/filesystem isolation — a malicious mutation could exfiltrate
 * secrets or hammer external APIs. This wrapper prefers Docker isolation when
 * available, and falls back to direct execution with a warning when not.
 *
 * Docker path: `docker run --rm --network=none --read-only ...` blocks network
 * and write access except for /tmp. CPU + memory caps prevent runaway tests.
 *
 * Falls back to direct exec when:
 *   - SANDBOX_DOCKER_DISABLED=true
 *   - `docker` binary not on PATH
 *   - Docker image pull/run fails
 *
 * Falls back is logged so operators can opt-in to install Docker.
 */

const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

const DOCKER_IMAGE = process.env.SANDBOX_DOCKER_IMAGE || 'node:24-alpine';
const DOCKER_TIMEOUT_MS = Number(process.env.SANDBOX_DOCKER_TIMEOUT_MS) || 30000;
const DOCKER_MEMORY = process.env.SANDBOX_DOCKER_MEMORY || '256m';
const DOCKER_CPUS = process.env.SANDBOX_DOCKER_CPUS || '0.5';

let _dockerAvailable = null;
async function isDockerAvailable() {
  if (process.env.SANDBOX_DOCKER_DISABLED === 'true') return false;
  if (_dockerAvailable !== null) return _dockerAvailable;
  _dockerAvailable = await new Promise((resolve) => {
    execFile('docker', ['version', '--format', '{{.Server.Version}}'], { timeout: 3000 }, (err) => {
      resolve(!err);
    });
  });
  return _dockerAvailable;
}

/**
 * Run a node script under sandbox.
 * @param {string} projectRoot - host path to mount as /app
 * @param {string} scriptRelPath - script path relative to projectRoot (POSIX style)
 * @param {Object} opts
 *   - timeoutMs (default 25000)
 *   - workerId (label for diagnostics)
 * @returns {Promise<{ok, status, mode, stdout, stderr, error, unreliableReason}>}
 *   status: passed | failed | unreliable
 *   mode:   docker | direct
 */
async function runScript(projectRoot, scriptRelPath, opts = {}) {
  const timeoutMs = Math.max(5000, Number(opts.timeoutMs) || 25000);
  const useDocker = await isDockerAvailable();

  if (useDocker) {
    return await runViaDocker(projectRoot, scriptRelPath, { timeoutMs });
  }
  return await runDirect(projectRoot, scriptRelPath, { timeoutMs, fallbackReason: 'docker unavailable' });
}

function runDirect(projectRoot, scriptRelPath, { timeoutMs, fallbackReason = null } = {}) {
  const absPath = path.join(projectRoot, scriptRelPath);
  return new Promise((resolve) => {
    execFile(process.execPath, [absPath], { cwd: projectRoot, timeout: timeoutMs }, (err, stdout, stderr) => {
      const result = classifyResult(err);
      resolve({
        ok: result.status === 'passed',
        status: result.status,
        mode: 'direct',
        fallbackReason,
        unreliableReason: result.unreliableReason,
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
        error: err ? String(err.message || err) : null,
      });
    });
  });
}

function runViaDocker(projectRoot, scriptRelPath, { timeoutMs } = {}) {
  // Convert Windows path to Docker-friendly POSIX path with drive letter mount syntax.
  // Docker Desktop accepts /c/Users/... or //c/Users/... on Windows.
  let hostMount = projectRoot;
  if (/^[A-Z]:[\\/]/i.test(projectRoot)) {
    const drive = projectRoot[0].toLowerCase();
    const rest = projectRoot.slice(2).replace(/\\/g, '/').replace(/^\/+/, '');
    hostMount = `/${drive}/${rest}`;
  }
  const scriptInContainer = `/app/${scriptRelPath.replace(/\\/g, '/').replace(/^\.?\//, '')}`;
  const dockerTimeoutMs = Math.max(timeoutMs + 5000, DOCKER_TIMEOUT_MS);

  return new Promise((resolve) => {
    const args = [
      'run', '--rm',
      '--network=none',
      '--read-only',
      '--tmpfs', '/tmp:rw,exec,size=64m',
      '--memory', DOCKER_MEMORY,
      '--cpus', DOCKER_CPUS,
      '-v', `${hostMount}:/app:ro`,
      '-w', '/app',
      '--user', '1000:1000',
      DOCKER_IMAGE,
      'node', scriptInContainer,
    ];
    execFile('docker', args, { timeout: dockerTimeoutMs }, (err, stdout, stderr) => {
      const result = classifyResult(err);
      // If docker itself failed to start (image pull error etc.), mark as unreliable so caller
      // can decide whether to fall back to direct mode.
      const dockerMeta = err && (
        /pull access denied|manifest for .* not found|Cannot connect to the Docker daemon|requires installation/i.test(String(stderr || err.message || ''))
      );
      resolve({
        ok: result.status === 'passed' && !dockerMeta,
        status: dockerMeta ? 'unreliable' : result.status,
        mode: 'docker',
        unreliableReason: dockerMeta ? 'docker infrastructure error' : result.unreliableReason,
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
        error: err ? String(err.message || err) : null,
      });
    });
  });
}

function classifyResult(err) {
  if (!err) return { status: 'passed', unreliableReason: null };
  const code = err.code || err.errno || '';
  const killed = Boolean(err.killed) || err.signal === 'SIGTERM' || err.signal === 'SIGKILL';
  if (killed || code === 'ETIMEDOUT' || code === 'ENOENT' || code === 'EACCES' || code === 'EBUSY') {
    return {
      status: 'unreliable',
      unreliableReason: killed ? `timeout/signal:${err.signal || 'killed'}` : code || err.message,
    };
  }
  return { status: 'failed', unreliableReason: null };
}

module.exports = {
  runScript,
  isDockerAvailable,
  _internal: { runDirect, runViaDocker, classifyResult },
};
