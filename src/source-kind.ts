import { looksLikeIndex } from "./retrieval.js";

/**
 * How a primary document is classified (shared by doctor, list_libraries and the resolver):
 * - `index-only`   — structure: `looksLikeIndex` (link-dense) regardless of URL.
 *                    Answers depend on following links.
 * - `readme`       — not an index, and the resolved URL is README-style: host is
 *                    raw.githubusercontent.com, or the last path segment is
 *                    README(.ext); OR the URL carries no llms.txt provenance (last
 *                    path segment is not `llms.txt` / `llms-<suffix>.txt`). Curated
 *                    fallback pages land here.
 * - `full-text`    — not an index, at an `llms.txt` / `llms-*.txt` URL: prose served whole.
 * - `unreachable`  — nothing could be fetched and nothing is cached.
 */
export type SourceKind = "full-text" | "index-only" | "readme" | "unreachable";

const README_BASENAME = /^readme(\.[a-z0-9]+)?$/i;
const LLMS_TXT_BASENAME = /^llms(-[a-z0-9]+)?\.txt$/i;

function lastPathSegment(url: string): string | undefined {
  try {
    const path = new URL(url).pathname;
    return decodeURIComponent(path.slice(path.lastIndexOf("/") + 1));
  } catch {
    return undefined;
  }
}

export function kindFromStructure(url: string, isIndex: boolean): SourceKind {
  if (isIndex) return "index-only";
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return "readme"; // unparseable: no llms.txt provenance can be established
  }
  const base = lastPathSegment(url) ?? "";
  if (host === "raw.githubusercontent.com" || README_BASENAME.test(base)) return "readme";
  return LLMS_TXT_BASENAME.test(base) ? "full-text" : "readme";
}

/** Classify a fetched (or cached) primary document — see SourceKind for the rule. */
export function classifySourceKind(url: string, content: string): SourceKind {
  return kindFromStructure(url, looksLikeIndex(content));
}
