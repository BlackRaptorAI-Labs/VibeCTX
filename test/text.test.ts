import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { cleanText, clipText, stripControlBidi } from "../src/text.js";

/**
 * Relocated regex allow-list tripwire (A8 / PAR-721, Move 3). cleanText's control/bidi
 * character class used to live in project-deps.ts, guarded there by a text-scan tripwire
 * (a ReDoS allow-list guard: the project shipped a 0.1.3 hotfix for a ReDoS link regex,
 * and this is the guard against a repeat). The move relocates the pattern to this file,
 * so the guard moves with it -- never trimmed, never left behind on an unguarded module.
 */
describe("text.ts regex allow-list tripwire", () => {
  it("the module's regex literals are exactly the allow-listed control/bidi class", () => {
    const src = readFileSync(new URL("../src/text.ts", import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "") // block comments
      .replace(/\/\/.*$/gm, ""); // line comments
    const literals = [...src.matchAll(/(?:^|[=(,:\s])\/((?:\\.|\[(?:\\.|[^\]\n])*\]|[^/\n\\[])+)\/[gimsuy]*/g)].map((m) => m[1]);
    expect(new Set(literals)).toEqual(
      new Set([
        "[\\u0000-\\u001f\\u007f-\\u009f\\u061c\\u200b-\\u200f\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069\\ufeff\\u{e0000}-\\u{e007f}]", // the one control/bidi class, /gu -- D-48's single shared contract, extended by PAR-870 for U+061C and Unicode Tags
      ]),
    );
  });
});

describe("Phase B — one shared ISO instant validator", () => {
  it("declares ISO_INSTANT and validIsoInstant only in cache-meta and imports the validator at every other persisted-store use", () => {
    const srcDir = new URL("../src/", import.meta.url);
    const owner = readFileSync(new URL("cache-meta.ts", srcDir), "utf8");
    expect(owner).toMatch(/export const ISO_INSTANT\s*=/);
    expect(owner).toMatch(/export function validIsoInstant\b/);

    // L-33: the stores import the whole check (shape, then a real date), not just the regex.
    for (const name of ["activity-log.ts", "project-store.ts", "search-index.ts", "doctor-store.ts"]) {
      const source = readFileSync(new URL(name, srcDir), "utf8");
      expect(source).toMatch(/import\s*\{[^}]*\bvalidIsoInstant\b[^}]*\}\s*from\s*["']\.\/cache-meta\.js["']/);
      expect(source).not.toMatch(/(?:const|let|var)\s+ISO_INSTANT\s*=/);
      expect(source).not.toMatch(/function\s+validIsoInstant\b/);
    }
  });
});

/**
 * PAR-785 — the allow-list tripwire above only checks that src/text.ts ITSELF carries exactly
 * one approved control/bidi character-class regex; nothing stops a DIFFERENT src/*.ts file from
 * reintroducing a second, local copy of that same character class — exactly what src/debug.ts
 * and src/resolved-store.ts used to do before A7/A8 (PAR-720/PAR-721) unified them into this one
 * file. This is the repo-wide half of that guard: no OTHER src file may define a character class
 * whose ranges overlap the code points text.ts owns, whatever escape syntax it uses to spell them.
 *
 * Follows the established scan-tripwire shape already used by test/cache.test.ts's "source
 * tripwire" (`.meta.url` property access) and test/version.test.ts's "no source file hard-codes
 * a version string" test: scan every src/*.ts file's TEXT (comments stripped, so a stale comment
 * quoting an old pattern cannot fail this), collect `offenders`, assert the array is empty.
 */
describe("PAR-785 — repo-wide tripwire: only text.ts may own a control/bidi character class", () => {
  /** One `[lo, hi]` code point range (inclusive on both ends; `lo === hi` for a single point). */
  type Range = [number, number];

  /** Decode ONE class member starting at `body[i]`: a `\uXXXX`, `\u{X...}`, or `\xXX` escape, an escaped
   *  literal (`\]`, `\-`, `\\`, `\^`), or a bare character — returning its code point and the
   *  index just past what it consumed. Deliberately narrow (no `\d`/`\s`/`\w` shorthand
   *  handling): this codebase's own character classes never mix a Unicode-escape range with a
   *  shorthand class in the same brackets (verified by inspection, this test's own reason for
   *  existing), so a shorthand class member is not a shape this scan needs to decode — only to
   *  not crash on, which treating its backslash-letter pair as "some non-owned code point" via
   *  the bare-escaped-literal fallback below already does safely (`\d` decodes as `d`, in no
   *  owned range, exactly as `\d` decodes as a NON-control-character escape should for purposes
   *  of THIS scan). */
  function decodeClassMember(body: string, i: number): { code: number; next: number } {
    if (body[i] === "\\") {
      if (body[i + 1] === "u" && body[i + 2] === "{") {
        const close = body.indexOf("}", i + 3);
        return { code: parseInt(body.slice(i + 3, close), 16), next: close + 1 };
      }
      if (body[i + 1] === "u") return { code: parseInt(body.slice(i + 2, i + 6), 16), next: i + 6 };
      if (body[i + 1] === "x") return { code: parseInt(body.slice(i + 2, i + 4), 16), next: i + 4 };
      return { code: body.charCodeAt(i + 1), next: i + 2 }; // \], \-, \\, \^, or a shorthand letter
    }
    return { code: body.charCodeAt(i), next: i + 1 };
  }

  /** Parse a bracketed character-class BODY (the text strictly between `[`/`[^` and `]`) into
   *  the `[lo, hi]` ranges it names — handling both single members (`lo === hi`) and `a-b`
   *  ranges, in whatever mix of `\uXXXX`, `\xXX` and literal-character spelling the source uses. */
  function parseClassRanges(body: string): Range[] {
    const ranges: Range[] = [];
    let i = 0;
    while (i < body.length) {
      const a = decodeClassMember(body, i);
      if (body[a.next] === "-" && a.next + 1 < body.length) {
        const b = decodeClassMember(body, a.next + 1);
        ranges.push([a.code, b.code]);
        i = b.next;
      } else {
        ranges.push([a.code, a.code]);
        i = a.next;
      }
    }
    return ranges;
  }

  /** Every genuine `/regex/` literal in `source` (comments already stripped), as the extraction
   *  the allow-list tripwire above already uses and trusts — reused rather than re-derived, so
   *  this scan and that one can never quietly disagree about what counts as a regex literal. */
  function regexLiterals(source: string): string[] {
    return [...source.matchAll(/(?:^|[=(,:\s])\/((?:\\.|\[(?:\\.|[^\]\n])*\]|[^/\n\\[])+)\/[gimsuy]*/g)].map((m) => m[1]);
  }

  function stripComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  }

  const overlaps = (a: Range, b: Range): boolean => a[0] <= b[1] && b[0] <= a[1];

  it("no src/*.ts file other than text.ts contains a character class overlapping the C0/C1/zero-width/bidi/BOM ranges text.ts owns", () => {
    const srcDir = new URL("../src/", import.meta.url);
    // The ranges text.ts owns, DERIVED from its own source (not re-typed here as a second copy
    // of the class) — the allow-list tripwire above already proves text.ts carries exactly one
    // such literal, so taking literals[0] here is safe by construction, not an assumption.
    const textTsSource = stripComments(readFileSync(new URL("text.ts", srcDir), "utf8"));
    const textTsLiterals = regexLiterals(textTsSource);
    expect(textTsLiterals).toHaveLength(1);
    const ownedRanges = parseClassRanges(textTsLiterals[0].slice(1, -1)); // strip the outer [ ]
    expect(ownedRanges.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const name of readdirSync(srcDir).filter((f) => f.endsWith(".ts") && f !== "text.ts")) {
      let source = stripComments(readFileSync(new URL(name, srcDir), "utf8"));
      // PAR-785 — named exclusion: src/project-store.ts's own NUL-rejection check
      // (`value.includes("\u0000")`) is a single-code-point STRING EQUALITY check (rejecting a
      // value that literally contains a NUL), never a strip/allow-list character CLASS — not
      // the shape this scan exists to catch. It is also not a `/regex/` literal at all, so the
      // literal-extraction below already never sees it; this line removes it anyway, explicitly
      // and by name, so this test's own exclusion is a stated fact about what it does NOT check,
      // not merely an accident of how the extraction happens to behave.
      source = source.replace(/value\.includes\("\\u0000"\)/g, "");
      for (const literal of regexLiterals(source)) {
        for (const cls of literal.matchAll(/\[\^?((?:\\.|[^\]\n])*)\]/g)) {
          const classRanges = parseClassRanges(cls[1]);
          if (classRanges.some((r) => ownedRanges.some((o) => overlaps(r, o)))) {
            offenders.push(`${name}: ${cls[0]}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("cleanText (A8 / PAR-721, Move 3 -- moved from project-deps.ts; behaviour unchanged)", () => {
  const chars = (...codes: number[]): string => codes.map((c) => String.fromCharCode(c)).join("");

  it("strips the C0 control range (U+0000-U+001F)", () => {
    expect(cleanText("a" + chars(0x00, 0x1f) + "b")).toBe("ab");
  });
  it("strips the C1 / DEL range (U+007F-U+009F)", () => {
    expect(cleanText("a" + chars(0x7f, 0x9f) + "b")).toBe("ab");
  });
  it("strips zero-width and bidi-mark code points (U+200B-U+200F)", () => {
    expect(cleanText("a" + chars(0x200b, 0x200f) + "b")).toBe("ab");
  });
  it("strips bidi embedding/override controls (U+202A-U+202E)", () => {
    expect(cleanText("a" + chars(0x202a, 0x202e) + "b")).toBe("ab");
  });
  it("strips bidi isolate controls (U+2066-U+2069)", () => {
    expect(cleanText("a" + chars(0x2066, 0x2069) + "b")).toBe("ab");
  });
  it("strips a BOM / zero-width no-break space (U+FEFF)", () => {
    expect(cleanText(chars(0xfeff) + "hello")).toBe("hello");
  });
  it("PAR-870: strips astral Unicode Tags and the Arabic Letter Mark", () => {
    const invisible = String.fromCodePoint(0x061c, 0xe0000, 0xe0020, 0xe007e, 0xe007f);
    expect(cleanText(`safe${invisible}text`)).toBe("safetext");
  });
  it("strips the line/paragraph separators (U+2028/U+2029) -- A7/PAR-720: previously caught only by debug.ts's own copy", () => {
    expect(cleanText("a" + chars(0x2028, 0x2029) + "b")).toBe("ab");
  });
  it("leaves ordinary text, including punctuation, untouched", () => {
    expect(cleanText("hello, world! 123 -- OK?")).toBe("hello, world! 123 -- OK?");
  });
  it("empty string", () => {
    expect(cleanText("")).toBe("");
  });
});

describe("clipText -- first direct tests (A8 / PAR-721): zero existed before this move", () => {
  it("returns short text unchanged, no ellipsis", () => {
    expect(clipText("hello", 10)).toBe("hello");
  });
  it("boundary: clean length === max -- no clip, no ellipsis", () => {
    expect(clipText("hello", 5)).toBe("hello");
  });
  it("boundary: clean length === max + 1 -- clips exactly one character for the ellipsis", () => {
    expect(clipText("hello!", 5)).toBe("hell\u2026");
    expect(clipText("hello!", 5)).toHaveLength(5);
  });
  it("PAR-871: an even max that cuts through an astral character drops the whole pair", () => {
    expect(clipText("ab😀c", 4)).toBe("ab…");
  });
  it("cleans control/bidi characters BEFORE measuring length against max", () => {
    // dirty.length is 5, clean.length is 2. max=3 is chosen to DISCRIMINATE the two orderings:
    // clean-then-measure (correct) sees length 2 <= 3 and returns "ab" unclipped; a
    // measure-then-clean bug would see the DIRTY length 5 > 3, slice(0, max-1=2) of the dirty
    // string to "a\x00" (2 chars: "a" then one NUL) then clean IT, giving "a" + the ellipsis --
    // a different, wrong, and shorter result. A max of 5 (both lengths equal) cannot tell the
    // two apart.
    const dirty = "a" + String.fromCharCode(0x00, 0x00, 0x00) + "b";
    expect(clipText(dirty, 3)).toBe("ab");
  });
  it("max of 1: the whole budget is spent on the ellipsis", () => {
    expect(clipText("hello", 1)).toBe("\u2026");
  });
  it("max smaller than the ellipsis needs (0): slice(0, -1) still drops only the last character", () => {
    // max - 1 === -1, and String.prototype.slice(0, -1) means \"all but the last character\",
    // not \"nothing\" -- so clipText(s, 0) is NOT just the ellipsis for a 5-character s.
    expect(clipText("hello", 0)).toBe("hell\u2026");
  });
  it("empty string input, any max", () => {
    expect(clipText("", 10)).toBe("");
    expect(clipText("", 0)).toBe("");
  });
});

describe("stripControlBidi -- the one exported binding onto the D-48 class (A7 / PAR-720)", () => {
  const chars = (...codes: number[]): string => codes.map((c) => String.fromCharCode(c)).join("");

  it("defaults to delete, identically to cleanText", () => {
    const dirty = "a" + chars(0x00, 0x9b, 0x200b, 0xfeff) + "b";
    expect(stripControlBidi(dirty)).toBe(cleanText(dirty));
    expect(stripControlBidi(dirty)).toBe("ab");
  });
  it("substitutes the given replacement for every matched character, not just the first", () => {
    expect(stripControlBidi("a" + chars(0x00, 0x9b) + "b", " ")).toBe("a  b");
  });
  it("U+009B (control sequence introducer) is matched -- the character this issue exists for", () => {
    expect(stripControlBidi("fast" + chars(0x9b) + "web", " ")).toBe("fast web");
  });
  it("leaves ordinary text untouched with any replacement", () => {
    expect(stripControlBidi("hello, world!", "X")).toBe("hello, world!");
  });
});
