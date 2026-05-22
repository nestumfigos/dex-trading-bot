'use strict';

// Unified config knob reader. Precedence:
//   1. dbo.strategy_config (active row for current scope; via db-hot-reload)
//   2. process.env (set by .env or ecosystem.config.js)
//   3. schema default
//   4. caller-supplied fallback
//
// Returns a cast value per schema.js KNOBS spec. Falls through silently if no
// DB poller wired (e.g., during boot before SQL connects). Caller can register
// a hot-reload poller via `attachHotReload(hr)`.

const { castValue, getKnobSpec } = require('./schema');

let hotReload = null; // db-hot-reload instance or null

function attachHotReload(hr) {
  hotReload = hr;
}

function detachHotReload() {
  hotReload = null;
}

function read(name, fallback = undefined) {
  // 1. DB cache (most authoritative when present)
  if (hotReload) {
    const dbVal = hotReload.getKnob(name, undefined);
    if (dbVal !== undefined) {
      try { return castValue(name, dbVal); } catch (_) { /* fall through */ }
    }
  }
  // 2. env
  const envVal = process.env[name];
  if (envVal !== undefined && envVal !== '') {
    try { return castValue(name, envVal); } catch (_) { /* fall through */ }
  }
  // 3. schema default
  const spec = getKnobSpec(name);
  if (spec && spec.default !== undefined) return spec.default;
  // 4. caller fallback
  return fallback;
}

// Convenience typed readers. Avoid casting twice — caller knows shape.
function readInt(name, fallback) {
  const v = read(name, fallback);
  return typeof v === 'number' ? Math.trunc(v) : parseInt(v, 10);
}
function readFloat(name, fallback) {
  const v = read(name, fallback);
  return typeof v === 'number' ? v : parseFloat(v);
}
function readBool(name, fallback) {
  const v = read(name, fallback);
  if (typeof v === 'boolean') return v;
  return /^(true|1|yes|on)$/i.test(String(v).trim());
}
function readString(name, fallback) {
  const v = read(name, fallback);
  return v == null ? '' : String(v);
}

function source(name) {
  if (hotReload && hotReload.getKnob(name, undefined) !== undefined) return 'db';
  if (process.env[name] !== undefined && process.env[name] !== '') return 'env';
  if (getKnobSpec(name)) return 'schema_default';
  return 'fallback';
}

module.exports = {
  attachHotReload,
  detachHotReload,
  read,
  readInt,
  readFloat,
  readBool,
  readString,
  source,
};
