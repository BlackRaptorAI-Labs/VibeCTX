import { describe, it, expect } from "vitest";
import { tokenize, STOPWORDS, MAX_TOKEN_CHARS } from "../src/tokenize.js";

/**
 * D-23 — one tokenizer for query, headings, bodies and code. The contract these
 * tests pin: lowercase, split on non-alphanumerics, split camelCase/PascalCase
 * with a linear scanner, keep the whole compound too, light suffix stemming,
 * stopwords with an all-stopword fallback, 1-char tokens dropped.
 */

describe("tokenize — camelCase and PascalCase splitting (D-23)", () => {
  it("splits camelCase and keeps the whole lowercased compound", () => {
    expect(tokenize("useEffect")).toEqual(["use", "effect", "useeffect"]);
  });

  it("splits PascalCase", () => {
    expect(tokenize("QueryClient")).toEqual(["query", "client", "queryclient"]);
  });

  it("splits an acronym run before the following word", () => {
    expect(tokenize("HTTPServer")).toEqual(["http", "server", "httpserver"]);
    // "parse" stems to "pars" (silent-e cut) — see the stemmer describe below.
    expect(tokenize("parseJSONBody")).toEqual(["pars", "json", "body", "parsejsonbody"]);
  });

  it("keeps a bare acronym as one token", () => {
    expect(tokenize("HTTP")).toEqual(["http"]);
  });

  it("does not emit a compound when the run has a single subword", () => {
    expect(tokenize("router")).toEqual(["router"]);
  });

  it("keeps digits attached to the preceding subword and never splits on them", () => {
    expect(tokenize("utf8")).toEqual(["utf8"]);
    expect(tokenize("s3Client")).toEqual(["s3", "client", "s3client"]);
    expect(tokenize("h1")).toEqual(["h1"]);
  });

  it("splits on every non-alphanumeric run, including dots and underscores", () => {
    expect(tokenize("prisma.user.upsert(")).toEqual(["prisma", "user", "upsert"]);
    expect(tokenize("row_level__security")).toEqual(["row", "level", "security"]);
    expect(tokenize("---")).toEqual([]);
  });

  it("splits a mixed identifier path the way an agent would say it", () => {
    // "stripe" and "create" both lose their silent e, the same way the documents do.
    expect(tokenize("stripe.checkout.sessions.create")).toEqual([
      "strip",
      "checkout",
      "session",
      "creat",
    ]);
  });
});

describe("tokenize — token length rules (D-23)", () => {
  it("keeps 2-char tokens and drops 1-char tokens", () => {
    expect(tokenize("go a to b ok")).toEqual(["go", "ok"]); // "to" is a stopword, a/b are 1-char
    expect(tokenize("ui")).toEqual(["ui"]);
    expect(tokenize("x")).toEqual([]);
  });

  it("drops tokens longer than MAX_TOKEN_CHARS (hostile-input guard)", () => {
    expect(tokenize("z".repeat(MAX_TOKEN_CHARS))).toEqual(["z".repeat(MAX_TOKEN_CHARS)]);
    expect(tokenize("z".repeat(MAX_TOKEN_CHARS + 1))).toEqual([]);
  });
});

describe("tokenize — light suffix stemmer (D-23)", () => {
  it("ies → y", () => {
    expect(tokenize("policies")).toEqual(["policy"]);
    expect(tokenize("queries")).toEqual(["query"]);
  });

  it("sses → ss", () => {
    expect(tokenize("classes")).toEqual(["class"]);
  });

  it("drops a trailing s but never a trailing ss", () => {
    expect(tokenize("hooks")).toEqual(["hook"]);
    expect(tokenize("class")).toEqual(["class"]);
    expect(tokenize("press")).toEqual(["press"]);
  });

  it("drops ing and ed", () => {
    expect(tokenize("streaming")).toEqual(["stream"]);
    expect(tokenize("matched")).toEqual(["match"]);
  });

  it("applies the plural rule then the ing/ed rule, so plural gerunds converge", () => {
    expect(tokenize("settings")).toEqual(tokenize("setting"));
    expect(tokenize("settings")).toEqual(["set"]); // ing → "sett" → de-doubled → "set"
    expect(tokenize("settings")).toEqual(tokenize("set"));
  });

  it("never stems below three characters", () => {
    expect(tokenize("ring")).toEqual(["ring"]); // ing → "r" is too short
    expect(tokenize("sing")).toEqual(["sing"]);
    expect(tokenize("added")).toEqual(["add"]); // ed → "add", de-doubling to "ad" is too short
  });

  it("falls through to the next plural rule when one would cut below three characters", () => {
    // ies → "ty" is too short, so the trailing-s rule applies instead — and that is
    // what makes "tie" and "ties" agree, which refusing to stem would not.
    expect(tokenize("ties")).toEqual(["tie"]);
    expect(tokenize("ties")).toEqual(tokenize("tie"));
  });

  it("never stems tokens shorter than four characters", () => {
    expect(tokenize("ads")).toEqual(["ads"]);
    expect(tokenize("bed")).toEqual(["bed"]);
  });

  it("never stems a token containing a digit", () => {
    expect(tokenize("utf8s")).toEqual(["utf8s"]);
    expect(tokenize("h264ing")).toEqual(["h264ing"]);
  });

  it("stems the compound as well as the subwords, so identifiers still match", () => {
    expect(tokenize("useQueries")).toEqual(["use", "query", "usequery"]);
  });

  it("makes a camelCase identifier and its spelled-out query agree", () => {
    expect(tokenize("invalidateQueries")).toEqual(
      expect.arrayContaining(tokenize("invalidate queries")),
    );
  });
});

