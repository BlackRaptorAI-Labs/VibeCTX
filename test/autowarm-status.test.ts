import { describe, it, expect, beforeEach } from "vitest";
import { autowarmStatus, resetAutowarm, markAutowarmStarted, addInFlight, deleteInFlight, clearInFlight } from "../src/autowarm-status.js";
import { autowarmStatus as autowarmStatusViaAutowarm, resetAutowarm as resetAutowarmViaAutowarm } from "../src/autowarm.js";

/**
 * A8 / PAR-721, Move 5: the state autowarm.ts used to own directly (`inFlight`, `started`)
 * moved here, because TypeScript forbids reassigning an imported `let` across a module
 * boundary (D-68: `tsc` TS2632 on a bare `import { started }`, TS2540 / a runtime TypeError
 * on the `import * as ns` workaround) while mutating an imported `const Set` is legal. So the
 * module that owns the state now owns its mutators too, and hands out only accessors —
 * `autowarmStatus()` returns the live Set typed `ReadonlySet` (a type-level guard: the
 * returned object IS the live state, never a copy), never a bare mutable binding.
 *
 * autowarm.ts re-exports `autowarmStatus` / `resetAutowarm` (the one shim this move is
 * allowed) so its own existing importers (test/autowarm.test.ts, test/server.test.ts) see no
 * change. index.ts continues to import `autowarmStatus` through that re-export too — its
 * `index.ts:48` check (`autowarmStatus().inFlight.size > 0`) is the real consumer this state
 * exists for: an unref'd timer that only fires when something else (a live in-flight fetch)
 * holds the event loop open, so a spawn-and-close client doesn't leak an orphaned process.
 * That only works if BOTH import paths observe the exact same live state, never two copies —
 * which the tests below prove directly, by reference identity, not by inference.
 */

beforeEach(() => {
  resetAutowarm();
});

describe("autowarm-status.ts: one instance, seen through both import paths", () => {
  it("autowarm.js's re-exported autowarmStatus IS autowarm-status.js's autowarmStatus (same function)", () => {
    expect(autowarmStatusViaAutowarm).toBe(autowarmStatus);
  });

  it("autowarm.js's re-exported resetAutowarm IS autowarm-status.js's resetAutowarm (same function)", () => {
    expect(resetAutowarmViaAutowarm).toBe(resetAutowarm);
  });

  it("autowarmStatus() does not defensively copy inFlight on each call -- the same live Set comes back every time", () => {
    // Weaker than the file's title suggests on its own (the two functions being identical, above,
    // already implies this): it isolates one further property -- that the accessor hands out the
    // live Set itself, not a fresh snapshot -- which matters because a copy would silently break
    // "a mutation is visible immediately" below.
    const viaDirect = autowarmStatus().inFlight;
    const viaAutowarm = autowarmStatusViaAutowarm().inFlight;
    expect(viaDirect).toBe(viaAutowarm);
  });

  it("a mutation made through the module's own mutator is visible immediately through both accessors", () => {
    addInFlight("react");
    expect(autowarmStatus().inFlight.has("react")).toBe(true);
    expect(autowarmStatusViaAutowarm().inFlight.has("react")).toBe(true);

    deleteInFlight("react");
    expect(autowarmStatus().inFlight.has("react")).toBe(false);
    expect(autowarmStatusViaAutowarm().inFlight.has("react")).toBe(false);
  });

  it("the state SUPPORTS index.ts:48's condition (inFlight.size > 0), through either import path -- not a test of index.ts itself, which is not exercised here", () => {
    addInFlight("vue");
    expect(autowarmStatus().inFlight.size > 0).toBe(true);
    expect(autowarmStatusViaAutowarm().inFlight.size > 0).toBe(true);
    deleteInFlight("vue");
    expect(autowarmStatus().inFlight.size > 0).toBe(false);
    expect(autowarmStatusViaAutowarm().inFlight.size > 0).toBe(false);
  });
});

describe("autowarm-status.ts: accessors and mutators, direct", () => {
  it("starts unstarted, with an empty inFlight set", () => {
    const s = autowarmStatus();
    expect(s.started).toBe(false);
    expect(s.inFlight.size).toBe(0);
  });

  it("markAutowarmStarted flips started to true and leaves inFlight untouched", () => {
    addInFlight("svelte");
    markAutowarmStarted();
    const s = autowarmStatus();
    expect(s.started).toBe(true);
    expect(s.inFlight.has("svelte")).toBe(true);
  });

  it("addInFlight / deleteInFlight / clearInFlight mutate the live set", () => {
    addInFlight("a");
    addInFlight("b");
    expect([...autowarmStatus().inFlight].sort()).toEqual(["a", "b"]);
    deleteInFlight("a");
    expect([...autowarmStatus().inFlight]).toEqual(["b"]);
    clearInFlight();
    expect(autowarmStatus().inFlight.size).toBe(0);
  });

  it("resetAutowarm clears inFlight AND resets started", () => {
    addInFlight("x");
    markAutowarmStarted();
    resetAutowarm();
    const s = autowarmStatus();
    expect(s.started).toBe(false);
    expect(s.inFlight.size).toBe(0);
  });
});
