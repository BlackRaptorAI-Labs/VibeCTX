import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
it("PAR-1031: decision records exact-pin reuse and the schema-1/schema-2 compatibility boundary", () => {
 const text=readFileSync(new URL("../docs/decisions.md",import.meta.url),"utf8");
 const section=text.match(/## D-100 — PAR-1031: exact-pin documents and persisted resolutions[\s\S]*?(?=\n## |$)/)?.[0] ?? "";
 expect(section).toContain("D-90i"); expect(section).toContain("schema 1"); expect(section).toContain("schema 2"); expect(section).toContain("older releases refuse to save"); expect(section).toContain("unchecked-pin note"); expect(section).toContain("versionedDocuments");
});
