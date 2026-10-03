import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  classifyFetchError,
  debugEnabled,
  debugEvent,
  debugField,
  FETCH_DIAGNOSTIC_REASONS,
  FETCH_FAILURE_REASONS,
} from "../src/debug.js";
import { fetchUrl, PRIMARY_DOC_MAX_BYTES } from "../src/fetcher.js";
import { stubPublicDns } from "./helpers/public-dns.js";

/**
 * PAR-652 item 7b — `VIBECTX_DEBUG=1`. The point of the feature is that a 404, a timeout
 * and a DNS failure stop looking identical, so the tests below assert exactly that: the
 * three produce three different `reason=` values, while the OUTCOME each caller sees is
 * still the same `miss` it was before.
 */

let dir: string;
let lines: string[];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vibectx-debug-"));
  process.env.VIBECTX_CACHE_DIR = dir;
  lines = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  });
  stubPublicDns();
});
afterEach(() => {
  delete process.env.VIBECTX_CACHE_DIR;
  delete process.env.VIBECTX_DEBUG;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

const URL_UNDER_TEST = "https://example.com/llms.txt";
const fetchOnce = () => fetchUrl(URL_UNDER_TEST, { maxBytes: PRIMARY_DOC_MAX_BYTES });

/** The `reason=` of the single fetch.miss line, or undefined when nothing was logged. */
function loggedReason(): string | undefined {
  const line = lines.find((l) => l.includes("fetch.miss"));
  return line === undefined ? undefined : /reason=([^\s]+)/.exec(line)?.[1];
}

describe("debugEnabled", () => {
  it("is off unless explicitly turned on", () => {
    expect(debugEnabled({})).toBe(false);
    expect(debugEnabled({ VIBECTX_DEBUG: "0" })).toBe(false);
    expect(debugEnabled({ VIBECTX_DEBUG: "false" })).toBe(false);
    expect(debugEnabled({ VIBECTX_DEBUG: "" })).toBe(false);
  });

  it("accepts the obvious spellings of on", () => {
    for (const v of ["1", "true", "TRUE", "yes", "on", " 1 "]) {
      expect(debugEnabled({ VIBECTX_DEBUG: v })).toBe(true);
    }
  });
});

describe("debugField", () => {
  it("strips control and bidi characters — a debug line must not drive a terminal", () => {
    expect(debugField("https://x/[2Ka‮b")).toBe("https://x/[2Kab");
  });

  it("quotes a value containing whitespace, and clips a long one", () => {
    expect(debugField("two words")).toBe('"two words"');
    expect(debugField("x".repeat(400)).length).toBeLessThanOrEqual(302);
  });
});

describe("classifyFetchError", () => {
  it("separates a timeout, a DNS failure and a refused connection", () => {
    const timeout = new Error("The operation was aborted due to timeout");
    timeout.name = "TimeoutError";
    expect(classifyFetchError(timeout).reason).toBe("timeout");

    const dns = new TypeError("fetch failed", { cause: Object.assign(new Error("getaddrinfo ENOTFOUND example.com"), { code: "ENOTFOUND" }) });
    expect(classifyFetchError(dns)).toMatchObject({ reason: "dns", code: "ENOTFOUND" });

    const refused = new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) });
    expect(classifyFetchError(refused).reason).toBe("connection-refused");
  });

  it("falls back to `network` rather than guessing", () => {
    expect(classifyFetchError(new TypeError("fetch failed")).reason).toBe("network");
  });
});

