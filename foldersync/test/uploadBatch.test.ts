// The Dropbox client's batched upload commits, retries, and shared pacer,
// against a fake fetch.
import {mkdtemp, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {describe, expect, it} from 'vitest';

import {hashBuffer} from '../src/engine/contentHash';
import {ApiError, DropboxClient, Pacer, type UploadRequest} from '../src/engine/dropboxApi';

const tokens = {getToken: async () => 'tok', renewToken: async () => 'tok'};

function fileMeta(path: string, content: string, extra: Record<string, unknown> = {}): unknown {
  return {
    id: `id:${path}`,
    path_lower: path.toLowerCase(),
    path_display: path,
    rev: 'r1',
    content_hash: hashBuffer(Buffer.from(content)),
    size: content.length,
    client_modified: '2026-10-27T00:00:00Z',
    server_modified: '2026-10-27T00:00:00Z',
    ...extra,
  };
}

// A fake Dropbox for upload sessions. Each session remembers its file's
// content; finish_batch_v2 answers each entry with result(), success by default.
function fakeDropbox(
  result: (path: string, content: string, batch: number) => unknown = (path, content) => ({
    '.tag': 'success',
    ...Object(fileMeta(path, content)),
  })
): {fetchImpl: typeof fetch; batches: string[][]; routes: string[]} {
  const sessions = new Map<string, string>();
  const batches: string[][] = [];
  const routes: string[] = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    const route = new URL(String(url)).pathname.replace('/2/', '');
    routes.push(route);
    if (route === 'files/upload_session/start') {
      const id = `s${sessions.size + 1}`;
      sessions.set(id, Buffer.from(init?.body instanceof Uint8Array ? init.body : []).toString());
      return Response.json({session_id: id});
    }
    if (route === 'files/upload_session/finish_batch_v2') {
      const {entries} = JSON.parse(String(init?.body)) as {
        entries: {cursor: {session_id: string}; commit: {path: string}}[];
      };
      batches.push(entries.map((e) => e.commit.path));
      const n = batches.length;
      return Response.json({
        entries: entries.map((e) =>
          result(e.commit.path, sessions.get(e.cursor.session_id) ?? '', n)
        ),
      });
    }
    throw new Error(`unexpected ${route}`);
  };
  return {fetchImpl, batches, routes};
}

async function request(name: string, content: string): Promise<UploadRequest> {
  const dir = await mkdtemp(join(tmpdir(), 'foldersync-batch-'));
  const localPath = join(dir, name);
  await writeFile(localPath, content);
  return {
    localPath,
    dropboxPath: `/p/${name}`,
    mode: {kind: 'add'},
    clientModified: new Date(),
    contentHash: hashBuffer(Buffer.from(content)),
    checkUnchanged: async () => {},
  };
}

