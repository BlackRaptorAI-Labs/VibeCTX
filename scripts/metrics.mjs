#!/usr/bin/env node
/**
 * PAR-652 item 9 — the project's status numbers, printed for a human to paste.
 *
 *   node scripts/metrics.mjs
 *
 * Deliberately NOT wired to a schedule or to an issue tracker — this prints numbers for a
 * human to read, not a cron job that posts them into a tracker where they will rot.
 *
 * It reads the repository's public, unauthenticated figures from api.github.com:
 * open issues, stars and forks.
 *
 * There is deliberately NO install count. VibeCTX is distributed as source — users clone
 * and build — and a clone is not observable from here: GitHub's traffic/clones endpoint
 * requires push access to the repository, and the npm download counts this script used to
 * print now measure an abandoned channel (the last version published to npm was 0.1.2, in
 * July 2026). Printing a stale npm number as if it were adoption would be worse than
 * printing nothing, so this script prints nothing for it and says why.
 *
 * HONEST DEGRADATION is the design constraint, because reachability is not a given:
 * api.github.com answers 403 through the agent sandbox's proxy while resolving normally
 * from an ordinary machine, so the same script legitimately prints figures in one place and
 * `unknown` in another. Do not encode either as a fact — let the run report what it found.
 * A number this script cannot obtain is never printed as `0` — a zero is a measurement and
 * would be a lie here. It prints what it could not reach and why, and it
 * exits 0 either way: not knowing is a normal outcome, not a failure of the script.
 */

import { REPO_SLUG, REPO_URL, REPO_API_URL } from "../src/repository.js";
const TIMEOUT_MS = 10_000;

/**
 * One GET, JSON or an explanation. Never throws.
 * Returns { ok: true, data } | { ok: false, why } — `why` is what a person needs to see.
 */
async function getJson(url) {
  try {
    const res = await fetch(url, {
      headers: { "user-agent": `vibectx-metrics (+${REPO_URL})`, accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 404) return { ok: false, why: "not found (404)", notFound: true };
    if (!res.ok) return { ok: false, why: `HTTP ${res.status}` };
    return { ok: true, data: await res.json() };
  } catch (e) {
    const cause = e?.cause?.code ?? e?.code;
    const name = e?.name === "TimeoutError" ? `timed out after ${TIMEOUT_MS / 1000}s` : undefined;
    return { ok: false, why: name ?? (cause ? `${cause}` : e?.message ?? String(e)) };
  }
}

/** The repository's public counters, in ONE request — or the reason there is no number. */
async function repoFigures() {
  const r = await getJson(REPO_API_URL);
  if (r.notFound) {
    const why = "the repository is private or does not exist under that name";
    return { issues: { unknown: why }, stars: { unknown: why }, forks: { unknown: why } };
  }
  if (!r.ok) {
    const why = `GitHub API unreachable (${r.why})`;
    return { issues: { unknown: why }, stars: { unknown: why }, forks: { unknown: why } };
  }
  const num = (v, note) =>
    typeof v === "number" ? (note ? { value: v, note } : { value: v }) : { unknown: "the API response carried no such field" };
  return {
    // GitHub's `open_issues_count` counts open pull requests as issues. Say so rather than
    // presenting it as an issue count it is not.
    issues: num(r.data?.open_issues_count, "includes open pull requests (GitHub counts them as issues)"),
    stars: num(r.data?.stargazers_count),
    forks: num(r.data?.forks_count),
  };
}

const line = (label, result, suffix = "") => {
  if (result.unknown !== undefined) return `  ${label.padEnd(22)} unknown — ${result.unknown}`;
  return `  ${label.padEnd(22)} ${result.value}${suffix}${result.note ? ` (${result.note})` : ""}`;
};

const { issues, stars, forks } = await repoFigures();

const all = [issues, stars, forks];
const known = all.filter((r) => r.unknown === undefined).length;

console.log(
  [
    `VibeCTX status — ${new Date().toISOString().slice(0, 10)}`,
    `  repository            ${REPO_SLUG}`,
    "  distribution          source (git clone + npm run build)",
    "",
    line("open issues", issues),
    line("stars", stars),
    line("forks", forks),
    "  installs               not observable — see the header comment",
    "",
    known === all.length
      ? `  All ${all.length} figures were retrieved live just now.`
      : `  ${all.length - known} of ${all.length} figures could not be retrieved; the reason is on the line itself.`,
    "  MEASURED where a number is shown; an `unknown` line is not a zero.",
  ].join("\n"),
);
