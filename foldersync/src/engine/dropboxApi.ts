// A small Dropbox API v2 client for the files/* routes the sync pass uses, and
// rpc() for other routes. Uploads send their data in parallel and commit in
// batches, one batch at a time, since Dropbox limits how many writes run at
// once in an account.
import {constants} from 'node:fs';
import {open, rm, stat} from 'node:fs/promises';

import {ContentHasher, hashBuffer} from './contentHash';

export interface FileMeta {
  tag: 'file';
  id: string;
  pathLower: string;
  pathDisplay: string;
  rev: string;
  contentHash: string;
  size: number;
  clientModified: Date;
  serverModified: Date;
}

export interface FolderMeta {
  tag: 'folder';
  id: string;
  pathLower: string;
  pathDisplay: string;
}

export interface DeletedMeta {
  tag: 'deleted';
  pathLower: string;
  pathDisplay: string;
}

export type Metadata = FileMeta | FolderMeta | DeletedMeta;

export interface ListResult {
  entries: Metadata[];
  cursor: string;
  hasMore: boolean;
}

export type WriteMode = {kind: 'add'} | {kind: 'update'; rev: string};

export interface UploadRequest {
  localPath: string;
  dropboxPath: string;
  mode: WriteMode;
  clientModified: Date;
  contentHash: string;
  // Throws if the local file changed since it was hashed.
  checkUnchanged: () => Promise<void>;
}

// The routes the sync pass needs. The HTTP client and test fakes implement it.
export interface DropboxFiles {
  listFolder(path: string, recursive: boolean): Promise<ListResult>;
  listFolderContinue(cursor: string): Promise<ListResult>;
  downloadToFile(dropboxPath: string, destPath: string): Promise<FileMeta>;
  upload(req: UploadRequest): Promise<FileMeta>;
  deleteV2(dropboxPath: string, parentRev?: string): Promise<void>;
  createFolder(dropboxPath: string): Promise<void>;
}

// An error response from Dropbox.
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly summary: string,
    // The parsed JSON error body, if there was one.
    readonly body?: unknown
  ) {
    super(`Dropbox returned HTTP ${status}: ${summary}`);
  }
}

export function isConflict(err: unknown): boolean {
  return err instanceof ApiError && err.status === 409 && err.summary.includes('conflict');
}

export function isNotFound(err: unknown): boolean {
  return err instanceof ApiError && err.status === 409 && err.summary.includes('not_found');
}

// Spaces out requests after Dropbox asks a client to slow down. Every client
// shares one, since the limit is per account.
export class Pacer {
  private notBefore = 0;
  // How many times Dropbox has asked to slow down.
  throttles = 0;

  constructor(private readonly now: () => number = Date.now) {}

  // Waits until requests may be sent again, including any wait added meanwhile.
  async wait(sleep: (ms: number) => Promise<void>): Promise<void> {
    for (let ms = this.notBefore - this.now(); ms > 0; ms = this.notBefore - this.now()) {
      await sleep(ms);
    }
  }

  throttled(ms: number): void {
    this.throttles++;
    this.notBefore = Math.max(this.notBefore, this.now() + ms);
  }
}

export const sharedPacer = new Pacer();

export interface TokenSource {
  getToken(): Promise<string>;
  // Gets a new token after the current one was rejected.
  renewToken(): Promise<string>;
}

export interface ClientOptions {
  tokens: TokenSource;
  apiOrigin?: string;
  contentOrigin?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  pacer?: Pacer;
  // Commit a batch once this many uploads are waiting, or after batchIdleMs
  // with no new upload.
  batchSize?: number;
  batchIdleMs?: number;
}

export interface RpcOptions {
  retry?: boolean;
}

// Upload session chunks, a multiple of 4 MiB, so an upload holds at most one
// chunk in memory.
const SESSION_CHUNK = 16 * 1024 * 1024;
// The longest Retry-After to wait out. A call asked to wait longer fails.
const MAX_RETRY_DELAY_MS = 60 * 1000;
const MAX_RETRIES = 4;
// How many times to retry after Dropbox asks to slow down.
const MAX_THROTTLED_RETRIES = 10;
// finish_batch_v2 takes at most 1,000 entries.
const MAX_BATCH = 1000;
const BATCH_SIZE = 6;
const BATCH_IDLE_MS = 200;
// How long to wait after Dropbox asks a batch entry to slow down.
const THROTTLED_ENTRY_DELAY_MS = 1000;
// How long an RPC call or an upload request may take, including its response.
const RPC_TIMEOUT_MS = 2 * 60 * 1000;
const UPLOAD_TIMEOUT_MS = 10 * 60 * 1000;
// How long a download may go without receiving data.
const DOWNLOAD_IDLE_MS = 60 * 1000;