describe('batched upload commits', () => {
  it('commits uploads that finish together in one batch', async () => {
    const fake = fakeDropbox();
    // No fallback timer, so only waiting for every upload groups them.
    const api = new DropboxClient({
      tokens,
      fetchImpl: fake.fetchImpl,
      pacer: new Pacer(),
      batchIdleMs: 60_000,
    });

    const requests = await Promise.all(['a.txt', 'b.txt', 'c.txt'].map((n) => request(n, n)));

    const metas = await Promise.all(requests.map((r) => api.upload(r)));

    expect(metas.map((m) => m.pathDisplay)).toEqual(['/p/a.txt', '/p/b.txt', '/p/c.txt']);
    // One batch, in the order the uploads finished sending.
    expect(fake.batches).toHaveLength(1);
    expect([...(fake.batches[0] ?? [])].sort()).toEqual(['/p/a.txt', '/p/b.txt', '/p/c.txt']);
  });

  it('doesn’t hold waiting commits for an upload that’s still sending', async () => {
    const fake = fakeDropbox();
    let releaseSlow = (): void => {};
    const slow = new Promise<void>((r) => (releaseSlow = r));
    const fetchImpl: typeof fetch = async (url, init) => {
      const body = init?.body instanceof Uint8Array ? Buffer.from(init.body).toString() : '';
      if (String(url).endsWith('/upload_session/start') && body === 'slow') {
        await slow;
      }
      return fake.fetchImpl(url, init);
    };
    const api = new DropboxClient({tokens, fetchImpl, pacer: new Pacer(), batchIdleMs: 10});
    const [fast, big] = await Promise.all([request('a.txt', 'A'), request('big.bin', 'slow')]);

    const slowUpload = api.upload(big);
    const meta = await api.upload(fast);
    releaseSlow();
    await slowUpload;

    expect(meta.pathDisplay).toBe('/p/a.txt');
    expect(fake.batches).toEqual([['/p/a.txt'], ['/p/big.bin']]);
  });

  it('fails only the upload whose entry failed', async () => {
    const fake = fakeDropbox((path, content) =>
      path === '/p/b.txt'
        ? {
            '.tag': 'failure',
            failure: {'.tag': 'path', path: {'.tag': 'conflict', conflict: {'.tag': 'file'}}},
          }
        : {'.tag': 'success', ...Object(fileMeta(path, content))}
    );
    const api = new DropboxClient({tokens, fetchImpl: fake.fetchImpl, pacer: new Pacer()});

    const requests = await Promise.all(['a.txt', 'b.txt'].map((n) => request(n, n)));

    const results = await Promise.allSettled(requests.map((r) => api.upload(r)));

    expect(results[0]?.status).toBe('fulfilled');
    const failed = results[1];
    expect(failed?.status === 'rejected' && failed.reason).toBeInstanceOf(ApiError);
    expect(failed?.status === 'rejected' && String(failed.reason)).toMatch(
      /path\/conflict\/file\//
    );
  });

  it('returns the conflicted-copy name Dropbox saved the file under', async () => {
    const fake = fakeDropbox((path, content) => ({
      '.tag': 'success',
      ...Object(fileMeta(path.replace('a.txt', "a (user's conflicted copy).txt"), content)),
    }));
    const api = new DropboxClient({tokens, fetchImpl: fake.fetchImpl, pacer: new Pacer()});

    const meta = await api.upload(await request('a.txt', 'mine'));

    expect(meta.pathDisplay).toBe("/p/a (user's conflicted copy).txt");
  });

  it('commits an entry Dropbox asked to slow down in the next batch, and slows every client', async () => {
    const fake = fakeDropbox((path, content, batch) =>
      batch === 1
        ? {'.tag': 'failure', failure: {'.tag': 'too_many_write_operations'}}
        : {'.tag': 'success', ...Object(fileMeta(path, content))}
    );
    const pacer = new Pacer();
    const waits: number[] = [];
    const api = new DropboxClient({
      tokens,
      fetchImpl: fake.fetchImpl,
      pacer,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });

    const meta = await api.upload(await request('a.txt', 'A'));

    expect(meta.pathDisplay).toBe('/p/a.txt');
    expect(fake.batches).toEqual([['/p/a.txt'], ['/p/a.txt']]);
    expect(pacer.throttles).toBe(1);
    expect(waits.length).toBeGreaterThan(0);
  });

  it('keeps an upload whose commit got no answer when Dropbox has its content', async () => {
    const fake = fakeDropbox();
    const fetchImpl: typeof fetch = async (url, init) => {
      const route = new URL(String(url)).pathname.replace('/2/', '');
      if (route === 'files/upload_session/finish_batch_v2') {
        throw new TypeError('fetch failed');
      }
      if (route === 'files/get_metadata') {
        return Response.json({'.tag': 'file', ...Object(fileMeta('/p/a.txt', 'A'))});
      }
      return fake.fetchImpl(url, init);
    };
    const api = new DropboxClient({tokens, fetchImpl, pacer: new Pacer()});

    const meta = await api.upload(await request('a.txt', 'A'));

    expect(meta.pathDisplay).toBe('/p/a.txt');
  });

  it('rejects an upload that Dropbox saved with other content', async () => {
    const fake = fakeDropbox((path) => ({'.tag': 'success', ...Object(fileMeta(path, 'other'))}));
    const api = new DropboxClient({tokens, fetchImpl: fake.fetchImpl, pacer: new Pacer()});

    await expect(api.upload(await request('a.txt', 'A'))).rejects.toThrow(
      /doesn’t match its content hash/
    );
  });
});

describe('retries and the shared pacer', () => {
  it('retries a call after a network error', async () => {
    let calls = 0;
    const api = new DropboxClient({
      tokens,
      pacer: new Pacer(),
      sleep: async () => {},
      fetchImpl: async () => {
        calls++;
        if (calls === 1) {
          throw new TypeError('fetch failed');
        }
        return Response.json({entries: [], cursor: 'c1', has_more: false});
      },
    });

    await api.listFolder('/p', true);

    expect(calls).toBe(2);
  });

  it('makes every client wait after Dropbox asks one to slow down', async () => {
    let now = 0;
    const pacer = new Pacer(() => now);
    const waits: number[] = [];
    const sleep = async (ms: number): Promise<void> => {
      waits.push(ms);
      now += ms;
    };
    let throttled = false;
    const listing = async (): Promise<Response> =>
      Response.json({entries: [], cursor: 'c1', has_more: false});
    const first = new DropboxClient({
      tokens,
      pacer,
      sleep,
      fetchImpl: async () => {
        if (!throttled) {
          throttled = true;
          return new Response('{"error_summary": "too_many_requests/"}', {
            status: 429,
            headers: {'Retry-After': '2'},
          });
        }
        return listing();
      },
    });
    const second = new DropboxClient({tokens, pacer, sleep, fetchImpl: listing});

    await first.listFolder('/p', true);
    now -= 1000;
    await second.listFolder('/q', true);

    // The first waited out Retry-After; the second waited for what was left.
    expect(waits).toEqual([2000, 1000]);
    expect(pacer.throttles).toBe(1);
  });

  it('keeps waiting when another request extends the wait', async () => {
    let now = 0;
    const pacer = new Pacer(() => now);
    pacer.throttled(1000);
    const waits: number[] = [];

    await pacer.wait(async (ms) => {
      waits.push(ms);
      now += ms;
      if (waits.length === 1) {
        // Another request was asked to wait longer meanwhile.
        pacer.throttled(5000);
      }
    });

    expect(waits).toEqual([1000, 5000]);
  });
});
