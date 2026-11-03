// What this computer's file system supports, so tests that need it can skip
// where it's missing.
import {chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

// Whether chmod can stop this user reading a file. It can't on Windows, or as root.
export const chmodBlocksAccess = ((): boolean => {
  const dir = mkdtempSync(join(tmpdir(), 'foldersync-chmod-'));
  const file = join(dir, 'probe');
  writeFileSync(file, 'x');
  chmodSync(file, 0o000);
  try {
    readFileSync(file);
    return false;
  } catch {
    return true;
  } finally {
    chmodSync(file, 0o600);
    rmSync(dir, {recursive: true, force: true});
  }
})();

export const NO_CHMOD = 'chmod can’t block access on this computer';

export const isWindows = process.platform === 'win32';
