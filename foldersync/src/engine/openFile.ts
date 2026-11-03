// Opens a local file to read. Fails if the path itself is a symlink, or is
// swapped for another file or a symlink while it's being opened. Callers check
// that the path is inside the project.
import {constants} from 'node:fs';
import {lstat, open, type FileHandle} from 'node:fs/promises';

export async function openNoFollow(path: string): Promise<FileHandle> {
  const before = await lstat(path, {bigint: true});
  if (before.isSymbolicLink()) {
    throw new Error(`${path} is a symbolic link.`);
  }
  // Windows has no O_NOFOLLOW, so the checks below also cover a swap there.
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await file.stat({bigint: true});
    const now = await lstat(path, {bigint: true});
    if (
      now.isSymbolicLink() ||
      opened.ino !== before.ino ||
      opened.dev !== before.dev ||
      now.ino !== before.ino ||
      now.dev !== before.dev
    ) {
      throw new Error(`${path} changed while it was being opened.`);
    }
    return file;
  } catch (err) {
    await file.close();
    throw err;
  }
}
