'use strict';

// Config source audit (Week 11.1). Boot-time check for collisions between
// .env and ecosystem.config.js. PM2 ecosystem env wins over .env, so silent
// .env edits get overridden — historically caused MIN_LIQUIDITY_USD divergence
// (.env=75000 vs eco=5000). Catch + refuse boot on hard conflicts.
//
// Pure dep-injected. No fs.readFile in production unless paths passed in.

const fs = require('fs');
const path = require('path');

function parseDotenv(content) {
  const out = {};
  if (!content || typeof content !== 'string') return out;
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!key) continue;
    out[key] = val;
  }
  return out;
}

function loadDotenv(envPath) {
  try {
    if (!envPath || !fs.existsSync(envPath)) return {};
    const content = fs.readFileSync(envPath, 'utf8');
    return parseDotenv(content);
  } catch {
    return {};
  }
}

function loadEcosystemEnv(ecoPath, profile) {
  // Require .js file fresh; reset cache to avoid stale read
  try {
    if (!ecoPath || !fs.existsSync(ecoPath)) return {};
    delete require.cache[require.resolve(ecoPath)];
    const eco = require(ecoPath);
    if (!eco || !Array.isArray(eco.apps)) return {};
    const matchProfile = String(profile || '').toLowerCase();
    for (const app of eco.apps) {
      const appProfile = String(app?.env?.BOT_PROFILE || app?.env_production?.BOT_PROFILE || '').toLowerCase();
      if (appProfile === matchProfile) {
        return { ...(app.env_production || {}), ...(app.env || {}) };
      }
    }
    return {};
  } catch {
    return {};
  }
}

// Compare overlapping keys. Returns { conflicts: [...], onlyEnv: [...], onlyEco: [...] }
function audit({ envVars = {}, ecoVars = {}, lenient = false, ignoreKeys = new Set() }) {
  const conflicts = [];
  const onlyEnv = [];
  const onlyEco = [];
  const seen = new Set();

  for (const [key, envVal] of Object.entries(envVars)) {
    if (ignoreKeys.has(key)) continue;
    seen.add(key);
    if (Object.prototype.hasOwnProperty.call(ecoVars, key)) {
      const ecoVal = ecoVars[key];
      if (String(ecoVal) !== String(envVal)) {
        conflicts.push({
          key,
          envValue: envVal,
          ecoValue: ecoVal,
          severity: lenient ? 'warn' : 'error',
          note: 'PM2 ecosystem env wins over .env. Edit one or remove from the other.',
        });
      }
    } else {
      onlyEnv.push(key);
    }
  }
  for (const key of Object.keys(ecoVars)) {
    if (ignoreKeys.has(key)) continue;
    if (!seen.has(key)) onlyEco.push(key);
  }

  return { conflicts, onlyEnv, onlyEco };
}

// Boot-time entry. Reads files, performs audit, throws ConfigError on hard conflicts.
function auditBoot({
  envPath,
  ecoPath,
  profile,
  lenient = false,
  ignoreKeys = new Set(['NODE_ENV', 'PATH', 'HOME', 'BOT_PROFILE', 'PORT']),
  logger,
} = {}) {
  const log = logger || console;
  const envVars = loadDotenv(envPath || path.join(process.cwd(), '.env'));
  const ecoVars = loadEcosystemEnv(ecoPath || path.join(process.cwd(), 'ecosystem.config.js'), profile);

  const result = audit({ envVars, ecoVars, lenient, ignoreKeys });
  result.envCount = Object.keys(envVars).length;
  result.ecoCount = Object.keys(ecoVars).length;

  if (result.conflicts.length) {
    const lines = result.conflicts.map((c) => `  ${c.key}: .env=${JSON.stringify(c.envValue)} vs eco=${JSON.stringify(c.ecoValue)}`);
    const msg = `[config/source-audit] ${result.conflicts.length} conflict(s) between .env and ecosystem.config.js (profile=${profile}):\n${lines.join('\n')}\n  PM2 ecosystem WINS. Either remove from .env or align values.`;
    if (lenient) {
      log.warn?.(msg);
    } else {
      const err = new Error(msg);
      err.code = 'CONFIG_SOURCE_CONFLICT';
      throw err;
    }
  } else if (typeof log.info === 'function') {
    log.info(`[config/source-audit] OK — ${result.envCount} .env vars / ${result.ecoCount} eco vars / 0 conflicts`);
  }

  return result;
}

module.exports = {
  parseDotenv,
  loadDotenv,
  loadEcosystemEnv,
  audit,
  auditBoot,
};