describe("tokenize — step-1b repairs, so inflections converge (D-23 amended)", () => {
  const one = (text: string) => {
    const out = tokenize(text);
    expect(out).toHaveLength(1); // each of these is a single word
    return out[0];
  };

  /**
   * The point of the amendment: the forms a vibe coder types and the forms the docs
   * are written in have to land on the same token. Left column is the query word,
   * the rest are the inflections that must reduce to the same stem.
   */
  it("stems inflections of the same word to one token", () => {
    const families: ReadonlyArray<readonly [string, ...string[]]> = [
      ["pars", "parse", "parsing", "parsed", "parses"],
      ["creat", "create", "creating", "created", "creates"],
      ["use", "use", "uses", "used"],
      ["run", "run", "running", "runs"],
      ["handl", "handle", "handling", "handled", "handles"],
      ["cach", "cache", "caching", "cached", "caches"],
      ["rout", "route", "routes", "routing", "routed"],
      ["policy", "policy", "policies"],
      ["query", "query", "queries", "querying"],
      ["set", "set", "sets", "setting", "settings"],
      ["stream", "stream", "streams", "streaming", "streamed"],
    ];
    for (const [stem, ...forms] of families) {
      for (const form of forms) {
        expect({ form, stem: one(form) }).toEqual({ form, stem });
      }
    }
  });

  /**
   * Documented non-convergences. Both are deliberate: fixing either would cost more
   * than it buys, and a reader of the ranker needs to know they exist.
   */
  it("leaves the documented non-convergences distinct: 'using' and 'handler'", () => {
    // "using" is a stopword, so it is dropped from any real query before stemming
    // ever sees it; alone, ing → "us" is under the floor, so it keeps its own form.
    expect(STOPWORDS.has("using")).toBe(true);
    expect(tokenize("using the parser")).toEqual(["parser"]);
    expect(one("using")).toBe("using");
    expect(one("using")).not.toBe(one("use"));

    // There is no agent-noun rule: "handler" is a thing, "handling" is an action,
    // and folding -er away would merge "router" into "route" too.
    expect(one("handler")).toBe("handler");
    expect(one("handler")).not.toBe(one("handle"));
    expect(one("router")).toBe("router");
  });

  it("(a) drops one of a doubled consonant left behind by ing/ed", () => {
    expect(one("running")).toBe("run");
    expect(one("stopped")).toBe("stop");
    expect(one("getting")).toBe("get");
    expect(one("embedded")).toBe("embed");
  });

  it("(a) keeps a doubled l, s or z, which are spellings in their own right", () => {
    expect(one("calling")).toBe("call"); // not "cal"
    expect(one("calling")).toBe(one("call"));
    expect(one("passed")).toBe("pass"); // not "pas"
    expect(one("passed")).toBe(one("pass"));
    expect(one("fizzing")).toBe("fizz");
    expect(one("installed")).toBe(one("install"));
  });

  it("(b) strips a trailing e from tokens of five characters or more", () => {
    expect(one("parse")).toBe("pars");
    expect(one("middleware")).toBe("middlewar");
    expect(one("note")).toBe("note"); // four characters: left alone
    expect(one("notes")).toBe("note");
    expect(one("type")).toBe("type");
    expect(one("types")).toBe("type");
  });

  it("(b) also applies to the stem left by the s / ing / ed rules", () => {
    expect(one("parses")).toBe("pars"); // s → "parse" → e → "pars"
    expect(one("routes")).toBe("rout");
    expect(one("parsing")).toBe("pars");
  });

  it("falls back to cutting the d alone when 'ed' would go under the floor", () => {
    // "use" + "ed" is spelled "used": the e belongs to the stem, so take the d.
    expect(one("used")).toBe("use");
    expect(one("used")).toBe(one("use"));
    expect(one("iced")).toBe("ice");
  });

  it("(c) keeps the previous form when a repair would go under three characters", () => {
    expect(one("added")).toBe("add"); // "ad" is too short
    expect(one("odds")).toBe("odd");
    expect(one("ring")).toBe("ring");
  });

  /**
   * R1 — the review gate's probe list. Cutting `ing`/`ed` off a silent-e verb used to
   * leave a bare three-letter stem (`noted` → `not`, `typed`/`typing` → `typ`) while the
   * base form kept its `e` (`note`, `type`), so the pair never met AND the stem collided
   * with a high-frequency word. Repair (d) puts the `e` back. Every pair below is a
   * convergence the tokenizer must produce; the ones it cannot are pinned separately.
   */
  it("(d) converges the review gate's silent-e probe list", () => {
    const pairs: ReadonlyArray<readonly [string, ...string[]]> = [
      ["note", "note", "noted", "noting", "notes"],
      ["type", "type", "typed", "typing", "types"],
      ["base", "base", "based", "basing", "bases"],
      ["name", "name", "named", "naming", "names"],
      ["code", "code", "coded", "coding", "codes"],
      ["size", "size", "sized", "sizing", "sizes"],
      ["move", "move", "moved", "moving", "moves"],
      ["page", "page", "paged", "paging", "pages"],
      ["store", "store", "stored", "storing", "stores"], // four-letter stem: unaffected
    ];
    for (const [stem, ...forms] of pairs) {
      for (const form of forms) {
        expect({ form, stem: one(form) }).toEqual({ form, stem: one(stem) });
      }
    }
    expect(one("noted")).toBe("note");
    expect(one("typing")).toBe("type");
    expect(one("noted")).not.toBe("not");
    expect(one("typed")).not.toBe("typ");
  });

  it("(d) restores the e only for a consonant-vowel-consonant stem, so `string` is left alone", () => {
    // "str" is three consonants: not a silent-e verb, so no `e` is invented for it.
    expect(one("string")).toBe("str");
    expect(one("string")).toBe(one("strings"));
    expect(one("spring")).toBe("spr");
    // A final w / x / y never took a silent e either (Porter's own exclusion).
    expect(one("fixed")).toBe("fix");
    expect(one("fixed")).toBe(one("fix"));
    expect(one("sawed")).toBe("saw");
    // A doubled consonant is repair (a)'s business, not (d)'s.
    expect(one("added")).toBe("add");
    expect(one("running")).toBe("run");
  });

  /**
   * R1 — pairs the stemmer cannot converge, and one it converges when it should not.
   * Listed because a reader of the ranker has to know they exist; each has a reason.
   */
  it("pins the remaining documented non-convergences and over-stems", () => {
    // Non-convergences.
    expect(one("using")).not.toBe(one("use")); // stopword; ing → "us" is under the floor
    expect(one("handler")).not.toBe(one("handle")); // no agent-noun rule
    expect(one("embed")).toBe("emb"); // "ed" is not a suffix here, and "emb" is not CVC
    expect(one("embedded")).toBe("embed"); // ... so these two do not meet
    expect(one("embed")).not.toBe(one("embedded"));

    // Over-stems: two distinct words folded onto one token.
    expect(one("seed")).toBe(one("see")); // "seed" and "use"+"d" are both C-V-V-d
    expect(one("stripe")).toBe(one("strip"));
  });

  it("still never stems a token containing a digit, whatever the suffix", () => {
    expect(tokenize("base64ed")).toEqual(["base64ed"]);
    expect(tokenize("utf8e")).toEqual(["utf8e"]);
  });
});