describe("fetchUrl diagnostics: a 404, a timeout and a DNS failure are three different lines", () => {
  it("a 404 logs reason=http-status with the status, and still returns miss", async () => {
    process.env.VIBECTX_DEBUG = "1";
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 404 })));
    // A16/PAR-725: httpStatus is now carried on the outcome too, not just the debug line.
    expect(await fetchOnce()).toEqual({ status: "miss", httpStatus: 404 });
    expect(loggedReason()).toBe("http-status");
    expect(lines.join("")).toContain("status=404");
  });

  it("a timeout logs reason=timeout, and still returns miss", async () => {
    process.env.VIBECTX_DEBUG = "1";
    vi.stubGlobal("fetch", vi.fn(async () => {
      const e = new Error("The operation was aborted due to timeout");
      e.name = "TimeoutError";
      throw e;
    }));
    expect(await fetchOnce()).toEqual({ status: "miss", failureKind: "network" });
    expect(loggedReason()).toBe("timeout");
  });

  it("a DNS failure logs reason=dns with the code, and still returns miss", async () => {
    process.env.VIBECTX_DEBUG = "1";
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("fetch failed", { cause: Object.assign(new Error("getaddrinfo ENOTFOUND example.com"), { code: "ENOTFOUND" }) });
    }));
    expect(await fetchOnce()).toEqual({ status: "miss", failureKind: "network" });
    expect(loggedReason()).toBe("dns");
    expect(lines.join("")).toContain("code=ENOTFOUND");
  });

  it("an HTML 200 and an empty body are distinguishable from both", async () => {
    process.env.VIBECTX_DEBUG = "1";
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<!doctype html><h1>404</h1>", { status: 200, headers: { "content-type": "text/html" } })));
    expect(await fetchOnce()).toEqual({ status: "miss", failureKind: "html-response" });
    expect(loggedReason()).toBe("html-not-text");

    lines = [];
    vi.stubGlobal("fetch", vi.fn(async () => new Response("   ", { status: 200, headers: { "content-type": "text/plain" } })));
    expect(await fetchOnce()).toEqual({ status: "miss" });
    expect(loggedReason()).toBe("empty-body");
  });

  it("PAR-843: an HTML doctype past the OLD 500-char prefix window is still detected, because a real HTML page's own doctype/tag is at the very START of the body, within the new leading-256-char window", async () => {
    process.env.VIBECTX_DEBUG = "1";
    const padding = "x".repeat(600); // would have pushed the marker past the OLD 500-char window
    const body = `<html><head><!-- ${padding} --></head><body><!doctype html><h1>error</h1></body></html>`;
    expect(body.toLowerCase().indexOf("<!doctype html")).toBeGreaterThan(500);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status: 200, headers: { "content-type": "text/html" } })));
    expect(await fetchOnce()).toEqual({ status: "miss", failureKind: "html-response" });
    expect(loggedReason()).toBe("html-not-text");
  });

  it("PAR-843 (code-reviewer round 2, BLOCKING — the required regression test): a real markdown document whose body QUOTES a doctype well past the start (a fenced code example) is served NORMALLY, not refused", async () => {
    // This is the exact failure the whole-body-scan version of the fix would have caused:
    // several shipped defaults' first candidate is a full llms-full.txt dump, and real
    // documentation for a web framework can legitimately show `<!doctype html>` in a code
    // sample. The fix now checks only the body's own LEADING portion, so this is untouched.
    process.env.VIBECTX_DEBUG = "1";
    const body = [
      "# Astro — Basic HTML templating",
      "",
      "Astro components can render arbitrary HTML. A minimal page looks like:",
      "",
      "```html",
      "<!doctype html>",
      "<html lang=\"en\">",
      "  <head><title>Example</title></head>",
      "  <body>Hello</body>",
      "</html>",
      "```",
      "",
      "This is real, legitimate document content — the literal string appears deep in the body,",
      "not at its start.",
    ].join("\n");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status: 200, headers: { "content-type": "text/plain" } })));
    const out = await fetchUrl(URL_UNDER_TEST, { maxBytes: PRIMARY_DOC_MAX_BYTES });
    expect(out).toMatchObject({ status: "ok", body });
    expect(lines.some((l) => l.includes("html-not-text"))).toBe(false);
  });

  it("PAR-843: leading whitespace before the doctype/tag does not defeat the check (trimStart)", async () => {
    process.env.VIBECTX_DEBUG = "1";
    vi.stubGlobal("fetch", vi.fn(async () => new Response("\n\n  <!doctype html><html>padded</html>", { status: 200, headers: { "content-type": "text/plain" } })));
    expect(await fetchOnce()).toEqual({ status: "miss", failureKind: "html-response" });
    expect(loggedReason()).toBe("html-not-text");
  });

  it("PAR-843: an HTML page with no doctype at all, just a leading <html> tag, is still caught", async () => {
    process.env.VIBECTX_DEBUG = "1";
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html><body>no doctype, still html</body></html>", { status: 200, headers: { "content-type": "text/plain" } })));
    expect(await fetchOnce()).toEqual({ status: "miss", failureKind: "html-response" });
    expect(loggedReason()).toBe("html-not-text");
  });

  it("PAR-843: a .md-suffixed URL is no longer exempt — real HTML content at a .md URL is refused, not cached as a document", async () => {
    process.env.VIBECTX_DEBUG = "1";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<!doctype html><html><body>redirected to a login page</body></html>", { status: 200, headers: { "content-type": "text/html" } })),
    );
    const out = await fetchUrl("https://example.com/llms-full.md", { maxBytes: PRIMARY_DOC_MAX_BYTES });
    expect(out).toEqual({ status: "miss", failureKind: "html-response" });
    expect(loggedReason()).toBe("html-not-text");
  });

  it("PAR-843: the check no longer depends on a declared text/html content-type either — a mislabelled HTML body is still caught", async () => {
    process.env.VIBECTX_DEBUG = "1";
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<!doctype html><html>mislabelled</html>", { status: 200, headers: { "content-type": "text/plain" } })));
    expect(await fetchOnce()).toEqual({ status: "miss", failureKind: "html-response" });
    expect(loggedReason()).toBe("html-not-text");
  });

  it("PAR-789: an unsolicited 304 (no If-None-Match sent, since nothing is cached) logs reason=not-modified-uncached, and the outcome is still not-modified", async () => {
    process.env.VIBECTX_DEBUG = "1";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 304 })));
    // fetchOnce() never passes an `etag` — the exact "uncached candidate" shape.
    expect(await fetchOnce()).toEqual({ status: "not-modified", finalUrl: URL_UNDER_TEST });
    expect(loggedReason()).toBe("not-modified-uncached");
  });

  it("PAR-789: a 304 answered to a REAL If-None-Match (a real revalidation) logs nothing — only the unsolicited case is diagnostic-worthy", async () => {
    process.env.VIBECTX_DEBUG = "1";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 304 })));
    expect(await fetchUrl(URL_UNDER_TEST, { maxBytes: PRIMARY_DOC_MAX_BYTES, etag: '"abc123"' })).toEqual({
      status: "not-modified",
      finalUrl: URL_UNDER_TEST,
    });
    expect(lines.some((l) => l.includes("fetch.miss"))).toBe(false);
  });

  it("PAR-789: a 304 response's body is cancelled, matching every other early return in fetchUrl", async () => {
    // The real `Response` constructor refuses a body on a null-body status (304) — this
    // fakes only the shape `fetchUrl` actually reads before its 304 branch (status/url/body),
    // to prove `res.body.cancel()` is called even though a spec-conforming 304 never truly
    // carries one.
    const cancel = vi.fn();
    const fakeRes = { status: 304, url: URL_UNDER_TEST, body: { cancel } } as unknown as Response;
    vi.stubGlobal("fetch", vi.fn(async () => fakeRes));
    await fetchOnce();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("logs nothing at all when VIBECTX_DEBUG is not set, and the outcome is identical", async () => {
    delete process.env.VIBECTX_DEBUG;
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 404 })));
    expect(await fetchOnce()).toEqual({ status: "miss", httpStatus: 404 });
    expect(lines).toEqual([]);
  });

  it("a successful fetch is unchanged and unlogged", async () => {
    process.env.VIBECTX_DEBUG = "1";
    vi.stubGlobal("fetch", vi.fn(async () => new Response("# doc", { status: 200, headers: { "content-type": "text/plain" } })));
    expect(await fetchOnce()).toMatchObject({ status: "ok", body: "# doc" });
    expect(lines).toEqual([]);
  });
});

