/**
 * D-23 — the one tokenizer VibeCTX uses for queries, headings, section bodies and
 * code blocks. Retrieval quality lives or dies here: `useEffect` has to match "use
 * effect", `policies` has to match `policy`, and none of it may open a
 * pathological-input hole, so every scan below is a single linear pass over the
 * characters. Unicode character classes examine one code point at a time;
 * they have no variable-length alternatives or backtracking.
 */

/**
 * D-38 — THE RETRIEVAL VERSION. Bump this by one whenever you change ANY of:
 *
 *   1. `tokenize` or `stem` (this file) — the tokens a document is stored under;
 *   2. `splitSections` (retrieval.ts) — which section a token belongs to, and how many there are;
 *   3. `HEADING_WEIGHT` / `weighSections` (retrieval.ts) — the frequencies the postings hold.
 *
 * Why a version and not just the content hash the search index already keeps: the hash proves
 * the DOCUMENT is unchanged, which is exactly why a change to the code above slips past it. An
 * index built by yesterday's tokenizer describes the same bytes under different terms, so
 * today's query looks up terms that are not there and the answer is silently EMPTY rather than
 * visibly wrong. MEASURED by the PAR-659 schema gate: deleting the `ies→y` stemmer rule made a
 * surviving index return zero groups where a freshly built one returns the right section.
 *
 * `readIndex` refuses a file whose `retrievalVersion` is not this one, exactly as it refuses a
 * stale hash: the postings are rebuilt from the cache, never used. So bumping this costs one
 * slower search per library and nothing else; NOT bumping it costs correctness.
 *
 * It lives HERE, in the leaf module, rather than beside the code it mostly guards, so that
 * every module it versions can import it without a cycle — retrieval.ts imports this file, and
 * search-index.ts imports both.
 */
export const RETRIEVAL_VERSION = 2;

/** Longest token kept. A real identifier is far shorter; a 1 MB run of `x` is not a
 *  token, it is a denial-of-service payload, and dropping it keeps ranking linear. */
export const MAX_TOKEN_CHARS = 64;

/** D-23's stopword list. Small and closed on purpose: these are the words a vibe
 *  coder types around the terms that matter ("how do I use the router"), never the
 *  terms themselves. Removed BEFORE stemming, so `does` cannot survive as `doe`. */
export const STOPWORDS: ReadonlySet<string> = new Set([
  "the", "a", "an", "of", "to", "in", "for", "and", "or", "is", "are", "with",
  "how", "what", "my", "i", "it", "this", "that", "be", "can", "do", "does",
  "when", "from", "by", "on", "at", "as", "into", "using",
]);

const isUpper = (c: number) => c >= 65 && c <= 90;
const isLower = (c: number) => c >= 97 && c <= 122;
const isDigit = (c: number) => c >= 48 && c <= 57;
const isAlnum = (c: number) => isLower(c) || isUpper(c) || isDigit(c);

const MIN_TOKEN_CHARS = 2;

function keepable(len: number): boolean {
  return len >= MIN_TOKEN_CHARS && len <= MAX_TOKEN_CHARS;
}

/**
 * Split one alphanumeric run into its camelCase / PascalCase subwords, appending
 * each keepable one (lowercased) to `out`, and return how many subwords the run
 * has. Boundaries, in one forward pass:
 *   lower|digit → UPPER   (`useEffect`, `s3Client`)
 *   UPPER → UPPER lower   (`HTTPServer` → HTTP | Server)
 * Digits never start a subword of their own, so `utf8` stays one token.
 */
function splitRun(text: string, start: number, end: number, out: string[]): number {
  let subwords = 0;
  let from = start;
  for (let i = start + 1; i < end; i++) {
    const c = text.charCodeAt(i);
    if (!isUpper(c)) continue;
    const prev = text.charCodeAt(i - 1);
    const boundary =
      isLower(prev) || isDigit(prev) || (isUpper(prev) && i + 1 < end && isLower(text.charCodeAt(i + 1)));
    if (!boundary) continue;
    subwords += 1;
    if (keepable(i - from)) out.push(text.slice(from, i).toLowerCase());
    from = i;
  }
  subwords += 1;
  if (keepable(end - from)) out.push(text.slice(from, end).toLowerCase());
  return subwords;
}