export class DropboxClient implements DropboxFiles {
  private readonly apiOrigin: string;
  private readonly contentOrigin: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly pacer: Pacer;
  private readonly batcher: CommitBatcher;
  // Uploads still sending data, so the batcher knows when every upload is
  // waiting for its commit.
  private sendingData = 0;

  constructor(private readonly opts: ClientOptions) {
    this.apiOrigin = opts.apiOrigin ?? 'https://api.dropboxapi.com';
    this.contentOrigin = opts.contentOrigin ?? 'https://content.dropboxapi.com';
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.pacer = opts.pacer ?? sharedPacer;
    this.batcher = new CommitBatcher(
      (entries) => this.finishBatch(entries),
      () => this.sendingData,
      opts.batchSize ?? BATCH_SIZE,
      opts.batchIdleMs ?? BATCH_IDLE_MS
    );
  }

  // Leaves out files that can't be downloaded, such as Paper and Google docs.
  async listFolder(path: string, recursive: boolean): Promise<ListResult> {
    return parseListResult(
      await this.rpc('files/list_folder', {
        path,
        recursive,
        include_deleted: false,
        include_non_downloadable_files: false,
      })
    );
  }

  async listFolderContinue(cursor: string): Promise<ListResult> {
    return parseListResult(await this.rpc('files/list_folder/continue', {cursor}));
  }