/**
 * PAR-652c review R4. README promised "every fetch failure" a line, and the two outcomes a
 * user is most likely to need explained — the SSRF guard refusing a redirect, and a document
 * over the byte cap — returned silently. From the outside they are indistinguishable from a
 * 404: the library simply is not cached. These cases pin one line per refusal and per
 * over-size, and pin that the OUTCOME each caller sees is byte-for-byte what it always was.
 */
describe("fetchUrl diagnostics: a refusal and an over-size document each get their own line", () => {
  /** The `reason=` of the single line carrying `event`, or undefined when none was logged. */
  function reasonOf(event: string): string | undefined {
    const line = lines.find((l) => l.includes(event));
    return line === undefined ? undefined : /reason=([^\s]+)/.exec(line)?.[1];
  }
  const redirectTo = (location: string) =>
    vi.fn(async () => new Response(null, { status: 302, headers: { location } }));

  it("a redirect to a non-public host logs fetch.refused reason=redirect-host naming the target", async () => {
    process.env.VIBECTX_DEBUG = "1";
    vi.stubGlobal("fetch", redirectTo("http://127.0.0.1/secret"));
    expect(await fetchOnce()).toEqual({ status: "refused" });
    expect(reasonOf("fetch.refused")).toBe("redirect-host");
    expect(lines.join("")).toContain("to=http://127.0.0.1/secret");
    expect(lines.join("")).toContain("status=302");
  });

  it("a content-derived first URL that is not public https is refused before any request", async () => {
    process.env.VIBECTX_DEBUG = "1";
    const spy = vi.fn(async () => new Response("never", { status: 200 }));
    vi.stubGlobal("fetch", spy);
    expect(await fetchUrl("http://169.254.169.254/latest", { maxBytes: PRIMARY_DOC_MAX_BYTES, publicFinalUrl: true })).toEqual({
      status: "refused",
    });
    expect(reasonOf("fetch.refused")).toBe("not-public");
    expect(spy).not.toHaveBeenCalled(); // the diagnostic did not cost a request
  });

  it("a followed link leaving its source origin logs fetch.refused reason=link-policy", async () => {
    process.env.VIBECTX_DEBUG = "1";
    vi.stubGlobal("fetch", vi.fn(async () => new Response("stolen", { status: 200 })));
    expect(
      await fetchUrl("https://elsewhere.example/page.md", {
        maxBytes: PRIMARY_DOC_MAX_BYTES,
        linkGuard: { sourceUrl: "https://example.com/llms.txt" },
      }),
    ).toEqual({ status: "refused" });
    expect(reasonOf("fetch.refused")).toBe("link-policy");
  });

  /** PAR-851 — the resolved-address check's own diagnostic line, naming the resolved address
   *  in `detail=` (not merely a bare refusal with no clue why). */
  it("a hostname that resolves privately logs fetch.refused reason=resolved-address, naming the address", async () => {
    process.env.VIBECTX_DEBUG = "1";
    const spy = vi.fn(async () => new Response("SECRET", { status: 200 }));
    vi.stubGlobal("fetch", spy);
    const lookup = async () => [{ address: "127.0.0.1", family: 4 }];
    expect(await fetchUrl("https://attacker.example.com/docs", { maxBytes: PRIMARY_DOC_MAX_BYTES, lookup })).toEqual({ status: "refused" });
    expect(reasonOf("fetch.refused")).toBe("resolved-address");
    expect(lines.join("")).toContain("127.0.0.1");
    expect(spy).not.toHaveBeenCalled();
  });

  /** PAR-853 — the whole-operation deadline's own diagnostic line, distinct from the ordinary
   *  per-hop `timeout` reason: this fires BETWEEN candidates, before a request even starts. */
  it("the whole-operation deadline logs fetch.miss reason=operation-deadline", async () => {
    process.env.VIBECTX_DEBUG = "1";
    const controller = new AbortController();
    controller.abort();
    expect(await fetchUrl(URL_UNDER_TEST, { maxBytes: PRIMARY_DOC_MAX_BYTES, operationSignal: controller.signal })).toEqual({ status: "miss" });
    expect(reasonOf("fetch.miss")).toBe("operation-deadline");
  });

  it("a declared Content-Length over the cap logs fetch.too-large with the size and the limit", async () => {
    process.env.VIBECTX_DEBUG = "1";
    vi.stubGlobal("fetch", vi.fn(async () => new Response("x", { status: 200, headers: { "content-length": "99999999" } })));
    expect(await fetchUrl(URL_UNDER_TEST, { maxBytes: 1000 })).toEqual({ status: "too-large" });
    expect(reasonOf("fetch.too-large")).toBe("content-length");
    expect(lines.join("")).toContain("bytes=99999999");
    expect(lines.join("")).toContain("limit=1000");
  });

  it("an undeclared body that overruns the cap mid-stream logs reason=body-cap and no size", async () => {
    process.env.VIBECTX_DEBUG = "1";
    vi.stubGlobal("fetch", vi.fn(async () => new Response("y".repeat(5000), { status: 200, headers: { "content-type": "text/plain" } })));
    expect(await fetchUrl(URL_UNDER_TEST, { maxBytes: 100 })).toEqual({ status: "too-large" });
    expect(reasonOf("fetch.too-large")).toBe("body-cap");
    expect(lines.join("")).toContain("limit=100");
    expect(lines.join("")).not.toContain("bytes="); // the true size is unknown; it is not guessed
  });

  it("a redirect with no Location, and one past the hop limit, are two different misses", async () => {
    process.env.VIBECTX_DEBUG = "1";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 302 })));
    expect(await fetchOnce()).toEqual({ status: "miss" });
    expect(loggedReason()).toBe("redirect-no-location");

    lines = [];
    let hops = 0;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 302, headers: { location: `https://example.com/${hops++}` } })));
    expect(await fetchOnce()).toEqual({ status: "miss" });
    expect(loggedReason()).toBe("redirect-hops");
  });

  it("the diagnostics are additive: with VIBECTX_DEBUG unset every outcome is identical and silent", async () => {
    delete process.env.VIBECTX_DEBUG;
    vi.stubGlobal("fetch", redirectTo("http://127.0.0.1/secret"));
    expect(await fetchOnce()).toEqual({ status: "refused" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("x", { status: 200, headers: { "content-length": "99999999" } })));
    expect(await fetchUrl(URL_UNDER_TEST, { maxBytes: 1000 })).toEqual({ status: "too-large" });
    expect(lines).toEqual([]);
  });
});

