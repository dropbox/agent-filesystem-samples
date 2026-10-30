// Live tests for changes that happen at the same time: computers syncing at
// once, edits during a transfer, and concurrent work across projects and
// managed users. Each test uses a project of its own.
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {afterAll, beforeAll, describe, expect, it} from 'vitest';

import {hashFile} from '../../src/engine/contentHash';
import {DropboxClient} from '../../src/engine/dropboxApi';
import {
  HttpTokenProvider,
  TokenManager,
  type MintedToken,
  type TokenProvider,
} from '../../src/engine/tokenManager';
import {
  Computer,
  SERVER,
  TestUser,
  groupsSince,
  projectName,
  remotePaths,
  settle,
  sleep,
} from './harness';

let root: string;
let alice: TestUser;
let bob: TestUser;
// Three computers signed in as alice, and one as bob.
let c1: Computer;
let c2: Computer;
let c3: Computer;
let bobs: Computer;

// Creates a project, writes files on computer 1, and syncs them to the others.
async function project(
  label: string,
  files: Record<string, string>,
  computers: Computer[] = [c1, c2]
): Promise<string> {
  const p = projectName(label);
  await c1.projects.create(p);
  for (const c of computers) {
    await c.use(p);
  }
  for (const [rel, content] of Object.entries(files)) {
    await c1.write(p, rel, content);
  }
  await settle(p, computers);
  return p;
}

// Every file's text in the project, sorted, after checking the computers agree.
async function agreedContents(p: string, computers: Computer[]): Promise<string[]> {
  const [first, ...rest] = computers;
  if (!first) {
    throw new Error('no computers');
  }
  const expected = await first.tree(p);
  for (const c of rest) {
    expect(await c.tree(p)).toEqual(expected);
  }
  return [...(await first.contents(p)).values()].sort();
}

// Runs fn once, for the first transfer of a file with this name.
function once<A extends unknown[]>(
  name: string,
  fn: (...args: A) => Promise<void>
): (path: string, ...args: A) => Promise<void> {
  let done = false;
  return async (path, ...args) => {
    if (!done && path.endsWith(`/${name}`)) {
      done = true;
      await fn(...args);
    }
  };
}

// A gate a hook waits at until the test releases it.
function held(): {
  reached: () => void;
  reachedPromise: Promise<void>;
  release: () => void;
  released: Promise<void>;
} {
  let reached = (): void => {};
  let release = (): void => {};
  const reachedPromise = new Promise<void>((r) => (reached = r));
  const released = new Promise<void>((r) => (release = r));
  return {reached, reachedPromise, release, released};
}