  async downloadToFile(dropboxPath: string, destPath: string): Promise<FileMeta> {
    const idle = new IdleTimeout(DOWNLOAD_IDLE_MS, 'Dropbox stopped sending the file.');
    try {
      const res = await this.send(`${this.contentOrigin}/2/files/download`, (token) => ({
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Dropbox-API-Arg': headerJson({path: dropboxPath}),
        },
        signal: idle.restart(),
      }));
      await throwIfError(res);
      let meta: FileMeta;
      let file: Awaited<ReturnType<typeof open>>;
      try {
        meta = parseFileMeta(JSON.parse(res.headers.get('dropbox-api-result') ?? '{}'));
        file = await open(destPath, 'w', 0o644);
      } catch (err) {
        await res.body?.cancel();
        throw err;
      }
      const hasher = new ContentHasher();
      try {
        try {
          if (res.body) {
            for await (const chunk of res.body) {
              idle.restart();
              hasher.update(chunk);
              await writeAll(file, chunk);
            }
          }
        } finally {
          await file.close();
        }
        if (hasher.digest() !== meta.contentHash) {
          throw new Error(`The download of ${dropboxPath} doesn’t match its content hash.`);
        }
      } catch (err) {
        // Leave no partial or damaged file at destPath.
        await rm(destPath, {force: true});
        throw err;
      }
      return meta;
    } finally {
      idle.stop();
    }
  }

  // Uploads the file's data in an upload session, then commits it in a batch.
  async upload(req: UploadRequest): Promise<FileMeta> {
    const commit = {
      path: req.dropboxPath,
      mode: req.mode.kind === 'add' ? 'add' : {'.tag': 'update', update: req.mode.rev},
      autorename: true,
      strict_conflict: true,
      client_modified: dropboxTime(req.clientModified),
    };
    let size: number;
    let sessionId: string;
    this.sendingData++;
    try {
      size = (await stat(req.localPath)).size;
      // O_NOFOLLOW: if the file was swapped for a symlink, fail instead of uploading its target.
      const file = await open(req.localPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        sessionId = await this.uploadData(file, size, req);
      } finally {
        await file.close();
      }
      await req.checkUnchanged();
    } catch (err) {
      this.sendingData--;
      // The other uploads may all be waiting for commits now.
      this.batcher.schedule();
      throw err;
    }
    // In the same step, so a batch never goes out between the two.
    this.sendingData--;
    const committed = this.batcher.commit({cursor: {session_id: sessionId, offset: size}, commit});
    let meta: FileMeta;
    try {
      meta = await committed;
    } catch (err) {
      if (!(err instanceof UnconfirmedCommit)) {
        throw err;
      }
      meta = await this.confirmUpload(req, err);
    }
    // The batch commit doesn't check content hashes, so check the result.
    if (meta.contentHash !== req.contentHash) {
      throw new Error(`The upload of ${req.dropboxPath} doesn’t match its content hash.`);
    }
    return meta;
  }

  async getMetadata(dropboxPath: string): Promise<Metadata> {
    return parseMetadata(await this.rpc('files/get_metadata', {path: dropboxPath}));
  }

  // Deletes a file or folder. With parentRev, Dropbox refuses if the file
  // changed, so a retry is safe; a folder delete is recursive, so it isn't
  // retried after a server error.
  async deleteV2(dropboxPath: string, parentRev?: string): Promise<void> {
    await this.rpc(
      'files/delete_v2',
      parentRev === undefined ? {path: dropboxPath} : {path: dropboxPath, parent_rev: parentRev},
      {retry: parentRev !== undefined}
    );
  }

  async createFolder(dropboxPath: string): Promise<void> {
    try {
      await this.rpc('files/create_folder_v2', {path: dropboxPath, autorename: false});
    } catch (err) {
      // A folder is already there. A file with that name is still an error.
      if (!(err instanceof ApiError && err.summary.startsWith('path/conflict/folder'))) {
        throw err;
      }
    }
  }

  // Sends the file's data to a new upload session, closed after the last
  // chunk, and returns its ID. Each call carries its own bytes' hash, so
  // Dropbox rejects a damaged chunk.
  private async uploadData(
    file: Awaited<ReturnType<typeof open>>,
    size: number,
    req: UploadRequest
  ): Promise<string> {
    const first = await readChunk(file, 0, Math.min(SESSION_CHUNK, size));
    let offset = first.length;
    if (offset === size) {
      await req.checkUnchanged();
    }
    const started = await this.content(
      'files/upload_session/start',
      {close: offset === size, content_hash: hashBuffer(first)},
      first
    );
    const sessionId = requireString(started, 'session_id');
    while (offset < size) {
      await req.checkUnchanged();
      const chunk = await readChunk(file, offset, Math.min(SESSION_CHUNK, size - offset));
      const close = offset + chunk.length === size;
      if (close) {
        await req.checkUnchanged();
      }
      try {
        await this.content(
          'files/upload_session/append_v2',
          {cursor: {session_id: sessionId, offset}, close, content_hash: hashBuffer(chunk)},
          chunk
        );
      } catch (err) {
        // A retry after a lost response finds the chunk already appended.
        if (correctOffset(err) !== offset + chunk.length) {
          throw err;
        }
      }
      offset += chunk.length;
    }
    return sessionId;
  }

  // Commits a batch of closed upload sessions. Never retried after an unclear
  // failure: committing a session again saves a second copy.
  private async finishBatch(entries: CommitEntry[]): Promise<CommitResult[]> {
    let res: unknown;
    try {
      res = await this.rpc('files/upload_session/finish_batch_v2', {entries}, {retry: false});
    } catch (err) {
      // The server answered that it didn't commit anything.
      if (err instanceof ApiError && err.status < 500) {
        throw err;
      }
      throw new UnconfirmedCommit(err);
    }
    const results = isRecord(res) && Array.isArray(res.entries) ? res.entries : [];
    if (results.length !== entries.length) {
      throw new UnconfirmedCommit(new Error('Dropbox returned an incomplete batch result.'));
    }
    const parsed = results.map((r): CommitResult => {
      if (isRecord(r) && r['.tag'] === 'success') {
        return {meta: parseFileMeta({...r, '.tag': 'file'})};
      }
      const failure = isRecord(r) ? r.failure : undefined;
      const summary = tagPath(failure);
      return {
        error: new ApiError(409, summary, {error: failure}),
        throttled: summary.startsWith('too_many_write_operations'),
      };
    });
    if (parsed.some((r) => 'throttled' in r && r.throttled)) {
      this.pacer.throttled(THROTTLED_ENTRY_DELAY_MS);
    }
    return parsed;
  }

  // Checks whether an upload whose commit got no clear answer was saved: the
  // file in Dropbox has this content. Otherwise the next pass syncs it again.
  private async confirmUpload(req: UploadRequest, err: UnconfirmedCommit): Promise<FileMeta> {
    const meta = await this.getMetadata(req.dropboxPath).catch(() => undefined);
    if (meta?.tag === 'file' && meta.contentHash === req.contentHash) {
      return meta;
    }
    throw new Error(
      `Couldn’t confirm that ${req.dropboxPath} was saved (${errorText(err.cause)}). It will be synced again.`
    );
  }

  // Calls an RPC route. Pass retry: false for routes that aren't safe to repeat
  // after a server error.
  async rpc(route: string, arg: unknown, opts: RpcOptions = {}): Promise<unknown> {
    const body = JSON.stringify(arg);
    return withDeadline(RPC_TIMEOUT_MS, async (signal) => {
      const init = (token: string): RequestInit => ({
        method: 'POST',
        headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'},
        body,
        signal,
      });
      const res = await this.send(`${this.apiOrigin}/2/${route}`, init, opts.retry ?? true, signal);
      await throwIfError(res);
      return res.json();
    });
  }

  // Uploads data to a content route. Routes that commit a file pass retry: false:
  // replaying a commit that succeeded would save a second, conflicted copy.
  private async content(
    route: string,
    arg: unknown,
    data: Uint8Array,
    opts: RpcOptions = {}
  ): Promise<unknown> {
    return withDeadline(UPLOAD_TIMEOUT_MS, async (signal) => {
      const init = (token: string): RequestInit => ({
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/octet-stream',
          'Dropbox-API-Arg': headerJson(arg),
        },
        body: data,
        signal,
      });
      const res = await this.send(
        `${this.contentOrigin}/2/${route}`,
        init,
        opts.retry ?? true,
        signal
      );
      await throwIfError(res);
      return res.json();
    });
  }

  // Sends a request, renewing the token once on 401 and retrying 429. Unless
  // retry is false, it also retries 5xx and network errors. A new token can
  // also fix missing_scope after the token server starts asking for more scopes.
  // waitUntil, if set, ends retry waits early, for a call with a deadline.
  private async send(
    url: string,
    init: (token: string) => RequestInit,
    retry = true,
    waitUntil?: AbortSignal
  ): Promise<Response> {
    let token = await this.opts.tokens.getToken();
    let renewed = false;
    let throttledRetries = 0;
    for (let attempt = 0; ; attempt++) {
      await untilAborted(this.pacer.wait(this.sleep), waitUntil);
      const request = init(token);
      let res: Response;
      try {
        res = await this.fetchImpl(url, request);
      } catch (err) {
        if (!retry || request.signal?.aborted || attempt >= MAX_RETRIES) {
          throw err;
        }
        await untilAborted(this.sleep(500 * 2 ** attempt), waitUntil);
        continue;
      }
      if (res.status === 401 && !renewed) {
        const text = await res.text();
        if (/expired_access_token|invalid_access_token|missing_scope/.test(text)) {
          renewed = true;
          // Another request may have renewed it already; mint only if not.
          const current = await this.opts.tokens.getToken();
          token = current !== token ? current : await this.opts.tokens.renewToken();
          continue;
        }
        throw new ApiError(401, summaryOf(text));
      }
      const delay = retryDelayMs(res, attempt);
      if (
        res.status === 429 &&
        throttledRetries < MAX_THROTTLED_RETRIES &&
        delay <= MAX_RETRY_DELAY_MS
      ) {
        // Every client waits it out, since the limit is per account.
        throttledRetries++;
        attempt--;
        await res.body?.cancel();
        this.pacer.throttled(delay);
        continue;
      }
      if (retry && res.status >= 500 && attempt < MAX_RETRIES && delay <= MAX_RETRY_DELAY_MS) {
        await res.body?.cancel();
        await untilAborted(this.sleep(delay), waitUntil);
        continue;
      }
      return res;
    }
  }
}

