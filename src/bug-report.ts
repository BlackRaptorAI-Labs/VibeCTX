import { ISSUE_NEW_URL } from "./repository.js";
/** C6: deliberately allowlisted facts only. Never serialize an Error, tool response, URL, or path. */
export type BugOperation = "get_docs" | "refresh" | "resolve_library" | "warm_project" | "doctor" | "search" | "list_libraries" | "startup";
export type BugWhere = "network" | "cache" | "configuration" | "retrieval" | "startup";
export type BugErrorClass = "NetworkError" | "CacheError" | "ConfigError" | "ParseError" | "TypeError" | "RangeError" | "UnknownError";
export type TechKind = "app" | "service" | "language" | "hosting";

export interface BugFacts {
  operation: BugOperation;
  where: BugWhere;
  errorClass: BugErrorClass;
  version: string;
  platform: string;
  nodeVersion: string;
  /** Included only when the user supplies these names for this report. */
  techStack?: readonly { kind: TechKind; name: string }[];
}

const OPERATIONS: readonly string[] = ["get_docs", "refresh", "resolve_library", "warm_project", "doctor", "search", "list_libraries", "startup"];
const PLACES: readonly string[] = ["network", "cache", "configuration", "retrieval", "startup"];
const CLASSES: readonly string[] = ["NetworkError", "CacheError", "ConfigError", "ParseError", "TypeError", "RangeError", "UnknownError"];
const TECH_KINDS: readonly string[] = ["app", "service", "language", "hosting"];
// A finite public-name vocabulary is intentional: an arbitrary alphanumeric string may be
// an access token even when it has no URL, path, assignment, or recognizable secret prefix.
export const TECH_NAMES: Record<TechKind, readonly string[]> = {
  app: ["Claude", "ChatGPT", "Codex", "Cursor", "VS Code", "Windsurf"],
  service: ["AWS", "Azure", "Cloudflare", "GitHub", "Google Cloud", "npm", "PyPI"],
  language: ["Go", "Java", "JavaScript", "Python", "Rust", "TypeScript"],
  hosting: ["AWS", "Azure", "Cloudflare", "Fly.io", "Google Cloud", "Netlify", "Vercel"],
};
const PLATFORMS: readonly string[] = ["darwin", "linux", "win32", "freebsd", "openbsd", "sunos", "aix"];
const MAX_ISSUE_URL = 2_000;

export function isPublicTechName(kind: TechKind, name: string): boolean {
  return canonicalTechName(kind, name) !== undefined;
}

export function canonicalTechName(kind: TechKind, name: string): string | undefined {
  return TECH_NAMES[kind]?.find((known) => known.toLowerCase() === name.toLowerCase());
}

function listed(value: unknown, options: readonly string[], fallback: string): string {
  return typeof value === "string" && options.includes(value) ? value : fallback;
}

function safeVersion(value: unknown, node: boolean): string {
  if (typeof value !== "string") return "unknown";
  const shape = node ? /^v\d{1,3}\.\d{1,3}\.\d{1,3}$/ : /^\d{1,3}\.\d{1,3}\.\d{1,3}$/;
  return shape.test(value) ? value : "unknown";
}

function techLines(values: BugFacts["techStack"]): string[] {
  if (!Array.isArray(values)) return [];
  const lines: string[] = [];
  for (const entry of values.slice(0, 100)) {
    if (!entry || !TECH_KINDS.includes(entry.kind)) continue;
    // No URL, path, shell assignment, or control character can pass this name shape.
    if (typeof entry.name !== "string" || !isPublicTechName(entry.kind as TechKind, entry.name)) continue;
    lines.push(`- ${entry.kind}: ${canonicalTechName(entry.kind, entry.name)}`);
  }
  return lines;
}

export function buildBugPreview(facts: BugFacts): string {
  const stack = techLines(facts.techStack);
  return [
    "VibeCTX bug report (review before opening GitHub)",
    `VibeCTX version: ${safeVersion(facts.version, false)}`,
    `OS/platform: ${listed(facts.platform, PLATFORMS, "other")}`,
    `Node version: ${safeVersion(facts.nodeVersion, true)}`,
    `Operation: ${listed(facts.operation, OPERATIONS, "startup")}`,
    `Where: ${listed(facts.where, PLACES, "startup")}`,
    `Error class: ${listed(facts.errorClass, CLASSES, "UnknownError")}`,
    "Tech stack (only names you chose to include):",
    ...(stack.length > 0 ? stack : ["- not provided"]),
  ].join("\n");
}

/** `raw` is intentionally ignored: error messages can contain secrets and personal paths. */
export function bugFailureOffer(facts: BugFacts, raw?: unknown): string {
  void raw;
  const operation = listed(facts.operation, OPERATIONS, "startup");
  const where = listed(facts.where, PLACES, "startup");
  const errorClass = listed(facts.errorClass, CLASSES, "UnknownError");
  return `${operation} failed in ${where} (${errorClass}; VibeCTX ${safeVersion(facts.version, false)}). To review a safe report, run vibectx report-bug --operation ${operation} --where ${where} --error-class ${errorClass}, then choose whether to open a pre-filled GitHub issue. Nothing is submitted automatically.`;
}

export type BugLinkResult = { kind: "declined" } | { kind: "url" | "copy"; value: string };

/** The caller must show `buildBugPreview(facts)` before asking for confirmation. */
export function issueLinkAfterConfirmation(facts: BugFacts, confirmed: boolean): BugLinkResult {
  if (!confirmed) return { kind: "declined" };
  const preview = buildBugPreview(facts);
  const url = new URL(ISSUE_NEW_URL);
  url.searchParams.set("template", "bug_report.md");
  url.searchParams.set("title", `VibeCTX ${listed(facts.operation, OPERATIONS, "startup")} failure`);
  url.searchParams.set("body", preview);
  return url.href.length <= MAX_ISSUE_URL ? { kind: "url", value: url.href } : { kind: "copy", value: preview };
}
