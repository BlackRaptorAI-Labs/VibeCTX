/** Map with at most `limit` calls in flight; results in input order. Shared by `doctor`,
 *  `warm` and the startup autowarm (PAR-656), which all need the same bounded fan-out. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * A counting semaphore (PAR-853): `acquire()` resolves, FIFO, once a slot is free; the
 * returned function releases it (idempotent — calling it twice is a no-op, not a double
 * credit, so a caller's own `finally` cannot over-release under a bug elsewhere).
 *
 * `mapLimit` bounds a FIXED, known-upfront list of items; it cannot bound fan-out ACROSS
 * independent calls that arrive at arbitrary times (N concurrent `get_docs` tool calls, each
 * with its own candidate list) — that needs a shared, standing limiter instead. `fetcher.ts`
 * holds the one process-wide instance every fetch path acquires from, so the ceiling is
 * genuinely shared across `get_docs`, `refresh`, `resolve_library`, `warm_project`, `doctor`
 * and the startup autowarm alike — not a second, uncoordinated cap layered on top of theirs.
 */
export class Semaphore {
  private available: number;
  private readonly queue: (() => void)[] = [];

  constructor(limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error("Semaphore limit must be a positive integer");
    this.available = limit;
  }

  async acquire(): Promise<() => void> {
    if (this.available > 0) {
      this.available -= 1;
      return this.releaser();
    }
    return new Promise((resolve) => {
      this.queue.push(() => resolve(this.releaser()));
    });
  }

  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.queue.shift();
      if (next) next();
      else this.available += 1;
    };
  }
}
