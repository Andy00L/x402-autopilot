import { MutexTimeoutError } from "./types.js";

/**
 * Queue-based async mutex with timeout.
 * Guarantees sequential payment execution per CLAUDE.md Rule 8.
 */
export class AsyncMutex {
  private locked = false;
  private queue: Array<() => void> = [];

  async acquire(timeoutMs = 30_000): Promise<void> {
    if (!this.locked) {
      this.locked = true;
      return;
    }

    return new Promise<void>((resolve, reject) => {
      const onRelease = (): void => {
        clearTimeout(timer);
        resolve();
      };

      const timer = setTimeout(() => {
        const idx = this.queue.indexOf(onRelease);
        if (idx !== -1) this.queue.splice(idx, 1);
        reject(new MutexTimeoutError());
      }, timeoutMs);

      this.queue.push(onRelease);
    });
  }

  release(): void {
    if (this.queue.length > 0) {
      const next = this.queue.shift()!;
      next();
    } else {
      this.locked = false;
    }
  }
}
