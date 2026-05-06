'use strict';

const SECRET_KEY_PATTERN = /(api[_-]?key|token|secret|password|authorization|private[_-]?key|bearer)/i;

function maskValue(value) {
  const raw = String(value || '');
  if (!raw) return '';
  if (raw.length <= 8) return '***REDACTED***';
  return `${raw.slice(0, 4)}***${raw.slice(-4)}`;
}

function redactSecretsInText(input = '') {
  let text = String(input || '');

  // key=value and "key": "value" shapes
  text = text.replace(
    /((?:api[_-]?key|token|secret|password|authorization|private[_-]?key)\s*[:=]\s*)(["']?)([^"'\s,}\]]+)(\2)/gi,
    (_m, prefix, quote, secret) => `${prefix}${quote}${maskValue(secret)}${quote}`,
  );

  // Bearer tokens
  text = text.replace(/(bearer\s+)([a-z0-9._\-]+)/gi, (_m, prefix, secret) => `${prefix}${maskValue(secret)}`);

  // Well-known API key formats
  text = text.replace(/\b(sk-ant-[a-z0-9_\-]+)\b/gi, (m) => maskValue(m));
  text = text.replace(/\b(gsk_[a-z0-9_\-]+)\b/gi, (m) => maskValue(m));
  text = text.replace(/\b(AIza[0-9A-Za-z_\-]{16,})\b/g, (m) => maskValue(m));

  return text;
}

function redactObject(input) {
  if (input === null || input === undefined) return input;
  if (Array.isArray(input)) return input.map((item) => redactObject(item));
  if (typeof input !== 'object') {
    return typeof input === 'string' ? redactSecretsInText(input) : input;
  }

  const out = {};
  Object.entries(input).forEach(([key, value]) => {
    if (SECRET_KEY_PATTERN.test(key)) {
      out[key] = maskValue(value);
      return;
    }

    if (value && typeof value === 'object') {
      out[key] = redactObject(value);
      return;
    }

    out[key] = typeof value === 'string' ? redactSecretsInText(value) : value;
  });
  return out;
}

module.exports = {
  maskValue,
  redactSecretsInText,
  redactObject,
};