/**
 * PAR-652c schema K2. The README enumerated nine `reason` values while the type union
 * exported ten — `aborted` was in the code and in no document. Prose and a type do not stay
 * in step by good intentions, so this is the mechanism: one exported list, and a test that
 * reads the README and refuses a drift in either direction.
 */
describe("the documented reason vocabulary is the shipped one", () => {
  const README = readFileSync(fileURLToPath(new URL("../README.md", import.meta.url)), "utf8");
  const start = README.indexOf("**When a library will not cache");
  const section = README.slice(start, README.indexOf("`VIBECTX_NO_AUTOWARM=1`", start));

  it("the README's VIBECTX_DEBUG section names every event and every reason the code can emit", () => {
    expect(section.length).toBeGreaterThan(500); // the slice found the section, not an empty string
    const missing: string[] = [];
    for (const [event, reasons] of Object.entries(FETCH_DIAGNOSTIC_REASONS)) {
      if (!section.includes(`\`${event}\``)) missing.push(event);
      for (const reason of reasons) if (!section.includes(`\`${reason}\``)) missing.push(`${event}/${reason}`);
    }
    expect(missing).toEqual([]);
  });

  it("the README documents no reason the code cannot emit", () => {
    const shipped = new Set(Object.values(FETCH_DIAGNOSTIC_REASONS).flat());
    // Every inline-code token in the section that LOOKS like a reason (lower-case, hyphenated
    // or a bare word) must be one, an event name, or one of the section's own known terms.
    const allowed = new Set([
      ...shipped,
      ...Object.keys(FETCH_DIAGNOSTIC_REASONS),
      "to=",
      "bytes=",
      "limit=",
      "--json",
      "reason", // the field's own name, as prose
      "ms",
    ]);
    const undocumentable = [...section.matchAll(/`([a-z][a-z0-9-]*)`/g)]
      .map((m) => m[1])
      .filter((token) => !allowed.has(token));
    expect(undocumentable).toEqual([]);
  });

  it("every FetchFailureReason is a fetch.miss reason — the union and the map cannot drift", () => {
    for (const reason of FETCH_FAILURE_REASONS) {
      expect(FETCH_DIAGNOSTIC_REASONS["fetch.miss"]).toContain(reason);
    }
  });

  /** PAR-853 — `aborted` is genuinely reachable now: an MCP client's own cancellation
   *  (`server.ts`'s `extra.signal`, threaded into `getLibraryDoc`) is a plain `AbortController`
   *  abort with no custom reason, which produces exactly this generic `AbortError` shape — see
   *  `test/server.test.ts`'s own end-to-end cancellation test for the live case. Unit-tested
   *  here at `classifyFetchError`'s own level regardless of which caller currently exercises
   *  it, matching this function's own doc comment. */
  it("`aborted` is classified — reachable via caller cancellation (PAR-853), not merely a future-proofing branch", () => {
    const e = new Error("This operation was aborted");
    e.name = "AbortError";
    expect(classifyFetchError(e)).toEqual({ reason: "aborted", message: "This operation was aborted" });
  });
});

