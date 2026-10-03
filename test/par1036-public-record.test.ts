import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

it("PAR-1036: public limitations contain user impact workaround and decision references without internal status prose", () => {
  const document = read("docs/known-limitations.md");
  expect(document).toMatch(/^# Known limitations\n/);
  expect(document).toContain("| ID | User impact | Decision / source | Current behavior | Scope | Workaround |");
  for (const obsolete of ["## Linear re-sweep", "## Phase B evidence log", "## Gate status", "Status is against", "In Review", "independently verified and Done"])
    expect(document).not.toContain(obsolete);
  const limitations = document.split("## Supported scope")[0];
  const rows = limitations.split("\n").filter((line) => /^\| (?:B-\d{2}|D-9[678]|Project config|Concurrent warm|Log rotation|Update check|CLI consent|Partial eviction|Autowarm|Activity append|Temporary-file sweep|Legacy cache integrity) \|/.test(line));
  expect(rows).toHaveLength(51);
  const ids = rows.map((line) => line.split("|")[1].trim());
  expect(new Set(ids).size).toBe(rows.length);
  expect([...ids].sort()).toEqual([...Array.from({ length: 38 }, (_, n) => `B-${String(n + 1).padStart(2, "0")}`), "D-96", "D-97", "D-98", "Project config", "Concurrent warm", "Log rotation", "Update check", "CLI consent", "Partial eviction", "Autowarm", "Activity append", "Temporary-file sweep", "Legacy cache integrity"].sort());
  for (let n = 1; n <= 38; n++) expect(ids).toContain(`B-${String(n).padStart(2, "0")}`);
  for (const line of rows) {
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    expect(cells).toHaveLength(6);
    for (const cell of cells) expect(cell.length, line).toBeGreaterThan(0);
    expect(cells[2], line).toMatch(/D-\d|`src\/|`\w+` in `src\/|README|\.github\/|`clipText`/);
  }
  for (const fact of ["Strict DNS is not persisted", "allowInternalHosts", "Two concurrent warms", "check-then-rename fallback", "hashes are not an attestation", "Connecting makes no request", "project false silently overrides", "vibectx consent reset", "macOS-only until `8898a76`", "failure counts and error codes", "Curated primary URLs may name internal hosts", "redirect hops and followed links still obey the textual host policy"])
    expect(document.toLowerCase()).toContain(fact.toLowerCase());
});

it("PAR-1036: neutral release wording retains the measured historical corpus and decision credits", () => {
  expect(read("RELEASING.md")).toContain("from the maintainer's machine");
  expect(read("RELEASING.md")).not.toMatch(/PAR-827:\s*"/);
  expect(read("README.md")).toContain("[Compatibility choices](docs/known-limitations.md#compatibility-choices)");
  expect(read("README.md")).toContain("Tom's eight");
  expect(read(".github/workflows/ci.yml")).toContain("Tom's decision");
});


it("PAR-1036: append and temporary-sweep residuals remain explicit", () => {
  const document = read("docs/known-limitations.md");
  expect(document).toContain("| Activity append |");
  expect(document).toContain("O_NOFOLLOW");
  expect(document).toContain("empty outside file");
  expect(document).toContain("same-user hard link");
  expect(document).toContain("EISDIR");
  expect(document).toContain("| Temporary-file sweep |");
  expect(document).toContain("temp-shaped user file");
});

it("PAR-1036: legacy cache integrity and current rotation boundaries are disclosed honestly", () => {
  const document = read("docs/known-limitations.md");
  expect(document).toContain("| Legacy cache integrity |");
  expect(document).toContain("304 revalidation leaves the entry hashless");
  expect(document).toContain("the demonstrated same-file interleaving retains the completed peer entry");
  expect(document).not.toContain("a concurrent rotation can lose a peer's completed entry");
  expect(document).toContain("At sequence 999,999,999,999 the writer stops rotating and keeps appending");
  expect(document).not.toContain("sequence numbers near 2^53 can also break chain reads");
  const row = document.split("\n").find((line) => line.startsWith("| B-32 |"));
  expect(row).toBeDefined(); expect(row).toContain("D-30; D-48");
});


it("PAR-1036: every limitations row parses in one uninterrupted six-column table", () => {
  const document = read("docs/known-limitations.md");
  const header = "| ID | User impact | Decision / source | Current behavior | Scope | Workaround |";
  expect(document.split(header)).toHaveLength(2);
  const afterHeader = document.slice(document.indexOf(header));
  expect(afterHeader.split("## Supported scope")).toHaveLength(2);
  // A blank line terminates a Markdown table. Trim only the legitimate whitespace
  // after its last row, retaining every line between the header and the final row.
  const lines = afterHeader.split("## Supported scope")[0].trimEnd().split("\n");
  const rows = lines.map((line, index) => {
    expect(line, `table line ${index + 1} must remain a table row`).toMatch(/^\|.+\|$/);
    const cells = line.slice(1, -1).split("|").map((cell) => cell.trim());
    expect(cells, `table line ${index + 1} must have six cells`).toHaveLength(6);
    expect(cells.every((cell) => cell.length > 0), line).toBe(true);
    return cells;
  });
  expect(rows[0]).toEqual(["ID", "User impact", "Decision / source", "Current behavior", "Scope", "Workaround"]);
  expect(rows[1].every((cell) => /^:?-{3,}:?$/.test(cell))).toBe(true);
  expect(rows.slice(2)).toHaveLength(51);
  expect(rows.at(-1)?.[0]).toBe("Legacy cache integrity");
});

const limitationRow = (id: string): string =>
  read("docs/known-limitations.md").split("\n").find((line) => line.startsWith(`| ${id} |`)) ?? "";

it("PAR-1036 endgame: the rotation row describes the merged marker fix and keeps append semantics", () => {
  const row = limitationRow("B-24");
  expect(row).toContain("D-104");
  expect(row).toContain("single-holder");
  expect(row).toContain("exclusive marker");
  expect(row).toContain("completed peer entry");
  expect(row).toContain("Appends remain lock-free");
  expect(row).not.toContain("a concurrent rotation can lose a peer's completed entry");
});

it("PAR-1036 endgame: the rotation ceiling and fallback residual both match the merged code", () => {
  const row = limitationRow("Log rotation");
  expect(row).toContain("999,999,999,999");
  expect(row).toContain("stops rotating and keeps appending");
  expect(row).toContain("check-then-rename fallback");
  expect(row).not.toContain("sequence numbers near 2^53 can also break chain reads");
});

it("PAR-1036 endgame: deletion failures are reported and partial-deletion bytes are recounted", () => {
  const row = limitationRow("Partial eviction");
  expect(row).toContain("failure counts and error codes");
  expect(row).toContain("recounts real files after a partial deletion");
  expect(row).toContain("peer-deleted queued candidates");
  expect(row).not.toContain("A failed deletion can be silent");
  expect(row).not.toContain("its total can still include bytes already removed");
});

it("PAR-1036 endgame: autowarm scope consent and shared-budget limits are carried", () => {
  const row = limitationRow("Autowarm");
  expect(row).toContain("D-105");
  expect(row).toContain("only the project's matching dependencies");
  expect(row).toContain("only under allowed consent");
  expect(row).toContain("20 of the shared 100");
  expect(row).toContain("no user capacity is reserved");
  expect(row).toContain("per process");
  expect(row).toContain("committed config");
});

it("PAR-1036 endgame: Windows file-identity reliability remains explicitly unverified", () => {
  expect(limitationRow("Activity append")).toContain("Windows file-ID reliability is unverified");
});

it("PAR-1036 endgame: every placeholder reference becomes the actual merged decision", () => {
  const document = read("docs/known-limitations.md");
  expect(document).not.toContain(["D", "NEXT"].join("-"));
  expect(limitationRow("B-20")).toContain("D-101");
  for (const id of ["D-97", "Update check", "CLI consent"]) expect(limitationRow(id)).toContain("D-103");
  for (const id of ["B-24", "Log rotation"]) expect(limitationRow(id)).toContain("D-104");
});