describe.skipIf(!SERVER)('live races', () => {
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'foldersync-e2e-races-'));
    process.env.FOLDERSYNC_PROJECTS = join(root, 'default-projects');
    alice = await TestUser.create('alice');
    bob = await TestUser.create('bob');
    c1 = await Computer.create(root, alice, 'alice1');
    c2 = await Computer.create(root, alice, 'alice2');
    c3 = await Computer.create(root, alice, 'alice3');
    bobs = await Computer.create(root, bob, 'bob1');
  });

  afterAll(async () => {
    for (const c of [c1, c2, c3, bobs]) {
      c?.stop();
    }
    // Delete both users and the folder even if one step fails.
    const removed = await Promise.allSettled([alice?.remove(), bob?.remove()]);
    await rm(root, {recursive: true, force: true});
    const failed = removed.find((r) => r.status === 'rejected');
    if (failed) {
      throw failed.reason;
    }
  });

  describe('the same file at the same time', () => {
    it('keeps both versions when two computers edit a file and sync at once', async () => {
      const p = await project('same-edit', {'a.txt': 'base'});
      await c1.write(p, 'a.txt', 'from c1');
      await c2.write(p, 'a.txt', 'from c2');

      await Promise.all([c1.sync(p), c2.sync(p)]);
      await settle(p, [c1, c2]);

      expect(await agreedContents(p, [c1, c2])).toEqual(['from c1', 'from c2']);
    }, 300_000);

    it('keeps both files when two computers create one name at once', async () => {
      const p = await project('same-new', {});
      await c1.write(p, 'new.txt', 'from c1');
      await c2.write(p, 'new.txt', 'from c2');

      await Promise.all([c1.sync(p), c2.sync(p)]);
      await settle(p, [c1, c2]);

      expect(await agreedContents(p, [c1, c2])).toEqual(['from c1', 'from c2']);
    }, 300_000);

    it('keeps all three versions when three computers edit a file at once', async () => {
      const p = await project('three-edits', {'a.txt': 'base'}, [c1, c2, c3]);
      await c1.write(p, 'a.txt', 'from c1');
      await c2.write(p, 'a.txt', 'from c2');
      await c3.write(p, 'a.txt', 'from c3');

      await Promise.all([c1.sync(p), c2.sync(p), c3.sync(p)]);
      await settle(p, [c1, c2, c3]);

      expect(await agreedContents(p, [c1, c2, c3])).toEqual(['from c1', 'from c2', 'from c3']);
    }, 300_000);
  });

  describe('edits and deletes at the same time', () => {
    // Skipped: when an edit and a delete reach Dropbox at the same moment,
    // Dropbox can apply both, so the edit is lost even though the delete sent
    // the file's revision. It needs a fix in Dropbox's delete.
    it.skip('keeps an edit when another computer deletes the file at once', async () => {
      const p = await project('edit-delete', {'a.txt': 'base', 'b.txt': 'other'});
      await c1.write(p, 'a.txt', 'edited');
      await rm(c2.local(p, 'a.txt'));

      await Promise.all([c1.sync(p), c2.sync(p)]);
      await settle(p, [c1, c2]);

      expect(await agreedContents(p, [c1, c2])).toEqual(['edited', 'other']);
    }, 300_000);

    it('keeps an edit when the other computer deletes the file just before it uploads', async () => {
      const p = await project('delete-first', {'a.txt': 'base', 'b.txt': 'other'});
      await c1.write(p, 'a.txt', 'edited');
      await rm(c2.local(p, 'a.txt'));
      const gate = held();
      const wait = once('a.txt', async () => {
        gate.reached();
        await gate.released;
      });
      c1.hooks.beforeUpload = (req) => wait(req.dropboxPath);

      const pass1 = c1.sync(p);
      await gate.reachedPromise;
      await c2.sync(p);
      gate.release();
      const s1 = await pass1.finally(() => (c1.hooks.beforeUpload = undefined));
      await settle(p, [c1, c2]);

      // Dropbox keeps the edit under a conflicted name; nothing else to report.
      expect(s1.issues.filter((i) => !i.message.startsWith('Conflict:'))).toEqual([]);
      expect(await agreedContents(p, [c1, c2])).toEqual(['edited', 'other']);
    }, 300_000);

    it('keeps an edit when the other computer sends its delete just after the upload', async () => {
      const p = await project('delete-after', {'a.txt': 'base', 'b.txt': 'other'});
      await c1.write(p, 'a.txt', 'edited');
      await rm(c2.local(p, 'a.txt'));
      const gate = held();
      c2.hooks.beforeDelete = once('a.txt', async () => {
        gate.reached();
        await gate.released;
      });

      const pass2 = c2.sync(p);
      await gate.reachedPromise;
      await c1.sync(p);
      gate.release();
      await pass2.finally(() => (c2.hooks.beforeDelete = undefined));
      await settle(p, [c1, c2]);

      expect(await agreedContents(p, [c1, c2])).toEqual(['edited', 'other']);
    }, 300_000);

    it('deletes a file once when both computers delete it at once', async () => {
      const p = await project('delete-delete', {'a.txt': 'base', 'b.txt': 'other'});
      await rm(c1.local(p, 'a.txt'));
      await rm(c2.local(p, 'a.txt'));

      await Promise.all([c1.sync(p), c2.sync(p)]);
      await settle(p, [c1, c2]);

      expect(await agreedContents(p, [c1, c2])).toEqual(['other']);
      expect(await remotePaths(c1, p)).toEqual(new Set(['b.txt']));
    }, 300_000);

    it('keeps a file added to a folder that another computer deletes at once', async () => {
      const p = await project('folder-delete-add', {'f/a.txt': 'a'});
      await rm(c1.local(p, 'f'), {recursive: true});
      await c2.write(p, 'f/new.txt', 'new');

      await Promise.all([c1.sync(p), c2.sync(p)]);
      await settle(p, [c1, c2]);

      expect(await agreedContents(p, [c1, c2])).toEqual(['new']);
      expect(await c1.read(p, 'f/new.txt')).toBe('new');
      expect((await remotePaths(c1, p)).has('f/a.txt')).toBe(false);
    }, 300_000);
  });

  describe('edits during a transfer', () => {
    it('uploads the newest version when a file changes while it uploads', async () => {
      const p = await project('edit-upload', {});
      await c1.write(p, 'x.txt', 'v1');
      const edit = once('x.txt', async (localPath: string) => {
        await sleep(20);
        await writeFile(localPath, 'v2');
      });
      c1.hooks.beforeUpload = (req) => edit(req.dropboxPath, req.localPath);

      try {
        await c1.sync(p);
      } finally {
        c1.hooks.beforeUpload = undefined;
      }
      await settle(p, [c1, c2]);

      expect(await agreedContents(p, [c1, c2])).toEqual(['v2']);
    }, 300_000);

    it('keeps a local edit made while a download replaces the file', async () => {
      const p = await project('edit-download', {'y.txt': 'base'});
      await c1.write(p, 'y.txt', 'remote edit');
      await c1.sync(p);
      c2.hooks.afterDownload = once('y.txt', async () => {
        await sleep(20);
        await writeFile(c2.local(p, 'y.txt'), 'local edit');
      });

      try {
        await c2.sync(p);
      } finally {
        c2.hooks.afterDownload = undefined;
      }
      await settle(p, [c1, c2]);

      expect(await agreedContents(p, [c1, c2])).toEqual(['local edit', 'remote edit']);
    }, 300_000);
  });

  describe('projects and managed users', () => {
    it('syncs two projects at once without mixing them, each with its own agent', async () => {
      const a = await project('two-a', {});
      const b = await project('two-b', {});
      await c1.write(a, 'a.txt', 'A');
      await c1.write(b, 'b.txt', 'B');

      await Promise.all([c1.sync(a), c1.sync(b)]);
      await Promise.all([c2.sync(a), c2.sync(b)]);

      expect(await c2.contents(a)).toEqual(new Map([['a.txt', 'A']]));
      expect(await c2.contents(b)).toEqual(new Map([['b.txt', 'B']]));
      const [agentA, agentB] = await Promise.all([c1.clients.agent(a), c1.clients.agent(b)]);
      expect(agentA.agentId).not.toBe(agentB.agentId);
    }, 300_000);

    it('undoes one project and leaves the other alone', async () => {
      const a = await project('undo-a', {'a.txt': 'A1'});
      const b = await project('undo-b', {'b.txt': 'B1'});
      await sleep(3000);
      const started = Date.now();
      await c1.write(a, 'a.txt', 'A2');
      await c1.write(b, 'b.txt', 'B2');
      await Promise.all([c1.sync(a), c1.sync(b)]);
      await sleep(2000);
      const groups = await groupsSince(c1, a, started);
      expect(groups.length).toBeGreaterThan(0);

      await c1.projects.undo(a, groups[0]?.timestampUs ?? 0);
      await settle(a, [c1]);
      await settle(b, [c1]);

      expect(await c1.read(a, 'a.txt')).toBe('A1');
      expect(await c1.read(b, 'b.txt')).toBe('B2');
    }, 600_000);

    it('keeps two users with the same project name apart when they sync at once', async () => {
      const p = projectName('shared-name');
      await Promise.all([c1.projects.create(p), bobs.projects.create(p)]);
      await c1.use(p);
      await bobs.use(p);
      await c1.write(p, 'from-alice.txt', 'alice');
      await bobs.write(p, 'from-bob.txt', 'bob');

      await Promise.all([c1.sync(p), bobs.sync(p)]);

      expect(await remotePaths(c1, p)).toEqual(new Set(['from-alice.txt']));
      expect(await remotePaths(bobs, p)).toEqual(new Set(['from-bob.txt']));
      const [agentA, agentB] = await Promise.all([c1.clients.agent(p), bobs.clients.agent(p)]);
      expect(agentA.agentId).not.toBe(agentB.agentId);
    }, 300_000);

    it('gives a project one agent when two computers create it at once', async () => {
      const p = projectName('agent-race');
      await c1.projects.create(p);

      const [first, second] = await Promise.all([c2.clients.agent(p), c3.clients.agent(p)]);

      expect(second.agentId).toBe(first.agentId);
      expect((await c1.clients.agent(p)).agentId).toBe(first.agentId);
    }, 300_000);
  });

  describe('undo and tokens', () => {
    it('keeps a change made outside FolderSync when undoing', async () => {
      const p = await project('undo-other', {'a.txt': 'base'});
      await sleep(3000);
      const started = Date.now();
      await c1.write(p, 'a.txt', 'agent edit');
      await c1.sync(p);
      // Another client writes with the user's token, not the project's agent.
      const other = join(root, 'other.txt');
      await writeFile(other, 'from another client');
      await c1.userApi().upload({
        localPath: other,
        dropboxPath: `/${p}/other.txt`,
        mode: {kind: 'add'},
        clientModified: new Date(),
        contentHash: await hashFile(other),
        checkUnchanged: async () => {},
      });
      await sleep(2000);
      const groups = await groupsSince(c1, p, started);
      expect(groups.length).toBeGreaterThan(0);

      await c1.projects.undo(p, groups[0]?.timestampUs ?? 0);
      await settle(p, [c1, c2]);

      expect(await c1.read(p, 'a.txt')).toBe('base');
      expect(await c1.read(p, 'other.txt')).toBe('from another client');
      expect(await agreedContents(p, [c1, c2])).toEqual(['base', 'from another client']);
    }, 600_000);

    it('renews a rejected token once for many requests at the same time', async () => {
      const p = await project('token', {'a.txt': 'base'});
      let mints = 0;
      const inner = new HttpTokenProvider(SERVER, alice.connectionKey);
      const provider: TokenProvider = {
        fetchToken: async (): Promise<MintedToken> => {
          mints++;
          return inner.fetchToken();
        },
      };
      const tokens = new TokenManager(
        provider,
        {},
        {
          accessToken: 'not-a-real-token',
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        }
      );
      const api = new DropboxClient({tokens});

      try {
        const results = await Promise.all(
          Array.from({length: 10}, () => api.listFolder(`/${p}`, false))
        );

        expect(results.every((r) => r.entries.some((e) => e.pathLower.endsWith('/a.txt')))).toBe(
          true
        );
        expect(mints).toBe(1);
      } finally {
        tokens.stop();
      }
    }, 300_000);
  });
});
