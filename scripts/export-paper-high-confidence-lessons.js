'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PAPER_WORKTREE = process.env.PAPER_WORKTREE_PATH || path.resolve(ROOT, '..', 'dex-trading-bot-paper');

const CANDIDATE_INPUTS = [
  path.join(PAPER_WORKTREE, 'data', 'agent-memory.json'),
  path.join(ROOT, 'data', 'paper', 'agent-memory.json'),
];

const OUTPUT_PATH = process.env.EXPORT_OUTPUT_PATH
  ? path.resolve(process.env.EXPORT_OUTPUT_PATH)
  : path.join(ROOT, 'data', 'exports', 'paper-high-confidence-lessons.json');

const MIN_CONFIDENCE = Number(process.env.EXPORT_MIN_CONFIDENCE || 70);

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function pickInputFile() {
  for (const candidate of CANDIDATE_INPUTS) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`No paper memory file found. Tried: ${CANDIDATE_INPUTS.join(', ')}`);
}

function deriveConfidence(lesson = {}) {
  if (Number.isFinite(Number(lesson.confidence))) {
    return Math.max(0, Math.min(100, Number(lesson.confidence)));
  }

  // Heuristic confidence for lessons that do not store an explicit confidence field.
  const hitCount = Math.max(0, Number(lesson.hitCount || 0));
  const pnlAbs = Math.abs(Number(lesson.pnlUsd || 0));
  const outcomeBonus = String(lesson.outcome || '').toLowerCase() === 'loss' ? 5 : 0;
  const hitBonus = Math.min(30, hitCount * 10);
  const pnlBonus = pnlAbs >= 2 ? 15 : pnlAbs >= 1 ? 8 : 0;
  return Math.max(0, Math.min(95, 50 + outcomeBonus + hitBonus + pnlBonus));
}

function buildExportLessons(memoryData) {
  const lessons = Array.isArray(memoryData?.tradeLessons) ? memoryData.tradeLessons : [];
  return lessons
    .map((lesson) => {
      const confidence = deriveConfidence(lesson);
      return {
        id: lesson.id || null,
        ts: Number(lesson.ts || 0),
        symbol: lesson.symbol || null,
        chain: lesson.chain || null,
        strategy: lesson.strategy || null,
        outcome: lesson.outcome || null,
        pnlUsd: Number(lesson.pnlUsd || 0),
        pnlPct: Number(lesson.pnlPct || 0),
        lesson: lesson.lesson || '',
        reason: lesson.reason || '',
        hitCount: Number(lesson.hitCount || 0),
        confidence,
      };
    })
    .filter((entry) => Number.isFinite(entry.confidence) && entry.confidence >= MIN_CONFIDENCE)
    .sort((a, b) => b.confidence - a.confidence || b.ts - a.ts);
}

function main() {
  const inputPath = pickInputFile();
  const memoryData = readJson(inputPath);
  const exportLessons = buildExportLessons(memoryData);

  const payload = {
    source: inputPath,
    exportedAt: new Date().toISOString(),
    minConfidence: MIN_CONFIDENCE,
    totalLessonsInSource: Array.isArray(memoryData?.tradeLessons) ? memoryData.tradeLessons.length : 0,
    exportedCount: exportLessons.length,
    lessons: exportLessons,
  };

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

  console.log(`Exported ${payload.exportedCount} high-confidence lesson(s).`);
  console.log(`Input : ${inputPath}`);
  console.log(`Output: ${OUTPUT_PATH}`);
}

main();