const LETTER_NUMBER = /^[\p{L}\p{N}]$/u;
const MARK = /^\p{M}$/u;
const CJK = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]$/u;
const ASCII_WORD = /^[A-Za-z0-9]+$/;

/** ASCII compounds retain their subwords. Other Unicode words stay complete,
 *  canonically normalized and case-folded. Unspaced CJK runs emit overlapping
 *  bigrams; an isolated CJK character keeps its own token. */
function rawTokens(text: string): string[] {
  text = text.normalize("NFC");
  const out: string[] = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    const first = String.fromCodePoint(text.codePointAt(i)!);
    if (!isAlnum(text.charCodeAt(i)) && !LETTER_NUMBER.test(first)) {
      i += first.length;
      continue;
    }
    if (text.charCodeAt(i) > 127 && CJK.test(first)) {
      let previous = first, pairs = 0;
      i += first.length;
      while (i < n) {
        const next = String.fromCodePoint(text.codePointAt(i)!);
        if (!CJK.test(next)) break;
        out.push(previous + next); pairs += 1; previous = next; i += next.length;
      }
      if (pairs === 0) out.push(first);
      continue;
    }
    let end = i + first.length;
    while (end < n) {
      const code = text.charCodeAt(end);
      if (isAlnum(code)) { end += 1; continue; }
      if (code <= 127) break;
      const next = String.fromCodePoint(text.codePointAt(end)!);
      if (CJK.test(next) || (!LETTER_NUMBER.test(next) && !MARK.test(next))) break;
      end += next.length;
    }
    const run = text.slice(i, end);
    if (ASCII_WORD.test(run)) {
      const subwords = splitRun(text, i, end, out);
      if (subwords > 1 && keepable(end - i)) out.push(run.toLowerCase());
    } else if (keepable(run.length)) {
      const folded = run.toLowerCase().normalize("NFC");
      if (keepable(folded.length)) out.push(folded);
    }
    i = end;
  }
  return out;
}

function hasDigit(token: string): boolean {
  for (let i = 0; i < token.length; i++) if (isDigit(token.charCodeAt(i))) return true;
  return false;
}

const MIN_STEM_INPUT = 4;
const MIN_STEM_RESULT = 3;
/** Shorter than this, a trailing `e` is load-bearing: `note` and `type` keep theirs. */
const MIN_E_STRIP_INPUT = 5;

/** Apply one suffix rule if the result stays at least MIN_STEM_RESULT long. */
function chop(token: string, suffix: string, replacement: string): string | undefined {
  if (!token.endsWith(suffix)) return undefined;
  const stemmed = token.slice(0, token.length - suffix.length) + replacement;
  return stemmed.length >= MIN_STEM_RESULT ? stemmed : undefined;
}

/** Consonants a suffix may have doubled. `l`, `s` and `z` are excluded because a
 *  double there is usually the word's own spelling: `call`, `pass`, `fizz` — cutting
 *  those would push `calling` onto `cal` and away from `call`. */
const DEDOUBLE = new Set("bcdfghjkmnpqrtvwxy".split(""));

/**
 * Repair (a) — Porter step 1b's de-doubling. `running` loses `ing` and leaves `runn`;
 * the second `n` was the suffix's doing, so drop it. Undefined when the token does not
 * end in a doubled consonant, or when the cut would fall under the floor (`added` →
 * `add` stays `add`, since `ad` is too short).
 */
function dedouble(t: string): string | undefined {
  const n = t.length;
  if (n < 2 || t[n - 1] !== t[n - 2] || !DEDOUBLE.has(t[n - 1]!)) return undefined;
  const out = t.slice(0, n - 1);
  return out.length >= MIN_STEM_RESULT ? out : undefined;
}

