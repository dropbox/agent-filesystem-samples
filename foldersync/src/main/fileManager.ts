// Checks that there's a program to open folders with. On Linux, Electron runs
// xdg-open without waiting for it, so a missing xdg-open fails silently.
import {access, constants} from 'node:fs/promises';
import {delimiter, join} from 'node:path';

export const NO_FILE_MANAGER =
  'There’s no file manager to open it with. Install xdg-utils, then try again.';

export async function requireFileManager(
  platform: string = process.platform,
  path: string = process.env.PATH ?? ''
): Promise<void> {
  if (platform !== 'linux') {
    return;
  }
  for (const dir of path.split(delimiter)) {
    if (!dir) {
      continue;
    }
    try {
      await access(join(dir, 'xdg-open'), constants.X_OK);
      return;
    } catch {
      // Not in this folder.
    }
  }
  throw new Error(NO_FILE_MANAGER);
}