describe("debugEvent", () => {
  it("renders one line of key=value pairs and drops undefined fields", () => {
    const out: string[] = [];
    debugEvent("fetch.miss", { url: "https://x/y", code: undefined, ms: 12 }, { env: { VIBECTX_DEBUG: "1" }, write: (l) => out.push(l) });
    expect(out).toEqual(["vibectx [debug] fetch.miss url=https://x/y ms=12\n"]);
  });
});

/**
 * PAR-652b — the additive claim, enforced instead of asserted.
 *
 * `debug.ts` and `fetcher.ts:107` both say a diagnostic can never change a return value.
 * The security gate measured that it could: with `VIBECTX_DEBUG=1` and a `process.stderr.write`
 * that throws (a closed or full stderr — a piped MCP client that went away), the `debugEvent`
 * in `fetchUrl`'s catch block threw out of the catch block, so a DNS failure came back as an
 * exception instead of `{ status: "miss" }`.
 *
 * The fix is in `debugEvent` itself rather than at that one call site: it is the only place
 * that makes EVERY caller safe, present and future, and "diagnostics that can alter behaviour
 * are not diagnostics" is a property of the diagnostic, not of who calls it.
 */
describe("a diagnostic can never change what a caller sees", () => {
  it("debugEvent swallows a stderr that throws", () => {
    expect(() =>
      debugEvent(
        "fetch.miss",
        { url: "https://x/y" },
        {
          env: { VIBECTX_DEBUG: "1" },
          write: () => {
            throw new Error("EPIPE: broken pipe");
          },
        },
      ),
    ).not.toThrow();
  });

  it("debugEvent swallows a field that throws while being rendered", () => {
    const hostile = { toString() { throw new Error("nope"); } } as unknown as string;
    const out: string[] = [];
    expect(() =>
      debugEvent("fetch.miss", { url: hostile }, { env: { VIBECTX_DEBUG: "1" }, write: (l) => out.push(l) }),
    ).not.toThrow();
  });

  it("a DNS failure still returns miss when writing the diagnostic throws", async () => {
    process.env.VIBECTX_DEBUG = "1";
    (process.stderr.write as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("EPIPE: broken pipe");
    });
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("fetch failed", { cause: Object.assign(new Error("getaddrinfo ENOTFOUND example.com"), { code: "ENOTFOUND" }) });
    }));
    await expect(fetchOnce()).resolves.toEqual({ status: "miss", failureKind: "network" });
  });

  it("a 404 still returns miss when writing the diagnostic throws", async () => {
    process.env.VIBECTX_DEBUG = "1";
    (process.stderr.write as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("EPIPE: broken pipe");
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 404 })));
    await expect(fetchOnce()).resolves.toEqual({ status: "miss", httpStatus: 404 });
  });
});
