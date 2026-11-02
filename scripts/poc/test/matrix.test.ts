import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { checkMatrix } from '../matrix.mjs';

let base: string;
const table = (cell: string) => `# Matrix

| Imkoniyat | Windows x64 | macOS |
|---|---|---|
| \`remote.view\` | ${cell} | not_tested |
`;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'matrix-'));
  mkdirSync(join(base, 'results'));
  writeFileSync(
    join(base, 'results', 'win.json'),
    JSON.stringify({
      steps: [
        { id: 'remote', status: 'passed' },
        { id: 'message', status: 'failed' },
      ],
    }),
  );
  writeFileSync(join(base, 'results', 'win-manual.md'), "# qo'lda\n");
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe('capability matrix check', () => {
  test('a passed cell without evidence fails the matrix check', () => {
    expect(checkMatrix(table('passed'), base)).toEqual([expect.stringMatching(/remote\.view.*Windows x64.*evidence/)]);
  });

  test('evidence must point to an existing results file', () => {
    expect(checkMatrix(table('passed (results/nope.json#remote)'), base)[0]).toMatch(/nope\.json/);
    expect(checkMatrix(table('passed (results/win.json#remote)'), base)).toEqual([]);
    expect(checkMatrix(table('passed (results/win-manual.md)'), base)).toEqual([]);
  });

  test('a passed cell must cite a passed step', () => {
    expect(checkMatrix(table('passed (results/win.json#message)'), base)[0]).toMatch(/message.*failed/);
    expect(checkMatrix(table('passed (results/win.json#missing)'), base)[0]).toMatch(/missing/);
  });

  test('unknown statuses are rejected', () => {
    expect(checkMatrix(table('works'), base)[0]).toMatch(/works/);
    expect(checkMatrix(table('failed (results/win.json#message)'), base)).toEqual([]);
  });

  test('the initial matrix is all not_tested and passes the check', () => {
    const real = join(import.meta.dirname, '..', '..', '..', 'docs', 'poc');
    const md = readFileSync(join(real, 'capability-matrix.md'), 'utf8');
    expect(checkMatrix(md, real)).toEqual([]);
    expect(md).toMatch(/\| `remote\.control` \|/);
  });
  test('evidence must be a results file: not .gitkeep, a directory, another doc or outside docs/poc', () => {
    writeFileSync(join(base, 'results', '.gitkeep'), '');
    writeFileSync(join(base, 'capability-matrix.md'), '# x');
    for (const ref of ['results/.gitkeep', 'capability-matrix.md', '../../package.json', 'results/']) {
      expect(checkMatrix(table(`passed (${ref})`), base), ref).toHaveLength(1);
    }
  });

  test('passed needs a json step or a manual record', () => {
    writeFileSync(join(base, 'results', 'notes.txt'), 'x');
    expect(checkMatrix(table('passed (results/notes.txt)'), base)).toHaveLength(1);
    expect(checkMatrix(table('passed (results/win.json)'), base)).toHaveLength(1);
    expect(checkMatrix(table('partial (results/notes.txt)'), base)).toEqual([]);
  });

  test('a broken evidence json is reported, not thrown', () => {
    writeFileSync(join(base, 'results', 'bad.json'), '{');
    expect(checkMatrix(table('passed (results/bad.json#remote)'), base)[0]).toMatch(/bad\.json/);
  });
});
