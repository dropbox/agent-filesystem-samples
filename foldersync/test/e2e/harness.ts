// Shared setup for the live end-to-end tests: throwaway managed users signed in
// through a running token server, and simulated computers that run the app's
// real Projects code against Dropbox.
import {createHash, randomBytes} from 'node:crypto';
import {mkdir, readFile, readdir, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

import {
  DropboxClient,
  type FileMeta,
  type TokenSource,
  type UploadRequest,
} from '../../src/engine/dropboxApi';
import {Pool} from '../../src/engine/pool';
import {DELETES_AT_ONCE, TRANSFERS_AT_ONCE} from '../../src/engine/syncPass';
import {HttpAgentDirectory, HttpTokenProvider, TokenManager} from '../../src/engine/tokenManager';
import {Settings} from '../../src/main/config';
import {ProjectClients} from '../../src/main/projectClients';
import {Projects} from '../../src/main/projects';
import type {SyncSummary} from '../../src/shared/types';
import {e2eLog, redact} from './log';

// The token server to test against, like http://127.0.0.1:8787. The tests are
// skipped when it isn't set.
export const SERVER = process.env.FOLDERSYNC_E2E_TOKEN_SERVER ?? '';

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// A unique name for a test's project, so tests don't share Dropbox state.
export function projectName(label: string): string {
  return `e2e-${label}-${randomBytes(3).toString('hex')}`;
}

async function tokenServer(path: string, init: RequestInit): Promise<Record<string, unknown>> {
  const res = await fetch(`${SERVER}${path}`, init);
  const body = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    throw new Error(redact(`${path} ${res.status}: ${JSON.stringify(body)}`));
  }
  return body;
}

// A managed user created for the test run. remove() deletes it and its files.
export class TestUser {
  private constructor(
    readonly name: string,
    readonly connectionKey: string,
    readonly accountId: string
  ) {}

  static async create(label: string): Promise<TestUser> {
    const name = `fs-e2e-${label}-${Date.now().toString(36)}`;
    const body = await tokenServer('/login', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({name}),
    });
    return new TestUser(name, String(body.connection_key), String(body.user_public_id));
  }

  async remove(): Promise<void> {
    await tokenServer('/delete-account', {
      method: 'POST',
      headers: {Authorization: `Bearer ${this.connectionKey}`},
    });
  }
}

// Runs during a computer's uploads and downloads, to make changes mid-transfer.
export interface Hooks {
  beforeUpload?: (req: UploadRequest) => Promise<void>;
  afterDownload?: (dropboxPath: string, destPath: string) => Promise<void>;
  beforeDelete?: (dropboxPath: string) => Promise<void>;
}

class HookedClient extends DropboxClient {
  constructor(
    tokens: TokenSource,
    private readonly hooks: Hooks
  ) {
    super({tokens});
  }

  override async upload(req: UploadRequest): Promise<FileMeta> {
    await this.hooks.beforeUpload?.(req);
    return super.upload(req);
  }

  override async deleteV2(dropboxPath: string, parentRev?: string): Promise<void> {
    await this.hooks.beforeDelete?.(dropboxPath);
    return super.deleteV2(dropboxPath, parentRev);
  }

  override async downloadToFile(dropboxPath: string, destPath: string): Promise<FileMeta> {
    const meta = await super.downloadToFile(dropboxPath, destPath);
    await this.hooks.afterDownload?.(dropboxPath, destPath);
    return meta;
  }
}

// One computer signed in as a user, with its own settings and project folders.
export class Computer {
  private constructor(
    readonly label: string,
    readonly dir: string,
    readonly user: TestUser,
    readonly projects: Projects,
    readonly clients: ProjectClients,
    // Read by every client this computer makes, so tests can set them later.
    readonly hooks: Hooks,
    private readonly userTokens: TokenManager
  ) {}

  static async create(root: string, user: TestUser, label: string): Promise<Computer> {
    const dir = join(root, label);
    await mkdir(dir, {recursive: true});
    const settings = await Settings.load(join(dir, 'settings.json'));
    const userTokens = new TokenManager(new HttpTokenProvider(SERVER, user.connectionKey));
    const hooks: Hooks = {};
    const userApi = (): HookedClient => new HookedClient(userTokens, hooks);
    const clients = new ProjectClients(
      userApi,
      () => new HttpAgentDirectory(SERVER, user.connectionKey),
      (tokens) => new HookedClient(tokens, hooks)
    );
    const projects = new Projects({
      settings,
      clients,
      userApi,
      accountId: () => user.accountId,
      onStatus: () => {},
      onActivity: () => {},
      // Each computer runs its own app, with its own pools, as on separate Macs.
      pools: {transfers: new Pool(TRANSFERS_AT_ONCE), deletes: new Pool(DELETES_AT_ONCE)},
    });
    return new Computer(label, dir, user, projects, clients, hooks, userTokens);
  }

