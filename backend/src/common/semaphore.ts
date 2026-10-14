/**
 * Minimal counting semaphore. `acquire()` resolves immediately if a permit is
 * free, else waits until one is released; `release()` hands the permit directly
 * to the next waiter (FIFO) or returns it to the pool.
 *
 * Shared by the transaction sync's worker pool, the chart inputs' background
 * transaction walks (`chart-inputs.service.ts`) and the read budget's long
 * deep-walk slots (`read-budget.ts`, which waits with `acquireWithin`).
 */
export class Semaphore {
  private available: number;
  private readonly waiters: Array<() => void> = [];

  constructor(permits: number) {
    this.available = Math.max(1, Math.floor(permits));
  }

  async acquire(): Promise<void> {
    if (this.available > 0) {
      this.available -= 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  /**
   * `acquire`, giving up after `ms`: true when a permit was taken. A waiter
   * that times out leaves the FIFO, so a later `release` never hands a permit
   * to nobody.
   */
  async acquireWithin(ms: number): Promise<boolean> {
    if (this.available > 0) {
      this.available -= 1;
      return true;
    }
    if (ms <= 0) return false;
    return new Promise<boolean>((resolve) => {
      const waiter = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        const at = this.waiters.indexOf(waiter);
        if (at >= 0) {
          this.waiters.splice(at, 1);
          resolve(false);
        }
      }, ms);
      this.waiters.push(waiter);
    });
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) {
      next();
      return;
    }
    this.available += 1;
  }

  /** Runs `fn` holding one permit, released however `fn` ends. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}
