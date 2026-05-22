'use strict';

class MutationEngine {
  constructor({ logger } = {}) {
    this.logger = logger || console;
  }

  normalizeChange(change = {}) {
    if (!change || typeof change !== 'object') return null;
    if (change.type === 'regex_replace_once') {
      return {
        ...change,
        type: 'exact_line_replace',
        oldLine: change.oldLine || null,
      };
    }
    return change;
  }

  buildLineRegex(oldLine) {
    const escaped = String(oldLine)
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`^${escaped}$`, 'm');
  }

  applyExactLineReplace(source, change) {
    const oldLine = String(change.oldLine || '').trimEnd();
    const newLine = String(change.newLine || change.replacement || '').trimEnd();
    if (!oldLine || !newLine) {
      return { ok: false, reason: `Invalid exact_line_replace payload for ${change.file}` };
    }
    const trimmed = oldLine.trim();
    if (trimmed.length < 8 || /^[{}\[\]();,]+$/.test(trimmed)) {
      return { ok: false, reason: `Ambiguous oldLine for ${change.file}: refusing structural-only or <8-char line ("${trimmed}")` };
    }
    const regex = this.buildLineRegex(oldLine);
    const matches = source.match(new RegExp(regex.source, 'gm')) || [];
    if (matches.length !== 1) {
      const sev = matches.length > 50 ? 'EXPLODED' : 'mismatch';
      return { ok: false, reason: `[${sev}] Exact line match count for ${change.file} was ${matches.length}, expected 1 — refusing patch` };
    }
    const nextSource = source.replace(regex, newLine);
    if (nextSource === source) {
      return { ok: false, reason: `No-op exact replacement for ${change.file}` };
    }
    return { ok: true, nextSource };
  }

  applyTemplateReplace(source, change) {
    const marker = String(change.marker || '');
    const content = String(change.content || '');
    if (!marker || !content) {
      return { ok: false, reason: `Invalid template_replace payload for ${change.file}` };
    }
    const start = `/* ${marker}:start */`;
    const end = `/* ${marker}:end */`;
    const startCount = (source.match(new RegExp(start.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
    const endCount = (source.match(new RegExp(end.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
    if (startCount !== 1 || endCount !== 1) {
      return { ok: false, reason: `Template marker "${marker}" not unique in ${change.file} (start=${startCount}, end=${endCount}) — refusing patch` };
    }
    const blockRegex = new RegExp(`${start}[\\s\\S]*?${end}`, 'm');
    if (!blockRegex.test(source)) {
      return { ok: false, reason: `Template markers missing for ${change.file}` };
    }
    const replacement = `${start}\n${content}\n${end}`;
    const nextSource = source.replace(blockRegex, replacement);
    return nextSource === source
      ? { ok: false, reason: `No-op template replacement for ${change.file}` }
      : { ok: true, nextSource };
  }
}

module.exports = MutationEngine;
