// Capability matrix tekshiruvi (spec §7: hech bir OS sinovsiz "qo'llanadi" deb belgilanmaydi).
// Katak: `not_tested` | `passed (dalil)` | `partial (dalil)` | `failed (dalil)`; dalil — docs/poc ichidagi fayl,
// JSON bo'lsa `#qadam` bilan. `passed` uchun dalil majburiy va JSON qadami `passed` bo'lishi shart.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const STATUSES = new Set(['not_tested', 'passed', 'partial', 'failed']);
const CELL = /^(\w+)(?:\s*\(([^)]*)\))?$/;

function checkCell(cell, where, baseDir) {
  const m = CELL.exec(cell);
  if (!m || !STATUSES.has(m[1])) return `${where}: unknown status "${cell}"`;
  const [, status, evidence] = m;
  if (status === 'not_tested') return null;
  if (!evidence) return `${where}: ${status} needs evidence`;
  const [rawFile, rawStep] = evidence.split('#');
  const file = rawFile.trim();
  const path = join(baseDir, file);
  if (!existsSync(path)) return `${where}: evidence ${file} does not exist`;
  if (!file.endsWith('.json') || !rawStep) return null;
  const stepId = rawStep.trim();
  const step = JSON.parse(readFileSync(path, 'utf8')).steps?.find((s) => s.id === stepId);
  if (!step) return `${where}: step ${stepId} missing in ${file}`;
  if (status === 'passed' && step.status !== 'passed') return `${where}: step ${stepId} is ${step.status}, not passed`;
  return null;
}

export function checkMatrix(markdown, baseDir) {
  const errors = [];
  const lines = markdown.split('\n').filter((l) => l.trim().startsWith('|'));
  if (lines.length < 3) return ['matrix table not found'];
  const header = lines[0]
    .split('|')
    .slice(1, -1)
    .map((c) => c.trim());
  for (const line of lines.slice(2)) {
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((c) => c.trim());
    for (let i = 1; i < cells.length; i++) {
      const error = checkCell(cells[i], `${cells[0]} / ${header[i]}`, baseDir);
      if (error) errors.push(error);
    }
  }
  return errors;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const base = join(fileURLToPath(import.meta.url), '..', '..', '..', 'docs', 'poc');
  const errors = checkMatrix(readFileSync(join(base, 'capability-matrix.md'), 'utf8'), base);
  for (const e of errors) console.error(e);
  console.log(errors.length === 0 ? 'capability matrix: ok' : `capability matrix: ${errors.length} error(s)`);
  process.exitCode = errors.length === 0 ? 0 : 1;
}