const NO_ANSWER = 'Dropbox didn’t answer in time.';

// One file in a finish_batch_v2 request.
interface CommitEntry {
  cursor: {session_id: string; offset: number};
  commit: Record<string, unknown>;
}

type CommitResult = {meta: FileMeta} | {error: ApiError; throttled: boolean};

// A batch commit that failed without saying whether it saved anything.
class UnconfirmedCommit extends Error {
  constructor(override readonly cause: unknown) {
    super(errorText(cause));
  }
}

// Collects upload commits and sends them in batches, one batch at a time. A
// batch goes out once every upload is waiting for its commit, once batchSize
// are waiting, or after idleMs with no new one. A commit Dropbox asks to slow
// down goes in the next batch.
class CommitBatcher {
  private pending: {
    entry: CommitEntry;
    retries: number;
    resolve: (meta: FileMeta) => void;
    reject: (err: unknown) => void;
  }[] = [];
  private timer: NodeJS.Timeout | undefined;
  private sending = false;

  constructor(
    private readonly send: (entries: CommitEntry[]) => Promise<CommitResult[]>,
    // Uploads that will ask for a commit but haven't yet.
    private readonly coming: () => number,
    private readonly batchSize: number,
    private readonly idleMs: number
  ) {}

  commit(entry: CommitEntry): Promise<FileMeta> {
    return new Promise((resolve, reject) => {
      this.pending.push({entry, retries: 0, resolve, reject});
      this.schedule();
    });
  }

