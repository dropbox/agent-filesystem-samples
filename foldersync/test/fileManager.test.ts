import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {delimiter, join} from 'node:path';

import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import {NO_FILE_MANAGER, requireFileManager} from '../src/main/fileManager';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'foldersync-filemanager-'));
});

afterEach(async () => {
  await rm(dir, {recursive: true, force: true});
});

describe('requireFileManager', () => {
  it('fails on Linux when no folder on PATH has xdg-open', async () => {
    await expect(requireFileManager('linux', [dir, ''].join(delimiter))).rejects.toThrow(
      NO_FILE_MANAGER
    );
  });

  it('passes on Linux when a folder on PATH has xdg-open', async () => {
    const bin = join(dir, 'bin');
    await mkdir(bin);
    await writeFile(join(bin, 'xdg-open'), '#!/bin/sh\n', {mode: 0o755});

    await expect(
      requireFileManager('linux', [join(dir, 'missing'), bin].join(delimiter))
    ).resolves.toBeUndefined();
  });

  it('doesn’t check on macOS or Windows, which always have a file manager', async () => {
    await expect(requireFileManager('darwin', '')).resolves.toBeUndefined();
    await expect(requireFileManager('win32', '')).resolves.toBeUndefined();
  });
});
