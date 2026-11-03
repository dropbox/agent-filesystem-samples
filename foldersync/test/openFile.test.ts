import type {FileHandle} from 'node:fs/promises';
import {lstat, mkdtemp, open, rename, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {openNoFollow} from '../src/engine/openFile';

// The real functions, wrapped so a test can swap what lstat sees and look at
// the handle open returned.
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return {...real, lstat: vi.fn(real.lstat), open: vi.fn(real.open)};
});

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'foldersync-open-'));
  await writeFile(join(dir, 'a.txt'), 'A');
  await writeFile(join(dir, 'b.txt'), 'B');
});

afterEach(async () => {
  vi.mocked(lstat).mockClear();
  vi.mocked(open).mockClear();
  await rm(dir, {recursive: true, force: true});
});

describe('openNoFollow', () => {
  it('opens a regular file', async () => {
    const file = await openNoFollow(join(dir, 'a.txt'));
    try {
      expect((await file.readFile()).toString()).toBe('A');
    } finally {
      await file.close();
    }
  });

  it('refuses a symlink without opening it', async () => {
    await symlink(join(dir, 'a.txt'), join(dir, 'link.txt'));

    await expect(openNoFollow(join(dir, 'link.txt'))).rejects.toThrow(/symbolic link/);
    expect(open).not.toHaveBeenCalled();
  });

  it('refuses and closes a file that isn’t the one lstat saw', async () => {
    // As if a.txt were swapped for b.txt between lstat and open.
    vi.mocked(lstat).mockResolvedValueOnce(await lstat(join(dir, 'b.txt'), {bigint: true}));

    await expect(openNoFollow(join(dir, 'a.txt'))).rejects.toThrow(
      /changed while it was being opened/
    );
    const handle = (await vi.mocked(open).mock.results[0]?.value) as FileHandle;
    expect(handle.fd).toBe(-1);
  });

  it('refuses and closes a file whose path is replaced right after it opens', async () => {
    // lstat sees a.txt before the open, then b.txt, as if a.txt were replaced.
    const a = await lstat(join(dir, 'a.txt'), {bigint: true});
    const b = await lstat(join(dir, 'b.txt'), {bigint: true});
    vi.mocked(lstat).mockResolvedValueOnce(a).mockResolvedValueOnce(b);

    await expect(openNoFollow(join(dir, 'a.txt'))).rejects.toThrow(
      /changed while it was being opened/
    );
    const handle = (await vi.mocked(open).mock.results[0]?.value) as FileHandle;
    expect(handle.fd).toBe(-1);
  });

  it('refuses a file swapped for a symlink to itself while it opens', async () => {
    const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    let handle: FileHandle | undefined;
    // Moves a.txt and links its old name to it, right before the open.
    vi.mocked(open).mockImplementationOnce(async (...args) => {
      await rename(join(dir, 'a.txt'), join(dir, 'moved.txt'));
      await symlink(join(dir, 'moved.txt'), join(dir, 'a.txt'));
      handle = await real.open(...args);
      return handle;
    });

    // macOS and Linux refuse the open itself (ELOOP); Windows opens it, then checks.
    await expect(openNoFollow(join(dir, 'a.txt'))).rejects.toThrow(
      /changed while it was being opened|ELOOP/
    );
    expect(handle?.fd ?? -1).toBe(-1);
  });
});