  schedule(): void {
    if (this.sending || this.pending.length === 0) {
      return;
    }
    clearTimeout(this.timer);
    if (this.pending.length >= this.batchSize || this.coming() === 0) {
      void this.flush();
    } else {
      this.timer = setTimeout(() => void this.flush(), this.idleMs);
    }
  }

  private async flush(): Promise<void> {
    clearTimeout(this.timer);
    if (this.sending) {
      return;
    }
    this.sending = true;
    const batch = this.pending.splice(0, MAX_BATCH);
    try {
      const results = await this.send(batch.map((p) => p.entry));
      results.forEach((r, i) => {
        const p = batch[i];
        if (!p) {
          return;
        }
        if ('meta' in r) {
          p.resolve(r.meta);
        } else if (r.throttled && p.retries < MAX_THROTTLED_RETRIES) {
          p.retries++;
          this.pending.push(p);
        } else {
          p.reject(r.error);
        }
      });
    } catch (err) {
      for (const p of batch) {
        p.reject(err);
      }
    } finally {
      this.sending = false;
      this.schedule();
    }
  }
}

// Waits for promise, or rejects with the signal's reason as soon as it aborts.
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) {
    return promise;
  }
  if (signal.aborted) {
    return Promise.reject(signal.reason);
  }
  return new Promise((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener('abort', onAbort, {once: true});
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      }
    );
  });
}

