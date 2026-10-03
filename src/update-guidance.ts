import type { DocumentFetchFailure } from "./fetcher.js";

/** Safe, URL-free guidance for a failed primary-document update. */
export function documentUpdateAdvice(failure: DocumentFetchFailure | undefined, retry: string): string {
  switch (failure?.kind) {
    case "not-found":
      return `docs URL returned 404 (the source may have moved or the registry entry may be stale); update the URL in vibectx.config.json or report a stale registry entry, then ${retry}`;
    case "network":
      return `document request failed, possibly due to a network problem; check your connection and ${retry}`;
    case "aborted":
      return `document request was cancelled before the update completed; ${retry}`;
    case "html-response":
      return `docs endpoint returned HTML instead of documentation; check its llms.txt or markdown URL, then ${retry}`;
    default:
      return `no candidate returned usable documentation; check your connection and configured docs URLs, then ${retry}`;
  }
}

const CACHE_ERROR_CODES = new Set(["EACCES", "EPERM", "ENOSPC", "EROFS", "ENOTDIR", "EEXIST"]);

/** Only known filesystem failures are described as cache problems; no raw path is rendered. */
export function cacheUpdateAdvice(error: unknown, retry: string): string | undefined {
  const code = error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
  if (!code || !CACHE_ERROR_CODES.has(code)) return undefined;
  return `local cache write failed (${code}); check the cache directory is writable and has free disk space, then ${retry}`;
}
