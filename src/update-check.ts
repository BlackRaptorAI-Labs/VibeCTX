import { REPO_API_URL, REPO_URL } from "./repository.js";
/** C5: an explicitly enabled, one-shot read of the public GitHub Releases endpoint. */
export const RELEASES_URL = `${REPO_API_URL}/releases/latest`;
const RELEASE_PAGE = `${REPO_URL}/releases/tag/`;
const MAX_RELEASE_BYTES = 65_536;

type Request = (url: string, init: RequestInit) => Promise<Response>;

function parts(version: string): number[] | undefined {
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
  if (match === null) return undefined;
  const numbers = match.slice(1).map(Number);
  return numbers.every(Number.isSafeInteger) ? numbers : undefined;
}

function isNewer(tag: string, current: string): boolean {
  const next = parts(tag);
  const now = parts(current);
  if (next === undefined || now === undefined) return false;
  for (let i = 0; i < 3; i++) {
    if (next[i]! > now[i]!) return true;
    if (next[i]! < now[i]!) return false;
  }
  return false;
}

async function boundedBody(response: Response): Promise<string | undefined> {
  if (response.body === null) return undefined;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RELEASE_BYTES) return undefined;
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
}

export async function checkForUpdate(opts: {
  enabled: boolean;
  currentVersion: string;
  notify: (line: string) => void;
  request?: Request;
}): Promise<void> {
  if (!opts.enabled) return;
  try {
    const response = await (opts.request ?? fetch)(RELEASES_URL, {
      headers: { accept: "application/vnd.github+json" },
      redirect: "error",
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) return;
    const body = await boundedBody(response);
    if (body === undefined) return;
    const parsed: unknown = JSON.parse(body);
    const tag = (parsed as { tag_name?: unknown } | null)?.tag_name;
    if (typeof tag !== "string" || tag.length > 32 || !/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag)) return;
    if (!isNewer(tag, opts.currentVersion)) return;
    opts.notify(`update available: v${opts.currentVersion} → ${tag} — ${RELEASE_PAGE}${tag}\n`);
  } catch { /* version checks never interfere with docs or expose error text */ }
}
