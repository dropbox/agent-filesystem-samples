// Limits how many tasks run at once. The sync passes of every project share
// one pool for transfers and one for deletes.

export class Pool {
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(private readonly limit: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  private release(): void {
    this.active--;
    this.wake();
  }

  private wake(): void {
    while (this.active < this.limit) {
      const next = this.waiting.shift();
      if (!next) {
        return;
      }
      this.active++;
      next();
    }
  }
}
