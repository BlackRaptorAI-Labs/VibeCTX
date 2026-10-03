# RELEASING.md — pre-tag reconciliation checklist

Run this before cutting any release tag, after the last PR for the release has merged. **An
open PR at tag time is a decision, never an oversight.** Merge it, or record in the release
PR description exactly which PR is deliberately deferred and why — never leave one open
silently and tag anyway.

Why this exists (PAR-831): the 2026-09-17 release nearly shipped with two finished, twice-reviewed,
CLEAN-reported PRs (PAR-811, PAR-747) left out of `main` — each had no worktree driving it to
merge, so nothing pushed it there — while eight follow-up issues had already been filed against
PAR-811's fix, and twenty milestone issues still read Todo in Linear while their code was
already merged. No CI check, branch-protection rule, or per-PR review gate catches this: each
gate checks its own PR correctly and never the set. It was caught by hand. This checklist is
the one control for checking the set.

## 1. Reconcile merged PRs against Linear

```
gh pr list --state merged --limit 50 --json number,headRefName,mergedAt
```

Branch names carry the PAR number (`par-<number>-<slug>`). For every merged PR in the release
window, confirm its Linear issue is `Done` or `Canceled` — not still `Todo`/`In Progress`.

## 2. Find stragglers — every open PR is a decision

```
gh pr list --state open
```

For each one: merge it now, or write into the release PR description which PR is deferred
and why (e.g. deferred to 0.2.1, tracked as PAR-nnn). An open PR the checklist didn't mention
is the failure mode this step exists to catch.

### 2a. Find stalled branches — every branch is a decision too (PAR-841, PAR-1037)

A branch can go missing from BOTH checks above: pushed, then never turned into a PR at all —
neither "merged" (step 1) nor "open" (step 2) sees it, because it is neither. This step looks
at **every** branch on `origin` except `main`, whatever its name: branches here do not all
follow the `par-*` pattern, so a name filter misses exactly the branches nobody planned for
(final audit L-18).

```
git fetch --prune origin && comm -23 <(git branch -r --format='%(refname:lstrip=3)' | grep -v -x -e HEAD -e main | sort -u) <(gh pr list --state all --limit 1000 --json headRefName -q '.[].headRefName' | sort -u)
```

Reads as: every branch name on `origin` (without the `origin/` prefix, and without `HEAD` and
`main`), MINUS every branch name that has a PR in ANY state (open, closed, or merged) —
`--state all` is load-bearing here; `--state open` alone would misreport every
merged-but-undeleted branch (the common case in this repo — merged PRs are not auto-deleted) as
"stalled". Anything left in the output is a real finding: a branch someone pushed and then never
opened a PR for. Merge it through a PR, delete it, or record in the release PR description why
it stays. `git branch -r` reads LOCAL remote-tracking refs, not `origin` live: without the
leading `git fetch --prune origin`, a branch pushed by another session — exactly the case this
detector exists to catch — is invisible, and without `--prune` a branch already deleted on the
remote false-positives as "stalled". Re-run this before every tag, the same as step 2 — an
empty result today says nothing about tomorrow.

## 3. Where a finding belongs, strongest first — then reconcile the milestone against it

Prose is the fallback, not the goal. Where a tool can be made to refuse rather than merely
warn, file that enforcement change instead of a warning a future reader has to find and
believe. A finding that lives only in prose is exactly how PAR-653's own blocker stayed
invisible while its own issue body still told readers to run the probe, and PAR-746 records
the general class: a finding that exists only in a comment, a code comment, or a chat relay is
not a tracked finding.

Strongest to weakest:

1. **Enforced in code, at the point of use.** Where a tool can refuse to produce a misleading
   result, that IS the record — nobody has to remember it or read it to be protected by it.
2. **In the data.** A provenance or metadata field that travels with the artifact itself, so
   anyone reading the artifact reads the caveat with it.
3. **The release PR description.** The release-time status: what shipped with its done-when
   unmet, and why. Versioned with the tag; what an auditor opens later.
4. **`docs/decisions.md`.** Only once a finding stops being a one-release status and
   becomes a standing constraint with no expiry of its own — hypothetically, "no external
   ranking claim ships until a gold set is re-labelled" would belong here, though as of this
   writing that constraint is recorded only in the release PR description below, not yet promoted.
   A decision, not a status.
5. **The tracker (Linear).** Discoverability, not authority. An issue POINTS AT levels 1–4
   rather than restating their content — two independent prose copies of the same fact is how
   they drift apart from each other.

Every issue in the release milestone is `Done` or `Canceled`. Any whose Done-when was not
fully met records why at the strongest level available, and the milestone issue points at that
record rather than repeating it.

