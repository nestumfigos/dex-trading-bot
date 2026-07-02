'use strict';

const SECRET_NAME_RE = /(secret|token|password|private|apikey|api_key|connection_string|dsn)/i;

function redact(value) {
  if (value == null || value === '') return value;
  return '[redacted]';
}

function schemaEntries(schema = {}) {
  if (Array.isArray(schema)) {
    return schema.reduce((acc, item) => {
      if (typeof item === 'string') acc[item] = {};
      else if (item && typeof item === 'object' && item.name) acc[item.name] = { ...item };
      return acc;
    }, {});
  }
  return Object.keys(schema || {}).reduce((acc, key) => {
    const value = schema[key];
    acc[key] = value && typeof value === 'object' ? { ...value } : {};
    return acc;
  }, {});
}

function hasOwn(source, key) {
  return source != null && Object.prototype.hasOwnProperty.call(source, key);
}

function visibleValue(name, value, secret) {
  return secret || SECRET_NAME_RE.test(String(name || '')) ? redact(value) : value;
}

function validateValue(definition, value) {
  if (definition.required && (value == null || value === '')) return false;
  if (typeof definition.validate === 'function') return Boolean(definition.validate(value));
  if (Array.isArray(definition.enum) && value != null && value !== '') {
    return definition.enum.includes(value);
  }
  return true;
}

function buildConfigProvenance({
  schema = {},
  defaults = {},
  pm2Env = {},
  env = {},
  dbOverrides = {},
  keys = null,
  now = () => new Date(),
} = {}) {
  const normalizedSchema = schemaEntries(schema);
  const names = new Set([
    ...Object.keys(normalizedSchema),
    ...Object.keys(defaults || {}),
    ...Object.keys(pm2Env || {}),
    ...Object.keys(env || {}),
    ...Object.keys(dbOverrides || {}),
    ...(Array.isArray(keys) ? keys : []),
  ]);

  const rows = Array.from(names).sort().map((name) => {
    const definition = normalizedSchema[name] || {};
    const secret = Boolean(definition.secret) || SECRET_NAME_RE.test(name);
    const defaultValue = hasOwn(defaults, name) ? defaults[name] : definition.default;
    const pm2Value = hasOwn(pm2Env, name) ? pm2Env[name] : undefined;
    const envValue = hasOwn(env, name) ? env[name] : undefined;
    const dbValue = hasOwn(dbOverrides, name) ? dbOverrides[name] : undefined;

    let activeValue = defaultValue;
    let source = defaultValue === undefined ? 'unset' : 'default';
    if (pm2Value !== undefined) {
      activeValue = pm2Value;
      source = 'pm2';
    }
    if (envValue !== undefined) {
      activeValue = envValue;
      source = 'env';
    }
    if (dbValue !== undefined) {
      activeValue = dbValue;
      source = 'db';
    }

    const valid = validateValue(definition, activeValue);
    return {
      name,
      source,
      required: Boolean(definition.required),
      hotReload: Boolean(definition.hotReload),
      secret,
      valid,
      defaultValue: visibleValue(name, defaultValue, secret),
      pm2Value: visibleValue(name, pm2Value, secret),
      envValue: visibleValue(name, envValue, secret),
      dbValue: visibleValue(name, dbValue, secret),
      activeValue: visibleValue(name, activeValue, secret),
    };
  });

  return {
    generatedAt: new Date(now()).toISOString(),
    rows,
    missingRequired: rows.filter((row) => row.required && row.source === 'unset').map((row) => row.name),
    invalid: rows.filter((row) => !row.valid).map((row) => row.name),
    activeConfig: rows.reduce((acc, row) => {
      acc[row.name] = row.activeValue;
      return acc;
    }, {}),
  };
}

module.exports = {
  buildConfigProvenance,
};