  userApi(): DropboxClient {
    return new DropboxClient({tokens: this.userTokens});
  }

  // Points the project at a folder of this computer's own.
  async use(project: string): Promise<void> {
    await this.projects.setLocalDir(project, join(this.dir, project));
  }

  local(project: string, rel = ''): string {
    return join(this.dir, project, rel);
  }

  async write(project: string, rel: string, content: string | Buffer): Promise<void> {
    await mkdir(join(this.local(project, rel), '..'), {recursive: true});
    await writeFile(this.local(project, rel), content);
  }

  read(project: string, rel: string): Promise<string> {
    return readFile(this.local(project, rel), 'utf8');
  }

  async sync(project: string, allowMassDelete = false): Promise<SyncSummary> {
    const s = await this.projects.sync(project, allowMassDelete);
    const issues = s.issues.map((i) => `\n    issue ${i.path}: ${i.message}`).join('');
    const line =
      `${this.label} ${project}: up ${s.uploaded}, down ${s.downloaded}, ` +
      `deleted here ${s.deletedLocal}, deleted in Dropbox ${s.deletedRemote}, ` +
      `conflicts ${s.conflicts}${issues}`;
    e2eLog(line);
    if (process.env.FOLDERSYNC_E2E_VERBOSE) {
      console.log(redact(line));
    }
    return s;
  }

  // Relative path to a SHA-256 for files and 'dir' for folders, without the
  // state folder.
  async tree(project: string): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const walk = async (abs: string, rel: string): Promise<void> => {
      for (const e of await readdir(abs, {withFileTypes: true})) {
        if (rel === '' && e.name === '.foldersync') {
          continue;
        }
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) {
          out.set(r.normalize('NFC'), 'dir');
          await walk(join(abs, e.name), r);
        } else {
          const data = await readFile(join(abs, e.name));
          out.set(r.normalize('NFC'), createHash('sha256').update(data).digest('hex'));
        }
      }
    };
    await walk(this.local(project), '');
    return out;
  }

  // The text of every file in the project, by relative path.
  async contents(project: string): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const [rel, kind] of await this.tree(project)) {
      if (kind !== 'dir') {
        out.set(rel, await this.read(project, rel));
      }
    }
    return out;
  }

  stop(): void {
    this.clients.forgetAll();
    this.userTokens.stop();
  }
}

// The project's paths in Dropbox, lowercase and relative to the project.
export async function remotePaths(computer: Computer, project: string): Promise<Set<string>> {
  const api = computer.userApi();
  const out = new Set<string>();
  const add = (entries: {tag: string; pathLower: string}[]): void => {
    for (const e of entries) {
      if (e.tag !== 'deleted' && e.pathLower !== `/${project.toLowerCase()}`) {
        out.add(e.pathLower.slice(project.length + 2));
      }
    }
  };
  let res = await api.listFolder(`/${project}`, true);
  add(res.entries);
  while (res.hasMore) {
    res = await api.listFolderContinue(res.cursor);
    add(res.entries);
  }
  return out;
}

// Syncs each computer in turn until a full round changes nothing.
export async function settle(project: string, computers: Computer[]): Promise<void> {
  for (let round = 0; round < 5; round++) {
    let changed = false;
    for (const c of computers) {
      const s = await c.sync(project);
      changed ||=
        s.uploaded + s.downloaded + s.deletedLocal + s.deletedRemote + s.conflicts > 0 ||
        s.issues.length > 0;
    }
    if (!changed) {
      return;
    }
  }
  throw new Error(`${project} didn't settle after 5 rounds`);
}

// The undo groups at or after a local time, oldest first. Allows for clock skew.
export async function groupsSince(
  computer: Computer,
  project: string,
  sinceMs: number
): Promise<{timestampUs: number}[]> {
  const groups = await computer.projects.changes(project);
  return groups
    .filter((g) => g.timestampUs >= (sinceMs - 1500) * 1000)
    .sort((a, b) => a.timestampUs - b.timestampUs);
}