/** Consonants that never stood before a silent `e` in English spelling, so a stem ending
 *  in one never lost one: `fix` (not `fixe`), `saw`, `pay`. Porter's own exclusion. */
const NO_SILENT_E_AFTER = new Set(["w", "x", "y"]);

/** Porter's vowel test: `y` counts as a vowel only when a consonant precedes it, which is
 *  what makes `typ` (t-y-p) consonant-vowel-consonant and `str` three consonants. */
function isVowelAt(t: string, i: number): boolean {
  const c = t[i];
  if (c === "a" || c === "e" || c === "i" || c === "o" || c === "u") return true;
  return c === "y" && i > 0 && !isVowelAt(t, i - 1);
}

/**
 * Repair (d) — the silent `e` put BACK. Porter step 1b's `*o` rule, narrowed to the case
 * that bit us (R1): `ing`/`ed` came off a silent-e verb and left a bare three-letter
 * consonant-vowel-consonant stem — `noted` → `not`, `typed`/`typing` → `typ`, `based` →
 * `bas` — while the base form kept its `e` (repair (b) only fires from five characters up).
 * So the pair never met, and the stem collided with a high-frequency word (`not`, `see`).
 * Restoring the `e` converges them on the base form instead.
 *
 * Narrow on purpose. Only a three-letter stem, only CVC, only when the last consonant is
 * one that can precede a silent `e`: `str` (three consonants) stays `str`, so `string` is
 * not rewritten to `stre`, and `fix`/`fixed` meet at `fix`.
 */
function restoreSilentE(t: string): string | undefined {
  if (t.length !== MIN_STEM_RESULT) return undefined;
  const cvc = !isVowelAt(t, 0) && isVowelAt(t, 1) && !isVowelAt(t, 2);
  if (!cvc || NO_SILENT_E_AFTER.has(t[2]!)) return undefined;
  return `${t}e`;
}

/**
 * Repair (b) — the silent-e cut. English drops the `e` before `ing`/`ed`, so `parse`
 * and `parsing` can only meet at `pars`, `create` and `created` at `creat`. Applied to
 * the token that survives the suffix passes, which is what also carries `parses` →
 * `parse` → `pars` home. Only from five characters up: below that the `e` is usually
 * the word (`note`, `type`, `use`), and a 3-char stem collides with too much.
 */
function stripSilentE(t: string): string | undefined {
  if (t.length < MIN_E_STRIP_INPUT || !t.endsWith("e")) return undefined;
  const out = t.slice(0, t.length - 1);
  return out.length >= MIN_STEM_RESULT ? out : undefined;
}