**Worked example — PAR-658.** Its done-when (PAR-658: `"correct section in top result"`
improves over 0.1.2) is recorded NOT MET. Level 2 is what a reader of the artifact itself would
see first: `docs/eval/probe-gold.json`'s own `provenance` field states "hand-labelled against
GitHub README fallbacks on 2026-09-06; docs-site llms.txt unreachable from the build sandbox" —
the gold set's LABELS were hand-written against README fallbacks because the real docs-site
documents were unreachable at labelling time. (The file's own `corpus` field says the same
thing, frozen at that same labelling-time snapshot — it describes what was fetched on
2026-09-06, not what the eval fetches when re-run today, so read it as historical, not current.)
The EVAL CORPUS, when the script is actually re-run, is those real docs-site `llms-full.txt`
documents — reachable from a machine with real network access (PAR-827: the first eval ran
from the maintainer's machine, where the real documents were reachable), still NOT reachable
from the build sandbox itself. The corpus is not the problem; the labels are, because they
describe different documents than the corpus they are graded against today. Level 3, the
release PR description, is where that conclusion is actually written down as the release-time
status — level 2 is the evidence it cites, not a
freestanding record of the conclusion on its own.

That mismatch is exactly why the project's own remediation, PAR-827, is a RE-LABEL of the gold
set, not a re-fetch of the corpus. Revisit-by is not running the eval again now that a machine
capable of reaching the corpus exists — one already does, and re-running it unchanged fixes
nothing. The actual revisit-by, per PAR-827's own Fix section, is: re-label `probe-gold.json`
against the real corpora, then re-run `scripts/eval-retrieval.mjs` and post the result to
PAR-658. No external ranking claim ships before that. (A stronger fix than re-labelling alone,
not yet filed: extend the validator to refuse when a resolved URL disagrees with the corpus its
gold set declares — level 1 of the hierarchy above — so this class of mismatch can't recur
silently. That is a proposal, not something PAR-827 currently commits to.)

## 4. Re-measure after the last merge, not before

A number measured before the last PR landed describes a `main` that no longer exists. Record
these once, in the release PR description — this is a point-in-time release
figure, not a regression gate:

- `npm test` — the test count and pass/fail, taken on `main` at the commit the release is
  actually cut from.
- `npm audit` and `npm audit --omit=dev` — record both; if they differ, say why the gap is (or
  isn't) an accepted risk, in the same release PR description.

## 5. README's pinning instructions cite the tag actually being cut

README's "On pinning" blockquote's `git checkout v<version>` example names
`v<package.json version>` — the tag this release cuts — from the release PR onward (PAR-847,
PAR-1037). `test/readme-release-consistency.test.ts` enforces it three ways: the example must
equal `v<package.json version>`; on a commit that carries a tag, it must equal that tag; and it
may never name a version older than the last tag reachable from HEAD. So the release PR bumps
`package.json` and the blockquote together and stays green before the tag exists, and a tag
cut on a commit whose README still names the previous release fails. The same test also pins
the Install section's literal `engines.node` range against `package.json`'s own value — re-run
it here too if `engines.node` changed since the last tag (see D-80 in `docs/decisions.md`).

## 6. Version bump

`package.json`'s version bump happens in the release PR, on top of the reconciled `main` from
steps 1–3 above — not on an earlier commit taken before a straggler PR merged.

## 7. Publish the GitHub Release (M-6)

The opt-in update check reads `GET /repos/<owner>/<repo>/releases/latest`. A tag alone is not
a release: with no GitHub Release that endpoint returns 404 and no one is ever told about the
new version. After the maintainer pushes the tag (tagging stays with the maintainer):

```
gh release create v<version> --verify-tag --title v<version> --notes-file <release-notes.md>
gh api repos/<owner>/<repo>/releases/latest --jq .tag_name
```

`--verify-tag` refuses to create a tag that does not already exist. The second command must
print `v<version>`; anything else (a 404, or the previous tag) means the release is not live
yet.

## 8. Build the public repository from the tag (X-2, M-8)

The public repository is built from the tagged commit, never from a working tree: a working
tree can hold untracked files (local audit notes, scratch output) that `git ls-files` and the
public-tree scrub test never see.

```
mkdir <fresh> && git -C <source> archive --format=tar v<version> | tar -x -C <fresh>
cd <fresh> && git init -b main && git add -A
git -c user.name="<github-login>" -c user.email="<id>+<github-login>@users.noreply.github.com" commit -m "v<version>"
diff <(git -C <fresh> ls-files | sort) <(git -C <source> ls-tree -r --name-only v<version> | sort)
```

- Commit as the account's GitHub noreply identity (Settings → Emails shows the exact
  `<id>+<login>@users.noreply.github.com` address), never a personal or company address.
- The `diff` must print nothing before anything is pushed: the fresh repository's file list
  equals the tag's, file for file.
- Before the old repository is made private (a maintainer-only setting change), list its forks
  and decide about each one: `gh api repos/<owner>/<old-repo>/forks --jq '.[].full_name'`.