// Runs a request with a signal that aborts after ms, across retries and while
// the response is read. The timer stops when the request finishes.
async function withDeadline<T>(
  ms: number,
  request: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(NO_ANSWER)), ms);
  try {
    // A token renewal doesn't take the signal, so the race also ends that wait.
    return await untilAborted(request(controller.signal), controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

// Aborts when restart() isn't called for ms. Each restart() returns a new
// signal for the next attempt.
class IdleTimeout {
  private controller = new AbortController();
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly ms: number,
    private readonly message: string
  ) {}

  restart(): AbortSignal {
    clearTimeout(this.timer);
    if (this.controller.signal.aborted) {
      this.controller = new AbortController();
    }
    const controller = this.controller;
    this.timer = setTimeout(() => controller.abort(new Error(this.message)), this.ms);
    return controller.signal;
  }

  stop(): void {
    clearTimeout(this.timer);
  }
}

async function throwIfError(res: Response): Promise<void> {
  if (!res.ok) {
    const text = await res.text();
    throw new ApiError(res.status, summaryOf(text), parseJson(text));
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// The offset Dropbox expects next, from an append's incorrect_offset error.
function correctOffset(err: unknown): number | undefined {
  if (!(err instanceof ApiError) || err.status !== 409 || !isRecord(err.body)) {
    return undefined;
  }
  const error = err.body.error;
  if (!isRecord(error) || error['.tag'] !== 'incorrect_offset') {
    return undefined;
  }
  const offset = error.correct_offset;
  return Number.isSafeInteger(offset) ? Number(offset) : undefined;
}

// Retry-After if the response has it, else exponential backoff.
function retryDelayMs(res: Response, attempt: number): number {
  const seconds = Number(res.headers.get('retry-after'));
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 500 * 2 ** attempt;
}

// Joins nested '.tag' values the way error_summary does, like 'path/conflict/file/'.
function tagPath(v: unknown): string {
  let out = '';
  let node = v;
  while (isRecord(node) && typeof node['.tag'] === 'string') {
    const tag = node['.tag'];
    out += `${tag}/`;
    node = node[tag];
  }
  return out || 'unknown/';
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function summaryOf(text: string): string {
  try {
    const parsed: unknown = JSON.parse(text);
    if (isRecord(parsed) && typeof parsed.error_summary === 'string') {
      return parsed.error_summary;
    }
  } catch {
    // Not JSON; use the text.
  }
  return text.trim();
}

async function readChunk(
  file: Awaited<ReturnType<typeof open>>,
  position: number,
  length: number
): Promise<Uint8Array> {
  const buffer = Buffer.alloc(length);
  let filled = 0;
  while (filled < length) {
    // A read can return fewer bytes than asked, for example on a network drive.
    const {bytesRead} = await file.read(buffer, filled, length - filled, position + filled);
    if (bytesRead === 0) {
      throw new Error('The file got shorter while it was being uploaded.');
    }
    filled += bytesRead;
  }
  return buffer;
}

// Dropbox-API-Arg must be ASCII, so non-ASCII characters are escaped.
function headerJson(arg: unknown): string {
  return JSON.stringify(arg).replace(
    /[\u007f-\uffff]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`
  );
}

// Dropbox accepts UTC timestamps with second precision.
function dropboxTime(date: Date): string {
  return `${date.toISOString().slice(0, 19)}Z`;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function requireString(v: unknown, key: string): string {
  if (isRecord(v) && typeof v[key] === 'string') {
    return v[key];
  }
  throw new Error(`Dropbox response is missing ${key}.`);
}

function requireSize(v: unknown, key: string): number {
  if (isRecord(v) && Number.isSafeInteger(v[key]) && Number(v[key]) >= 0) {
    return Number(v[key]);
  }
  throw new Error(`Dropbox response has no valid ${key}.`);
}

function requireDate(v: unknown, key: string): Date {
  const date = new Date(requireString(v, key));
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Dropbox response has no valid ${key}.`);
  }
  return date;
}

function parseMetadata(v: unknown): Metadata {
  if (!isRecord(v)) {
    throw new Error('Dropbox metadata is not an object.');
  }
  const tag = v['.tag'];
  const pathLower = requireString(v, 'path_lower');
  const pathDisplay = requireString(v, 'path_display');
  if (tag === 'deleted') {
    return {tag, pathLower, pathDisplay};
  }
  if (tag === 'folder') {
    return {tag, id: requireString(v, 'id'), pathLower, pathDisplay};
  }
  if (tag === 'file') {
    return {
      tag,
      id: requireString(v, 'id'),
      pathLower,
      pathDisplay,
      rev: requireString(v, 'rev'),
      contentHash: requireString(v, 'content_hash'),
      size: requireSize(v, 'size'),
      clientModified: requireDate(v, 'client_modified'),
      serverModified: requireDate(v, 'server_modified'),
    };
  }
  throw new Error(`Unknown Dropbox metadata type: ${String(tag)}`);
}

function parseFileMeta(v: unknown): FileMeta {
  // Upload and download responses are file metadata without a '.tag'.
  const meta = parseMetadata(isRecord(v) && v['.tag'] === undefined ? {...v, '.tag': 'file'} : v);
  if (meta.tag !== 'file') {
    throw new Error('Dropbox returned folder metadata for a file.');
  }
  return meta;
}

// A listing with a missing has_more could look complete when it isn't, and the
// sync pass would treat the missing files as deleted, so it's an error.
function parseListResult(v: unknown): ListResult {
  if (!isRecord(v) || !Array.isArray(v.entries) || typeof v.has_more !== 'boolean') {
    throw new Error('Dropbox returned an incomplete list_folder response.');
  }
  return {
    entries: v.entries.map(parseMetadata),
    cursor: requireString(v, 'cursor'),
    hasMore: v.has_more,
  };
}

// FileHandle.write can write less than the whole buffer, for example when the disk is full.
async function writeAll(file: Awaited<ReturnType<typeof open>>, data: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < data.length) {
    const {bytesWritten} = await file.write(data, offset, data.length - offset);
    if (bytesWritten === 0) {
      throw new Error('Couldn’t write the downloaded file.');
    }
    offset += bytesWritten;
  }
}
