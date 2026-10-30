// Live sync scenarios on one project, run in order: two computers signed in as
// one throwaway managed user, against real Dropbox.
import {randomBytes} from 'node:crypto';
import {existsSync} from 'node:fs';
import {mkdir, mkdtemp, open, readFile, readdir, rename, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {afterAll, beforeAll, describe, expect, it} from 'vitest';

import {Computer, SERVER, TestUser, groupsSince, projectName, remotePaths, sleep} from './harness';

const P = projectName('sync');
const LONG1 = `Very long folder name ${'x'.repeat(200)}`;
const LONG2 = `Another long folder ${'y'.repeat(200)}`;
const NFD = 'café notes.txt'.normalize('NFD');
const BIG_BYTES = 151 * 1024 * 1024;

let root: string;
let user: TestUser;
let c1: Computer;
let c2: Computer;

// Folders one computer deleted stay in Dropbox, empty, so the other computer
// keeps them. The comparison leaves them out.
const keptEmpty: string[] = [];
const kept = (path: string): boolean =>
  keptEmpty.some((k) => path === k || path.startsWith(`${k}/`));

async function expectSameTrees(): Promise<void> {
  const entries = (t: Map<string, string>): [string, string][] =>
    [...t.entries()].filter(([path]) => !kept(path)).sort();
  expect(entries(await c2.tree(P))).toEqual(entries(await c1.tree(P)));
}

describe.skipIf(!SERVER)('live sync', () => {
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'foldersync-e2e-'));
    process.env.FOLDERSYNC_PROJECTS = join(root, 'default-projects');
    user = await TestUser.create('sync');
    c1 = await Computer.create(root, user, 'computer1');
    c2 = await Computer.create(root, user, 'computer2');
    await c1.use(P);
    await c2.use(P);
  });

  afterAll(async () => {
    c1?.stop();
    c2?.stop();
    try {
      await user?.remove();
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });

  it('uploads a new project with long, Unicode, ignored, invalid, empty, and big items', async () => {
    await c1.projects.create(P);
    await c1.write(P, 'a.txt', 'v1');
    await c1.write(P, `${LONG1}/${LONG2}/clip.txt`, 'deep');
    await c1.write(P, NFD, 'nfd name');
    await c1.write(P, '🎬 shots/take 1.txt', 'emoji');
    await c1.write(P, '.DS_Store', 'ignored');
    await c1.write(P, '~$draft.docx', 'ignored');
    await c1.write(P, 'ends with space ', 'invalid');
    await mkdir(c1.local(P, 'empty'), {recursive: true});
    for (let i = 0; i < 25; i++) {
      await c1.write(P, `bulk/file-${i}.txt`, `bulk ${i}`);
    }
    const big = await open(c1.local(P, 'big.bin'), 'w');
    for (let off = 0; off < BIG_BYTES; off += 8 * 1024 * 1024) {
      await big.write(randomBytes(Math.min(8 * 1024 * 1024, BIG_BYTES - off)));
    }
    await big.close();

    const s = await c1.sync(P);

    expect(s.uploaded).toBe(30);
    expect(s.issues.map((i) => i.message)).toEqual(['The name ends with a space.']);
    const r = await remotePaths(c1, P);
    expect(r.has('.ds_store')).toBe(false);
    expect(r.has('~$draft.docx')).toBe(false);
    expect(r.has('ends with space ')).toBe(false);
    expect(r.has('empty')).toBe(true);
    expect(r.has(`${LONG1}/${LONG2}/clip.txt`.toLowerCase())).toBe(true);
    expect(r.has('big.bin')).toBe(true);
  }, 600_000);

  it('downloads everything on the second computer', async () => {
    const s = await c2.sync(P);

    expect(s.downloaded).toBe(30);
    expect(s.issues).toEqual([]);
    // Computer 1 still has the items that don't sync.
    await rm(c1.local(P, '.DS_Store'));
    await rm(c1.local(P, '~$draft.docx'));
    await rm(c1.local(P, 'ends with space '));
    await expectSameTrees();
    expect(await c2.read(P, `${LONG1}/${LONG2}/clip.txt`)).toBe('deep');
  }, 600_000);

  it('does nothing when nothing changed', async () => {
    for (const c of [c1, c2]) {
      const s = await c.sync(P);
      expect([s.uploaded, s.downloaded, s.deletedLocal, s.deletedRemote, s.conflicts]).toEqual([
        0, 0, 0, 0, 0,
      ]);
    }
  }, 120_000);

  it('keeps both versions of a file edited on both computers', async () => {
    await c1.write(P, 'a.txt', 'from c1');
    await c2.write(P, 'a.txt', 'from c2');

    await c1.sync(P);
    const s = await c2.sync(P);
    await c1.sync(P);

    expect(s.conflicts).toBe(1);
    await expectSameTrees();
    const names = [...(await c1.tree(P)).keys()].filter((k) => /^a\b.*\.txt$/.test(k));
    const contents = await Promise.all(names.map((n) => c1.read(P, n)));
    expect(contents.sort()).toEqual(['from c1', 'from c2']);
    expect(await c2.read(P, 'a.txt')).toBe('from c1');
  }, 120_000);

  it('blocks a path that is a file on one computer and a folder on the other, then recovers', async () => {
    await c1.write(P, 'thing', 'a file');
    await c2.write(P, 'thing/inner.txt', 'in a folder');
    await c1.sync(P);

    const s = await c2.sync(P);

    expect(s.issues.map((i) => i.message)).toContain(
      'A file and a folder have the same path. Rename one of them.'
    );
    expect(await c2.read(P, 'thing/inner.txt')).toBe('in a folder');
    expect((await remotePaths(c2, P)).has('thing/inner.txt')).toBe(false);
    await rename(c2.local(P, 'thing'), c2.local(P, 'thing2'));
    expect((await c2.sync(P)).issues).toEqual([]);
    await c1.sync(P);
    await expectSameTrees();
    expect(await c1.read(P, 'thing2/inner.txt')).toBe('in a folder');
    expect(await c2.read(P, 'thing')).toBe('a file');
  }, 120_000);

  it('keeps both files whose names differ only in case', async () => {
    await c1.write(P, 'Photo.txt', 'upper');
    await c2.write(P, 'photo.txt', 'lower');

    await c1.sync(P);
    await c2.sync(P);
    await c1.sync(P);

    await expectSameTrees();
    const names = [...(await c1.tree(P)).keys()].filter((k) => /^photo/i.test(k));
    const contents = await Promise.all(names.map((n) => c1.read(P, n)));
    expect(contents.sort()).toEqual(['lower', 'upper']);
  }, 120_000);

  it('passes deletes to the other computer and keeps a local backup', async () => {
    await rm(c1.local(P, '🎬 shots'), {recursive: true});
    await rm(c1.local(P, 'empty'), {recursive: true});

    const s1 = await c1.sync(P);

    expect(s1.deletedRemote).toBeGreaterThanOrEqual(1);
    // The folders stay in Dropbox, empty, and computer 1 doesn't bring them back.
    expect((await remotePaths(c1, P)).has('🎬 shots')).toBe(true);
    expect((await c1.sync(P)).downloaded).toBe(0);
    expect(existsSync(c1.local(P, '🎬 shots'))).toBe(false);
    const s2 = await c2.sync(P);
    expect(s2.deletedLocal).toBeGreaterThanOrEqual(1);
    // Computer 2 keeps them, empty.
    const under = (k: string): boolean =>
      ['🎬 shots', 'empty'].some((f) => k === f || k.startsWith(`${f}/`));
    const left = [...(await c2.tree(P)).entries()].filter(([k]) => under(k));
    expect(left.length).toBeGreaterThan(0);
    expect(left.every(([, kind]) => kind === 'dir')).toBe(true);
    keptEmpty.push('🎬 shots', 'empty');
    // The deleted file's backup has its content, not just its name.
    const oldFiles = c2.local(P, '.foldersync/old_files');
    const backup = (await readdir(oldFiles)).find((n) => n.endsWith('take 1.txt'));
    expect(backup).toBeDefined();
    expect(await readFile(join(oldFiles, backup ?? ''), 'utf8')).toBe('emoji');
    await expectSameTrees();
  }, 120_000);

  it('asks before deleting most of the files, then deletes when allowed', async () => {
    await rm(c2.local(P, 'bulk'), {recursive: true});
    await rm(c2.local(P, 'big.bin'));

    const asked = await c2.sync(P);

    expect(asked.massDelete?.count).toBeGreaterThanOrEqual(20);
    expect((await remotePaths(c2, P)).has('bulk/file-0.txt')).toBe(true);
    const allowed = await c2.sync(P, true);
    expect(allowed.deletedRemote).toBeGreaterThanOrEqual(26);
    expect((await c1.sync(P)).massDelete).toBeDefined();
    expect(existsSync(c1.local(P, 'bulk/file-0.txt'))).toBe(true);
    await c1.sync(P, true);
    // bulk stays in Dropbox, empty, so computer 1 keeps it empty.
    expect(await readdir(c1.local(P, 'bulk'))).toEqual([]);
    keptEmpty.push('bulk');
    await expectSameTrees();
  }, 300_000);

  it('undoes a rename made by the other computer', async () => {
    const before = await c1.tree(P);
    await sleep(3000);
    const started = Date.now();
    await rename(c1.local(P, LONG1), c1.local(P, 'renamed'));
    await c1.sync(P);
    await c2.sync(P);
    expect(existsSync(c2.local(P, `renamed/${LONG2}/clip.txt`))).toBe(true);
    await sleep(2000);
    const groups = await groupsSince(c2, P, started);
    expect(groups.length).toBeGreaterThan(0);

    await c2.projects.undo(P, groups[0]?.timestampUs ?? 0);
    await c2.sync(P);
    await c1.sync(P);
    await c2.sync(P);

    expect(await c1.tree(P)).toEqual(before);
    await expectSameTrees();
    expect(await c2.read(P, `${LONG1}/${LONG2}/clip.txt`)).toBe('deep');
  }, 900_000);

  it('brings a project deleted from Dropbox back with Undo', async () => {
    const before = await c2.tree(P);
    const remoteBefore = await remotePaths(c2, P);
    await sleep(3000);
    const started = Date.now();
    await c1.projects.delete(P);
    expect(await c2.projects.list()).not.toContain(P);
    await sleep(2000);
    const groups = await groupsSince(c2, P, started);
    expect(groups.length).toBeGreaterThan(0);

    await c2.projects.undo(P, groups[0]?.timestampUs ?? 0);

    expect(await c2.projects.list()).toContain(P);
    expect(await remotePaths(c2, P)).toEqual(remoteBefore);
    expect((await c2.sync(P)).conflicts).toBe(0);
    expect(await c2.tree(P)).toEqual(before);
    // Computer 1 forgot the project when it deleted it, so set it up again.
    await c1.use(P);
    const s1 = await c1.sync(P);
    expect([s1.uploaded, s1.conflicts]).toEqual([0, 0]);
    await expectSameTrees();
  }, 900_000);
});
