import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
const record = () => readFileSync(new URL("../docs/decisions.md", import.meta.url), "utf8");
it.each([
  ["PAR-1032 candidate and index disclosure", "## D-101 — registry candidates and index-only disclosure, PAR-1032, checked 2026-10-01", "The disclosure is reserved within the same response budget"],
  ["PAR-1040 consent amendment", "## D-103 — decided 2026-09-24 by Tom, PAR-1040 (amends D-97)", "Tool calls follow D-97 (a) and (b) unchanged."],
  ["PAR-1039 linked-trail amendment", "## D-104 — decided 2026-09-24 by Tom, PAR-1039 (amends B-24)", "reports that as \"entries added after rotation\", not tampering."],
  ["PAR-1031 persisted-schema compatibility", "## D-100 — PAR-1031: exact-pin documents and persisted resolutions", "This release reads valid schema 1 records without rewriting"],
])("stacked decision entries retain %s", (_name, heading, fact) => {
  const text = record(); expect(text.split(heading)).toHaveLength(2);
  const entry = text.slice(text.indexOf(heading)).split(/\n## /u)[0]; expect(entry).toContain(fact);
});
