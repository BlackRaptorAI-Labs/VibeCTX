/**
 * Autowarm's live process state — the module that owns it AND its mutators (A8 / PAR-721,
 * Move 5; probed and recorded as D-68). Mutating an imported `const` Set across a module
 * boundary is legal; reassigning an imported `let` is not (TS2632 at compile time, or
 * TS2540 / a runtime TypeError on the `import * as ns` workaround). So `started` can only
 * be flipped from inside this module, through `markAutowarmStarted`, never by an importer
 * assigning to a binding — and `inFlight` is handed out only as a `ReadonlySet` (a
 * type-level guard: `autowarmStatus()` returns the live Set itself, so a caller must not be
 * handed a mutable reference to begin with).
 */

const inFlight = new Set<string>();
let started = false;

/** Live state for list_libraries (`warming…`) and tests. */
export function autowarmStatus(): { started: boolean; inFlight: ReadonlySet<string> } {
  return { started, inFlight };
}

/** Test hook — also autowarm.ts's own reset, re-exported there so its importers are unaffected. */
export function resetAutowarm(): void {
  inFlight.clear();
  started = false;
}

/** Called once, when a startAutowarm run begins. */
export function markAutowarmStarted(): void {
  started = true;
}

export function addInFlight(name: string): void {
  inFlight.add(name);
}

export function deleteInFlight(name: string): void {
  inFlight.delete(name);
}

export function clearInFlight(): void {
  inFlight.clear();
}
