import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

/** Redact local filesystem locations before they are included in a warning. */
export function redactPathsForWarning(message: string, cacheFolder: string, homeFolder = homedir()): string {
  return redactFolders(message, [cacheFolder], homeFolder);
}

function redactFolders(message: string, cacheFolders: string[], homeFolder: string): string {
  const replacements = [
    ...cacheFolders.map((path) => ({ path, label: "[cache]" })),
    { path: homeFolder, label: "~" },
  ]
    .filter(({ path }) => isAbsolute(path) && path !== "/")
    .sort((a, b) => b.path.length - a.path.length);

  return message.split(/(https?:\/\/[^\s"'<>]+)/gi).map((part, index) =>
    index % 2 === 1 ? part : replacements.reduce((text, { path, label }) => replaceFolder(text, path, label), part),
  ).join("");
}

/** Match a whole path component, so a sibling with the same prefix keeps its name. */
function replaceFolder(text: string, path: string, label: string): string {
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const folder = new RegExp(`(^|[\\s"'(<>=:,;])${escaped}(?=$|/|[\\s"'<>),;])`, "g");
  return text.replace(folder, (_match, before: string) => before + label);
}

/** The cache folder as configured and as pinned to its real spelling (a symlinked ancestor such
 *  as macOS `/var` is resolved when the root is pinned), so either spelling in a message is
 *  redacted. An empty `VIBECTX_CACHE_DIR` means the default, as in `cacheRoot()`. */
function cacheFolders(env: NodeJS.ProcessEnv, home: string): string[] {
  const configured = env.VIBECTX_CACHE_DIR;
  const folder = configured !== undefined && configured.length > 0 ? configured : join(home, ".vibectx");
  const folders = new Set([folder]);
  try { folders.add(realpathSync(folder)); } catch { /* not created yet */ }
  return [...folders];
}

/** Decision 10: the copy-paste repair command keeps the real cache path on the user's terminal. */
const VERBATIM_LINE = /^chmod 700 '/;
/** Remembered warnings are bounded; past the bound a warning is still written, just not remembered. */
const MAX_REMEMBERED_WARNINGS = 1024;
const writtenWarnings = new Set<string>();

/**
 * PAR-1044 L-5: the stderr sink for best-effort warnings. The cache folder is shown as `[cache]`
 * and the home folder as `~` (MCP hosts may keep stderr), and an identical warning is written
 * once per process. A `chmod 700 '…'` repair line is kept verbatim (decision 10). Like the
 * `process.stderr.write` defaults it replaces, a throwing stream is left to the caller.
 */
export function writeStderrWarning(message: string, env: NodeJS.ProcessEnv = process.env): void {
  const home = homedir();
  const folders = cacheFolders(env, home);
  const text = message.replace(/\n+$/, "").split("\n")
    .map((line) => VERBATIM_LINE.test(line) ? line : redactFolders(line, folders, home))
    .join("\n");
  if (writtenWarnings.has(text)) return;
  if (writtenWarnings.size < MAX_REMEMBERED_WARNINGS) writtenWarnings.add(text);
  process.stderr.write(`${text}\n`);
}

/** Test seam: forget which warnings this process has written. */
export function resetStderrWarnings(): void {
  writtenWarnings.clear();
}
