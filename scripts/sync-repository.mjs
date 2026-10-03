#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { REPO_URL } from "../src/repository.js";

/** Check static links by default; only explicit maintenance --write changes files. */
function syncRepository(root, write) {
  const packagePath = join(root, "package.json");
  const original = readFileSync(packagePath, "utf8");
  const manifest = JSON.parse(original);
  const previous = manifest.repository.url.replace(/^git\+/, "").replace(/\.git$/, "");
  const names = new Set([previous, REPO_URL].map((url) => new URL(url).pathname.split("/").at(-1)));
  const escaped = [...names].map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const repoLinks = new RegExp(`https://github\\.com/[A-Za-z0-9_.-]+/(?:${escaped})(?=[/.?#\\s\\x60"'<>)]|$)`, "g");
  const changes = [];
  for (const name of ["README.md", "CONTRIBUTING.md"]) {
    const path = join(root, name);
    const content = readFileSync(path, "utf8");
    const updated = content.replace(repoLinks, REPO_URL);
    if (updated !== content) changes.push({ path, updated, name });
  }
  manifest.repository.url = `git+${REPO_URL}.git`;
  // Preserve unrelated metadata bytes, including the author's spelling and description.
  const updated = original.replace(
    JSON.stringify(JSON.parse(original).repository.url), JSON.stringify(manifest.repository.url),
  );
  if (updated !== original) changes.push({ path: packagePath, updated, name: "package.json" });
  if (write) {
    for (const change of changes) writeFileSync(change.path, change.updated);
  } else if (changes.length > 0) {
    console.error(`Repository links differ from REPO_SLUG in: ${changes.map((change) => change.name).join(", ")}. Run npm run repository:sync explicitly and commit the result.`);
    process.exitCode = 1;
  }
}

syncRepository(dirname(dirname(fileURLToPath(import.meta.url))), process.argv.slice(2).includes("--write"));