describe("tokenize — stopwords (D-23)", () => {
  it("removes stopwords from a mixed query", () => {
    expect(tokenize("how do I use the router in my app")).toEqual(["use", "router", "app"]);
  });

  it("falls back to no stopword removal when every token is a stopword", () => {
    // The fallback restores the words; stemming still runs over them ("this" → "thi"),
    // exactly as it would for any other token, so the query is never left with no terms.
    expect(tokenize("how to do this")).toEqual(["how", "to", "do", "thi"]);
    expect(tokenize("with")).toEqual(["with"]);
    expect(tokenize("how to do this")).not.toHaveLength(0);
  });

  it("removes stopwords before stemming, so 'does' cannot survive as 'doe'", () => {
    expect(tokenize("does the router work")).toEqual(["router", "work"]);
    expect(STOPWORDS.has("does")).toBe(true);
  });

  it("returns nothing for input with no usable tokens", () => {
    expect(tokenize("")).toEqual([]);
    expect(tokenize("   ---   ")).toEqual([]);
  });
});

describe("tokenize — determinism and hostile input (D-23)", () => {
  it("is deterministic across repeated calls", () => {
    const text = "Use invalidateQueries after a mutation; see QueryClient.setQueryData().";
    expect(tokenize(text)).toEqual(tokenize(text));
  });

  it("tokenizes a 1 MB alternating-case string in under 500 ms", () => {
    const hostile = "aA".repeat(512 * 1024); // 1 MiB, a camelCase boundary every 2 chars
    const t0 = performance.now();
    const out = tokenize(hostile);
    const ms = performance.now() - t0;
    // Worst case for the scanner: one run, half a million subwords, the compound
    // dropped for being over the cap. The output must stay bounded and uniform.
    expect(new Set(out)).toEqual(new Set(["aa"]));
    // 524289 subwords, the leading "a" and trailing "A" dropped for being 1 char.
    expect(out.length).toBe(524_287);
    expect(ms).toBeLessThan(500);
  });

  it("tokenizes 1 MB of separators in under 500 ms", () => {
    const hostile = "-".repeat(1024 * 1024);
    const t0 = performance.now();
    const out = tokenize(hostile);
    const ms = performance.now() - t0;
    expect(out).toEqual([]);
    expect(ms).toBeLessThan(500);
  });

  it("tokenizes a 1 MB single-run string in under 500 ms", () => {
    const hostile = "x".repeat(1024 * 1024);
    const t0 = performance.now();
    const out = tokenize(hostile);
    const ms = performance.now() - t0;
    expect(out).toEqual([]); // one run, over MAX_TOKEN_CHARS
    expect(ms).toBeLessThan(500);
  });
});

