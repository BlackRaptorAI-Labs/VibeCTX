/**
 * A3 (PAR-716) — the per-process sliding-window shape shared by every rate limit in this
 * codebase. `resolve.ts`'s `MAX_RESOLUTIONS_PER_HOUR` window (L2, PAR-655) is the first of
 * these; `refresh.ts`'s full-refresh cap is the second, extracted here rather than copied so
 * a third has a mechanism to adopt instead of a second hand-rolled window. The queued
 * "reserved interactive share of the 100/h resolution budget" item is exactly that third case
 * (see the plan revision's reconciliation table) — it should build on this, not on its own
 * array-and-filter.
 *
 * One hour, one process: the window is in-memory, so it resets on restart and is never shared
 * between processes. That is the same limit `resolve.ts`'s window already carries — a cap
 * against a single runaway process (a model stuck retrying), not a durable quota.
 */
export interface SlidingWindowLimiter {
  /** True when another action may start now; records the start if so. Leaves state untouched
   *  when the window is full. */
  take(nowMs: number): boolean;
  /** Test hook: forget every recorded start. */
  reset(): void;
}

export function createSlidingWindowLimiter(maxPerWindow: number, windowMs = 3600_000): SlidingWindowLimiter {
  let starts: number[] = [];
  return {
    take(nowMs: number): boolean {
      starts = starts.filter((t) => nowMs - t < windowMs);
      if (starts.length >= maxPerWindow) return false;
      starts.push(nowMs);
      return true;
    },
    reset(): void {
      starts = [];
    },
  };
}
