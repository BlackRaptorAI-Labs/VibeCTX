import { describe, it, expect } from "vitest";
import { createSlidingWindowLimiter } from "../src/rate-limit.js";

/**
 * A3 (PAR-716), round 2 (test-auditor, F2) — a DIRECT unit test for the primitive itself, not
 * only the indirect exercise through `test/refresh.test.ts`'s rate-cap tests. Those only prove
 * the `>= maxPerWindow` boundary; the window's defining behaviour — that it SLIDES, that
 * `reset()` actually clears it, and that a refused `take()` leaves state untouched — was
 * previously unreached by any test. Deleting the expiry filter in `rate-limit.ts` left the
 * whole suite green before this file existed.
 */
describe("createSlidingWindowLimiter", () => {
  it("allows up to maxPerWindow calls and refuses the next one", () => {
    const limiter = createSlidingWindowLimiter(3);
    const now = 1_000_000;
    expect(limiter.take(now)).toBe(true);
    expect(limiter.take(now)).toBe(true);
    expect(limiter.take(now)).toBe(true);
    expect(limiter.take(now)).toBe(false); // the 4th, same instant, is refused
  });

  it("a refused take() stays refused on repeated calls at the same instant — no miscount from being asked again", () => {
    // Round 2 (test-auditor, F2a): this alone cannot prove a refused take() records NOTHING —
    // any extra entry it pushed would share this instant's timestamp and expire together with
    // the genuine ones regardless, so no time-based test can distinguish the two from here.
    // The actual "state left untouched" property is what the partial-slide test below proves:
    // if a refusal recorded a start, the freed-slot count after a partial expiry would be wrong.
    const limiter = createSlidingWindowLimiter(2);
    const now = 1_000_000;
    expect(limiter.take(now)).toBe(true);
    expect(limiter.take(now)).toBe(true);
    expect(limiter.take(now)).toBe(false);
    expect(limiter.take(now)).toBe(false); // refused again, not "eventually allowed" from a miscount
    expect(limiter.take(now)).toBe(false);
  });

  it("SLIDES: a call older than windowMs no longer counts against the cap", () => {
    const windowMs = 3600_000;
    const limiter = createSlidingWindowLimiter(1, windowMs);
    const start = 1_000_000;
    expect(limiter.take(start)).toBe(true);
    expect(limiter.take(start + windowMs - 1)).toBe(false); // still inside the window, 1 ms short
    expect(limiter.take(start + windowMs)).toBe(true); // exactly windowMs later: the first call has aged out
  });

  it("the boundary is exact: exactly maxPerWindow calls inside the window are allowed, not maxPerWindow - 1 or + 1", () => {
    const limiter = createSlidingWindowLimiter(5);
    const now = 1_000_000;
    const results = Array.from({ length: 6 }, () => limiter.take(now));
    expect(results).toEqual([true, true, true, true, true, false]);
  });

  it("reset() clears every recorded start, even ones still inside the window", () => {
    const limiter = createSlidingWindowLimiter(1);
    const now = 1_000_000;
    expect(limiter.take(now)).toBe(true);
    expect(limiter.take(now)).toBe(false);
    limiter.reset();
    expect(limiter.take(now)).toBe(true); // the window is empty again, same instant
  });

  it("a partial slide: two calls, only the older one ages out, one slot opens up", () => {
    const windowMs = 3600_000;
    const limiter = createSlidingWindowLimiter(2, windowMs);
    const first = 1_000_000;
    const second = first + 1000;
    expect(limiter.take(first)).toBe(true);
    expect(limiter.take(second)).toBe(true);
    expect(limiter.take(second)).toBe(false); // cap reached, both still inside the window

    // Now past `first`'s expiry but not `second`'s: exactly one slot should have opened.
    const afterFirstExpires = first + windowMs;
    expect(limiter.take(afterFirstExpires)).toBe(true); // the freed slot
    expect(limiter.take(afterFirstExpires)).toBe(false); // and no more — `second` is still live
  });

  it("a custom windowMs is honoured, not the 1-hour default", () => {
    const limiter = createSlidingWindowLimiter(1, 1000); // 1 second
    const start = 1_000_000;
    expect(limiter.take(start)).toBe(true);
    expect(limiter.take(start + 999)).toBe(false);
    expect(limiter.take(start + 1000)).toBe(true);
  });
});