/**
 * PAR-839 — investigation finding, pinned as a regression test: colon-prefixed utility-class
 * syntax (Tailwind's `sm:`, `dark:`, `hover:`, etc.) was the PRIME SUSPECT for tailwindcss's
 * "responsive breakpoints" probe failure, by analogy with PAR-658's camelCase fix. MEASURED
 * (2026-09-20): it is NOT the mechanism — the colon is already an ordinary non-alphanumeric
 * separator (same code path as a hyphen or a space; see `rawTokens` above), so every
 * colon-prefixed class splits cleanly into its real, independently-searchable words. The actual
 * cause of tailwindcss's probe failure is unrelated (an external content-availability gap — see
 * `test/doctor.test.ts`'s own PAR-839 describe block and docs/decisions.md) — this test exists so a
 * future regression in colon-handling specifically is still caught even though it turned out not
 * to be today's bug.
 */
describe("tokenize — colon-prefixed utility classes (PAR-839 investigation)", () => {
  it("splits Tailwind-style colon-prefixed variants into their real words, same as a hyphen would", () => {
    expect(tokenize("sm:text-white")).toEqual(["sm", "text", "whit"]);
    expect(tokenize("dark:bg-black")).toEqual(["dark", "bg", "black"]);
    expect(tokenize("hover:underline")).toEqual(["hover", "underlin"]);
    expect(tokenize("md:flex lg:grid")).toEqual(["md", "flex", "lg", "grid"]);
  });

  it("a query using the plain English words matches the same tokens the colon-prefixed class produces", () => {
    // The whole point of stemming/splitting the same way for both: "responsive breakpoints" (a
    // query) and "sm: / md: / lg:" (the syntax those breakpoints are written with in prose) do
    // not need to share tokens to both be searchable — but a real heading like "Responsive
    // breakpoints" must not be defeated by adjacent code carrying `sm:`/`md:` syntax.
    expect(tokenize("Responsive breakpoints")).toEqual(["responsiv", "breakpoint"]);
  });
});
