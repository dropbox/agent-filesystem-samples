import {describe, expect, it} from 'vitest';

import {Pool} from '../src/engine/pool';

// A task that waits until the test releases it, and records how many run at once.
function gated(counter: {now: number; max: number}): {
  task: () => Promise<void>;
  release: () => void;
} {
  let release = (): void => {};
  const released = new Promise<void>((r) => (release = r));
  return {
    release,
    task: async () => {
      counter.now++;
      counter.max = Math.max(counter.max, counter.now);
      await released;
      counter.now--;
    },
  };
}

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

describe('pool', () => {
  it('runs at most its limit at once, and runs every task', async () => {
    const pool = new Pool(3);
    const counter = {now: 0, max: 0};
    const tasks = Array.from({length: 10}, () => gated(counter));

    const all = Promise.all(tasks.map((t) => pool.run(t.task)));
    for (const t of tasks) {
      await tick();
      t.release();
    }
    await all;

    expect(counter.max).toBe(3);
    expect(counter.now).toBe(0);
  });

  it('frees a slot when a task fails', async () => {
    const pool = new Pool(1);

    await expect(pool.run(async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');

    await expect(pool.run(async () => 'ok')).resolves.toBe('ok');
  });

  it('shares one limit between callers, as projects share it', async () => {
    const pool = new Pool(2);
    const counter = {now: 0, max: 0};
    const first = Array.from({length: 3}, () => gated(counter));
    const second = Array.from({length: 3}, () => gated(counter));

    const all = Promise.all([
      Promise.all(first.map((t) => pool.run(t.task))),
      Promise.all(second.map((t) => pool.run(t.task))),
    ]);
    for (const t of [...first, ...second]) {
      await tick();
      t.release();
    }
    await all;

    expect(counter.max).toBe(2);
  });
});