/**
 * D-23's light deterministic stemmer. Three ordered passes, every rule refusing to cut
 * below three characters (c), and nothing at all applied to a token under four
 * characters or containing a digit (`utf8s`, version numbers):
 *
 *   1. plural — `ies→y`, `sses→ss`, trailing `s` but never `ss`
 *   2. verb   — `ing`, `ed`, then ONE of the two step-1b repairs, in Porter's order:
 *               (a) de-doubling, `running` → `runn` → `run`; else (d) the silent `e` put
 *               back on a three-letter CVC stem, `noted` → `not` → `note`. When `ed`
 *               alone would go under the floor the `e` belongs to the stem (`use` + `ed`
 *               is spelled `used`), so the `d` is cut instead.
 *   3. repair (b) — the silent `e` cut, unless (a) or (d) already fired.
 *
 * Two passes for suffixes rather than one so `settings` → `setting` → `set` converges
 * with `set`. What this buys, MEASURED by test/tokenize.test.ts "stems inflections of
 * the same word to one token" and "(d) converges the review gate's silent-e probe list":
 * parse/parsing/parsed/parses, create/creating/created, use/uses/used, run/running,
 * handle/handling, cache/caching/cached, route/routes/routing, policy/policies,
 * query/queries/querying, and — since repair (d) — note/noted/noting, type/typed/typing,
 * base/based, name/named, code/coded/coding, size/sized/sizing, page/paged/paging all
 * converge.
 *
 * Non-convergences that remain, and the reason for each (pinned by
 * "pins the remaining documented non-convergences and over-stems"):
 *   - `using` ≠ `use`. It is a stopword, so no real query reaches the stemmer with it;
 *     standing alone, `ing` → `us` is under the floor and it keeps its own form.
 *   - `handler` ≠ `handle`. There is no agent-noun rule: an `er` rule would also merge
 *     `router` into `route` and `parser` into `parse`, which loses more than it gains.
 *   - `embed` (→ `emb`) ≠ `embedded` (→ `embed`). `ed` is not a suffix in `embed`, and
 *     `emb` is not CVC, so repair (d) cannot put it right; no rule can tell the two apart
 *     without a lexicon.
 *
 * Over-stems — two words folded onto one token — and why each is tolerated:
 *   - `seed` → `see`. `seed` and `use`+`d` are both consonant-vowel-vowel-`d`; the `d`-cut
 *     that carries `used` → `use` cannot avoid carrying `seed` → `see`.
 *   - `stripe` → `strip`, `middleware` → `middlewar`. The silent-e cut over-stems nouns
 *     that merely end in `e`.
 * Queries and documents go through the same function, so a collision costs precision,
 * never a match.
 *
 * D-38: BUMP `RETRIEVAL_VERSION` (top of this file) WHEN YOU CHANGE ANY RULE HERE. The search
 * index stores documents under their STEMS; change a rule and every posting list on disk is
 * keyed to the old stems while queries arrive as the new ones, which the content hash cannot
 * see. MEASURED: deleting the `ies→y` rule made a surviving index return zero groups.
 */
export function stem(token: string): string {
  // English suffix rules do not remove letters from other languages.
  if (!ASCII_WORD.test(token)) return token;
  if (hasDigit(token)) return token;
  let t = token;
  if (t.length >= MIN_STEM_INPUT) {
    const plural =
      chop(t, "ies", "y") ??
      chop(t, "sses", "ss") ??
      (t.endsWith("ss") ? undefined : chop(t, "s", ""));
    if (plural !== undefined) t = plural;
  }
  let repaired = false;
  if (t.length >= MIN_STEM_INPUT) {
    const verb =
      chop(t, "ing", "") ??
      chop(t, "ed", "") ??
      (t.endsWith("ed") ? chop(t, "d", "") : undefined);
    if (verb !== undefined) {
      t = verb;
      // (a) and (d) are alternatives, in Porter's order: a doubled consonant is the
      // suffix's doing, and a CVC stem is a silent-e verb's. Both end the stemming.
      const single = dedouble(t);
      const restored = single === undefined ? restoreSilentE(t) : undefined;
      if (single !== undefined) {
        t = single;
        repaired = true;
      } else if (restored !== undefined) {
        t = restored;
        repaired = true;
      }
    }
  }
  if (!repaired) {
    const bare = stripSilentE(t);
    if (bare !== undefined) t = bare;
  }
  return t;
}

/**
 * Tokenize any text — query, heading, body or code — the same way.
 * Order matters: split → drop 1-char → stopwords → stem. Stopwords come first
 * because stemming would otherwise smuggle `does` through as `doe`; the
 * all-stopword fallback keeps a query like "how to do this" from tokenizing to
 * nothing at all.
 *
 * D-38: BUMP `RETRIEVAL_VERSION` (top of this file) WHEN YOU CHANGE THIS — the splitting
 * rules and the stopword list included. The search index is keyed to this function's output.
 */
export function tokenize(text: string): string[] {
  const raw = rawTokens(text);
  if (raw.length === 0) return [];
  let kept = raw.filter((t) => !STOPWORDS.has(t));
  if (kept.length === 0) kept = raw; // an all-stopword input keeps its stopwords
  return kept.map(stem);
}
