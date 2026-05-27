'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { resolveStrategyVariant } = require('../strategies/traderxo-research-variants');

const DEFAULT_PATH = path.resolve(__dirname, '..', '..', 'data', 'traderxo-paper-admission.json');

function writeAtomic(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const descriptor = fs.openSync(temporary, 'w');
  try {
    fs.writeFileSync(descriptor, JSON.stringify(payload, null, 2), 'utf8');
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temporary, filePath);
}

function createPaperStrategyAdmission({
  required = true,
  approvalPath = process.env.PERPS_PAPER_STRATEGY_ADMISSION_PATH || DEFAULT_PATH,
  now = () => Date.now(),
} = {}) {
  function readRecord() {
    try {
      const parsed = JSON.parse(fs.readFileSync(approvalPath, 'utf8'));
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (_) {
      return null;
    }
  }

  function getStatus() {
    if (!required) {
      return {
        required: false,
        allowNewPaperEntries: true,
        variantId: 'baseline',
        reason: 'admission_gate_disabled',
      };
    }
    const record = readRecord();
    const passed = record?.passed === true && record?.variantId;
    return {
      required: true,
      allowNewPaperEntries: Boolean(passed),
      variantId: passed ? record.variantId : null,
      evaluatedAt: record?.evaluatedAt || null,
      reason: passed ? 'historical_evidence_passed' : 'historical_evidence_not_passed',
      benchmark: record?.benchmark || null,
    };
  }

  function getEntryPolicy() {
    const status = getStatus();
    return status.allowNewPaperEntries
      ? { allow: true, variant: resolveStrategyVariant(status.variantId), status }
      : { allow: false, reason: status.reason, status };
  }

  function recordBenchmark(benchmark) {
    const selected = benchmark?.selectedVariant;
    const payload = {
      version: 1,
      evaluatedAt: new Date(Number(now())).toISOString(),
      passed: benchmark?.passed === true,
      variantId: benchmark?.passed === true ? selected?.id : null,
      benchmark: {
        passed: benchmark?.passed === true,
        selectedVariantId: selected?.id || null,
        reasons: Array.isArray(benchmark?.reasons) ? benchmark.reasons : [],
        symbols: Array.isArray(benchmark?.symbols) ? benchmark.symbols : [],
        trainingDays: benchmark?.trainingDays,
        validationDays: benchmark?.validationDays,
      },
    };
    writeAtomic(approvalPath, payload);
    return getStatus();
  }

  return { getStatus, getEntryPolicy, recordBenchmark, approvalPath };
}

module.exports = { createPaperStrategyAdmission };
