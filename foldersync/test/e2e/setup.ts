// Runs once before the live tests: stops at once if there's no token server to
// test against, and starts this run's log in out/e2e.
import {mkdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

export default async function setup(): Promise<void> {
  const server = process.env.FOLDERSYNC_E2E_TOKEN_SERVER;
  if (!server) {
    throw new Error(
      'Set FOLDERSYNC_E2E_TOKEN_SERVER to a running token server, like http://127.0.0.1:8787. ' +
        'See "Live tests" in README.md.'
    );
  }
  try {
    const res = await fetch(`${server}/health`, {signal: AbortSignal.timeout(5000)});
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
  } catch (err) {
    throw new Error(`The token server at ${server} didn't answer /health: ${String(err)}`, {
      cause: err,
    });
  }
  const dir = join(process.cwd(), 'out', 'e2e');
  mkdirSync(dir, {recursive: true});
  const log = join(dir, `run-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
  writeFileSync(log, `Live tests against ${server}\n`);
  process.env.FOLDERSYNC_E2E_LOG = log;
}
