// Capability matrix tekshiruvi (spec §7: hech bir OS sinovsiz "qo'llanadi" deb belgilanmaydi).
// Katak: `not_tested` | `passed (dalil)` | `partial (dalil)` | `failed (dalil)`; dalil — docs/poc ichidagi fayl,
// JSON bo'lsa `#qadam` bilan. `passed` uchun dalil majburiy va JSON qadami `passed` bo'lishi shart.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
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
  const stepId = rawStep?.trim();
  // Dalil faqat docs/poc/results/ ichidagi oddiy fayl (`.gitkeep`, katalog, boshqa hujjat yoki tashqi yo'l emas).
  const results = resolve(baseDir, 'results');
  const path = resolve(baseDir, file);
  if (!path.startsWith(results + sep) || basename(path) === '.gitkeep') {
    return `${where}: evidence ${file} must be a file in results/`;
  }
  if (!existsSync(path) || !statSync(path).isFile()) return `${where}: evidence ${file} does not exist`;
  const json = file.endsWith('.json');
  if (status === 'passed' && !(json && stepId) && !file.endsWith('-manual.md')) {
    return `${where}: passed needs a results/*.json#step or a results/*-manual.md record`;
  }
  if (!json || !stepId) return null;
  let steps;
  try {
    steps = JSON.parse(readFileSync(path, 'utf8')).steps;
  } catch {
    return `${where}: evidence ${file} is not valid JSON`;
  }
  const step = steps?.find((s) => s.id === stepId);
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
