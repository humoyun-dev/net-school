import { describe, expect, test } from 'vitest';
import { parseRegDword } from '../src/main/windows-registry.ts';

const out = (line: string) =>
  `\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Policies\\System\r\n${line}\r\n\r\n`;

describe('parseRegDword', () => {
  test('reads a hex DWORD', () => {
    expect(parseRegDword(out('    DisableTaskMgr    REG_DWORD    0x1'), 'DisableTaskMgr')).toBe(1);
    expect(parseRegDword(out('    DisableTaskMgr    REG_DWORD    0x0'), 'DisableTaskMgr')).toBe(0);
    expect(parseRegDword(out('    DisableTaskMgr    REG_DWORD    0xff'), 'DisableTaskMgr')).toBe(255);
  });

  test('matches the name case-insensitively and ignores other values', () => {
    expect(parseRegDword(out('    disabletaskmgr    REG_DWORD    0x1'), 'DisableTaskMgr')).toBe(1);
    expect(parseRegDword(out('    Other    REG_DWORD    0x1'), 'DisableTaskMgr')).toBeNull();
  });

  test('a non-DWORD value or empty output is "absent"', () => {
    expect(parseRegDword(out('    DisableTaskMgr    REG_SZ    1'), 'DisableTaskMgr')).toBeNull();
    expect(parseRegDword('', 'DisableTaskMgr')).toBeNull();
  });
});
