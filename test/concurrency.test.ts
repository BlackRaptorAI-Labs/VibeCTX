import { describe, it, expect } from "vitest";
import { mapLimit, Semaphore } from "../src/concurrency.js";

/**
 * mapLimit's first direct tests (A8 / PAR-721, Move 1): it had none before this move — only
 * indirect coverage through doctor / warm / autowarm. Moved verbatim out of doctor.ts, so its
 * behaviour is unchanged; these tests pin that behaviour at its new address.
 */
describe("mapLimit", () => {
  it("returns results in input order, even when completions arrive out of order", async () => {
    const delays: Record<number, number> = { 0: 30, 1: 10, 2: 20 };
    const out = await mapLimit([0, 1, 2], 3, async (i) => {
      await new Promise((resolve) => setTimeout(resolve, delays[i]));
      return `item-${i}`;
    });
    expect(out).toEqual(["item-0", "item-1", "item-2"]);
  });

  it("never runs more than `limit` calls concurrently", async () => {
    let inFlight = 0;
    let maxObserved = 0;
    const items = Array.from({ length: 10 }, (_, i) => i);
    await mapLimit(items, 3, async (i) => {
      inFlight += 1;
      maxObserved = Math.max(maxObserved, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return i;
    });
    // Exact, not just a ceiling: every worker's synchronous prefix (up to its first await) runs
    // before any timer fires, so a mapLimit that silently serialised (a regressed `Math.min`)
    // would show maxObserved < 3 here, not merely "within bounds" -- a one-sided
    // `toBeLessThanOrEqual` cannot tell "ran 3 at once" from "ran fewer".
    expect(maxObserved).toBe(3);
  });

  it("empty input returns an empty array and calls fn zero times", async () => {
    let calls = 0;
    const out = await mapLimit([], 4, async (i: number) => {
      calls += 1;
      return i;
    });
    expect(out).toEqual([]);
    expect(calls).toBe(0);
  });

  it("limit greater than items.length runs every item, no more concurrently than items.length", async () => {
    let inFlight = 0;
    let maxObserved = 0;
    const out = await mapLimit([1, 2, 3], 100, async (i) => {
      inFlight += 1;
      maxObserved = Math.max(maxObserved, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return i * 2;
    });
    expect(out).toEqual([2, 4, 6]);
    // Exact: with only 3 items, observed concurrency is capped at 3 regardless of the worker
    // count Math.min(limit, items.length) spawns -- the `i >= items.length` guard inside each
    // worker's loop is what actually stops any extra worker from ever calling fn. Asserting
    // `toBe(3)` rather than "at or under" pins the real invariant either mechanism must produce.
    expect(maxObserved).toBe(3);
  });

  it("limit of 1 runs items strictly one at a time, in order", async () => {
    const order: number[] = [];
    let inFlight = 0;
    let maxObserved = 0;
    const out = await mapLimit([1, 2, 3], 1, async (i) => {
      inFlight += 1;
      maxObserved = Math.max(maxObserved, inFlight);
      order.push(i);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return i;
    });
    expect(order).toEqual([1, 2, 3]);
    expect(out).toEqual([1, 2, 3]);
    // "in order" alone doesn't prove serial execution -- a fully-parallel implementation with
    // fn's synchronous prefix run in order would ALSO yield [1,2,3] here. maxObserved pins the
    // actual property the test's name claims.
    expect(maxObserved).toBe(1);
  });

  it("a rejecting fn rejects the whole mapLimit call", async () => {
    await expect(
      mapLimit([1, 2, 3], 2, async (i) => {
        if (i === 2) throw new Error("boom");
        return i;
      }),
    ).rejects.toThrow("boom");
  });
});

/** PAR-853 — Semaphore's own tests: the shared-across-independent-callers property mapLimit
 *  cannot provide (its own tests above all bound ONE fixed, known-upfront list). */
describe("Semaphore", () => {
  it("never lets more than `limit` acquires be held at once, across calls that arrive at arbitrary times", async () => {
    const sem = new Semaphore(3);
    let inFlight = 0;
    let maxObserved = 0;
    const worker = async () => {
      const release = await sem.acquire();
      inFlight += 1;
      maxObserved = Math.max(maxObserved, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      release();
    };
    // 10 independent callers, not one fixed list handed to a single mapLimit call.
    await Promise.all(Array.from({ length: 10 }, () => worker()));
    expect(maxObserved).toBe(3);
  });

  it("a released slot is handed to the next queued acquirer, FIFO", async () => {
    const sem = new Semaphore(1);
    const order: number[] = [];
    const release1 = await sem.acquire();
    const p2 = sem.acquire().then((release) => {
      order.push(2);
      release();
    });
    const p3 = sem.acquire().then((release) => {
      order.push(3);
      release();
    });
    // Neither queued acquire can have resolved yet: the single slot is still held.
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(order).toEqual([]);
    release1();
    await Promise.all([p2, p3]);
    expect(order).toEqual([2, 3]);
  });

  it("releasing twice is a no-op, not a double credit to the pool", async () => {
    const sem = new Semaphore(1);
    const release = await sem.acquire();
    release();
    release(); // must not free a second slot that was never held
    let concurrentlyHeld = 0;
    let maxObserved = 0;
    await Promise.all(
      Array.from({ length: 3 }, () =>
        (async () => {
          const r = await sem.acquire();
          concurrentlyHeld += 1;
          maxObserved = Math.max(maxObserved, concurrentlyHeld);
          await new Promise((resolve) => setTimeout(resolve, 5));
          concurrentlyHeld -= 1;
          r();
        })(),
      ),
    );
    expect(maxObserved).toBe(1);
  });

  it("rejects a non-positive or non-integer limit", () => {
    expect(() => new Semaphore(0)).toThrow();
    expect(() => new Semaphore(-1)).toThrow();
    expect(() => new Semaphore(1.5)).toThrow();
  });
});
