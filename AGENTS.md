# depsound-action agent guide

depsound-action is a GitHub Action that runs
[depsound](https://github.com/rvagg/depsound) on pull requests that change a
dependency and reports what it found: one sticky comment, one neutral check,
one workflow artifact holding the report and the reviewed bytes. It is two
composite actions (`action.yml` computes, `post/action.yml` publishes) and
some shell and `github-script` glue. There is no build step and no test
suite; the files in the repository are what runs.

This file is for coding agents and the people driving them, including agents
working without a brief. `README.md` is the user manual and the interface
specification. This file is the contract for changing the code. It assumes
nothing beyond this repository and the published depsound releases it
downloads.

## Telos

One sentence: **put depsound's evidence on the PR, never a verdict, and
never let the code that touches attacker bytes hold a write token.**

Everything else follows from it. Judge every change against these, in order:

1. **Token discipline.** The review job reads PR bytes with a read-only
   token and never checks out or executes anything from the PR. The post job
   holds the write scopes and touches nothing but the artifact the review
   job produced in the same run. Collapsing the two jobs, or moving any
   package-derived processing into the post job, is the one change that can
   turn this action into the pwn-request hazard it exists to avoid.
2. **Always speak.** A check-run alone is silence, and silence reads as
   approval. A run that analyses posts; a run that fails posts "analysis
   incomplete"; only a PR with no dependency change posts nothing. The check
   is always `neutral`, never `success` or `failure`.
3. **depsound owns the wording.** The comment body is depsound's
   `--format=markdown` output. The action adds a footer (reproduce command,
   agent hand-off, artifact link) and nothing else. Headline logic, triage
   words and the coverage boundary live in the CLI, where they are tested
   once and shared with the text and JSON renderers. Interpreting
   `report.json` in bash to write a better headline is the wrong repository.
4. **Pinned, verified inputs.** The depsound binary is a release asset,
   checked against the release's `checksums.txt` (a corrupt-download check)
   and then against its sigstore build-provenance attestation (the real
   anchor), or against a caller-supplied sha256. Every `uses:` pins a full
   commit sha. Nothing executed on the runner comes from the PR.
5. **Thin plumbing.** The two files a consumer copies are a trigger, minimal
   permissions and one `uses:` each. All logic lives here, so new behaviour
   reaches consumers by Dependabot bumping a sha, never by editing their
   workflow. A new permission scope or trigger is the one thing that forces
   an edit, and is a major version.

## Who depends on depsound-action

Repositories that copied `examples/depsound.yml` and let Dependabot bump the
two `uses:` shas. depsound itself dogfoods it in its own
`.github/workflows/depsound.yml`, as does this repository. Consumers see the
comment, the check and the artifact; the compatibility surface is:

- the workflow shape in `examples/depsound.yml` (trigger, two jobs, their
  permissions);
- the inputs and outputs of both actions as the README tables state them;
- the artifact name `depsound-report` and its contents: `comment.md`,
  `report.json`, `meta.json`, `evidence/` with its `manifest.json`;
- the comment marker `<!-- depsound -->` and the check name `depsound`,
  which branch protection may require by name.

Dependabot PRs and fork PRs carry a read-only `GITHUB_TOKEN` on a plain
`pull_request` event; that is why the workflow runs on
`pull_request_target`, and why the model below exists.

## How it works

```text
pull_request_target (base branch's workflow and pins execute, never the PR's copy)
|
|- job review   permissions: contents: read
|    actions/checkout        the trusted base, credentials not persisted
|    fetch PR head           as git objects only, one transient-auth fetch; nothing checked out
|    download depsound       release asset by version; checksums.txt; attestation or caller sha256
|    detect                  git diff names WHICH manifests changed; `git show` reads both
|                            versions; `depsound detect --file=pairs.tsv` parses them into a
|                            bulk list (never the diff text)
|    run                     `depsound bulk --file=list --format=markdown --evidence-dir=out/evidence`
|                            comment.md, report.json (copied from evidence), meta.json
|    status envelope         complete, no-changes or incomplete, bound to the event head
|    upload-artifact         the report directory only, name depsound-report
|
|- job post     needs: review   if: always() && result != cancelled
     permissions: pull-requests: write, checks: write, actions: read
     download-artifact       same run; missing/corrupt report means incomplete, never no-changes
     github-script           neutral per-head check and bounded Bot-authored sticky comment;
                             explicit no-change state replaces older flags; current-head check
                             before writing; typed replay input or evidence-only handoff
```

Files:

- `action.yml` the compute action. Inputs `manifests`, `deps`,
  `depsound-version`, `depsound-sha256`, `cooldown`, `github-token`;
  outputs `markdown`, `title`, `tripped`.
- `post/action.yml` and `post/post.cjs` the poster, with Node tests alongside.
  Input `github-token` only. Only the same-run `pull_request_target` layout is
  supported; legacy `workflow_run` posting is rejected.
- `examples/depsound.yml` the file consumers copy, with the security notes
  in comments. `.github/workflows/depsound.yml` is the same file dogfooding
  this repository.
- `.github/dependabot.yml` bumps the `uses:` shas in the workflow, the root
  action and `post/`, monthly with a five-day cooldown.

### What the compute job may and may not do

- It parses manifest bytes from the PR as data. `detect` parses both full
  versions of each changed manifest and diffs the resolved sets; the change
  list never comes from diff hunks, which reorder and lie.
- It never checks out the PR head, never runs `npm`, `go`, `cargo` or any
  build, and never `go run`s depsound from a checkout. The checkout is data
  to analyse; running its code hands execution to the PR author regardless
  of how few secrets the job holds.
- depsound then fetches and analyses the published artifacts the manifests
  name, not the branch, and treats all of it as hostile data.
- Package-controlled names never choose paths inside the uploaded artifact.
  depsound's evidence exporter owns bounds, fixed numeric file names, hashes
  and explicit omissions; the action adds no cache scan and no second
  collection pass.

### What the post job may and may not do

- It reads `meta.json`, `comment.md`, and optional `review-input.json`. Rerun
  commands use that input file. When it is missing, the comment tells the reader
  to inspect the saved report and files instead. Evidence is never executed.
- It adopts only a Bot-authored comment with both the depsound title and sticky
  markers. Comments are bounded in UTF-8 bytes and retain the artifact route.
- An explicit no-change envelope still upserts a neutral check and scoped comment.
  The event head must match the envelope; the current PR head is checked before the comment write.
- In the same-run layout the PR number comes from the trusted event, never
  from the artifact.
- The check and the comment are independent writes with retries; one
  failing never suppresses the other, and a write that still fails marks the
  job red so it can be re-run rather than silently dropping the post.
- Text status only. No emoji, no shields badges, no images: an external
  image is an exfil or beacon channel and can be blocked in email, a bad look
  for a supply-chain tool. Email renders `<details>` expanded and has no JS,
  so the firehose goes to the artifact, never inline.

## The depsound contract

The action is a consumer of specific depsound behaviour. Each of these is
something a CLI release must keep or this repository must follow:

- release assets named `depsound_<ver>_linux_<arch>.tar.gz` and
  `depsound_<ver>_darwin_all.zip`, with `checksums.txt` beside them;
- a build-provenance attestation on every asset, verifiable with
  `gh attestation verify <asset> --repo rvagg/depsound`;
- `depsound detect --file=<pairs.tsv>` reading tab-separated
  `<path> <old> <new>` triples (`-` for an absent side) and printing a bulk
  list;
- `depsound bulk --file=<list> --format=markdown --evidence-dir=<new-dir>`
  writing the comment to stdout and `report.json` plus `manifest.json`
  into the evidence directory;
- a `<!-- depsound-title: ... -->` marker in the Markdown, from which the
  action derives `title` and `tripped` (a title containing "flagged for
  review" trips; "no signals tripped" does not; anything unrecognised trips,
  because silence is not safety);
- the `<!-- depsound -->` marker the action's footer is spliced before;
- `report.json` as an array whose rows carry `ref` (the exact
  `<eco>:<name> <from> -> <to>` reviewed), so a grouped PR gets a runnable
  `bulk` reproduce block.

The `depsound-version` default is the newest CLI release the action has been
exercised against. Evidence export needs `v0.36.0` or later. A change here
that needs a new CLI behaviour waits for that CLI release and bumps the
default in the same PR, with the download and attestation step re-run
against the real asset.

## Making a change

There is no automated test suite. Verification is manual and the PR says
what was run:

1. Read the security model in the README and the two "may and may not"
   lists above before touching `action.yml` or `post/action.yml`. State in
   the PR which rule you touched and why it still holds.
2. Syntax: every `run:` block passes `bash -n`; both YAML files parse. If
   `actionlint` is available, run it on `.github/workflows/`.
3. Shell steps: extract the block, set the `env:` it expects, and run it
   locally against the real attested release binary (download it the way the
   step does). Cover the no-change path, the failure path (the marker must
   be written and uploaded) and a wrong `depsound-sha256` (must fail before
   extraction).
4. The poster: run the `github-script` body under Node with the `github`,
   `context` and `core` objects stubbed and the writes logged, against a
   report directory from step 3. Check the Bot-author rule, the marker
   splice, the reproduce command for one ref and for several.
5. End to end: open a PR on a repository you control that uses your branch's
   sha, and read the comment as a reviewer would. The dogfood workflow here
   runs the pinned release, not your branch, so it will not exercise an
   unreleased change.
6. Interface change (an input, an output, the artifact layout, a permission):
   update the README tables and `examples/depsound.yml` in the same PR. A
   new permission or trigger is a breaking change.
7. One concern per PR.

## Code style

- Shell steps start `set -euo pipefail`, read their inputs through `env:`
  (never interpolate `${{ }}` into the script body: an input is attacker
  reachable text), and quote every expansion.
- `github-script` is plain Node, `const`, no dependencies, errors caught per
  write and reported through `core`.
- Comments earn their place and their word count. They describe why a step
  is shaped as it is (the token boundary, the trusted source of a value)
  rather than what it does. Never what changed or which issue it fixed.
- Simple language in prose and comments. Short sentences. Plain punctuation:
  no em or en dashes, no emoji, no characters that break alignment.
- Nothing new at the repository root beyond what Marketplace requires
  (`action.yml` must be at the root; that is why this is its own repository
  and not a subdirectory of depsound). Never delete files to tidy; move them
  to `_archive/`.

## Commits and pull requests

- Conventional commits, terse and undecorated: `feat:`, `fix:`, `docs:`,
  `chore:`. Subject imperative, lower case, no trailing period, under 72
  characters. No labels, badges or co-author footers.
- `feat!:` for anything a consumer must react to: a new permission scope, a
  new trigger, a renamed input or output, an artifact layout change.
- Default branch is `master`. History is linear. Dependabot PRs are
  squash-merged with the title as the subject.
- Every `uses:` pins a full commit sha with a `# vX.Y.Z` tracking comment,
  never a moving tag. The action's own `uses: rvagg/depsound-action` pins
  are re-pinned by the release, not by hand.
- Do not change the dependabot configuration or the self-reference pins as a
  side effect.
- Agents do not commit, push, tag, create releases or open PRs on their own.
  Prepare the change and the message; the person driving performs the Git
  step, or asks for it by name.

## Releases

There is no version file: the release tag is the version, and the sha it
points at is what consumers pin. No moving major tag (`@v1`) is maintained;
consumers pin shas and Dependabot moves them. A release is cut by the
maintainer, in this order:

1. On a clean, up-to-date `master`, commit any pending change and push.
2. Create the GitHub release `vX.Y.Z` targeted at that exact commit, with
   generated notes. The tag is created by the release so it can never land
   on a stale head.
3. Re-pin every `uses: rvagg/depsound-action` and
   `rvagg/depsound-action/post` reference to the new sha with a `# vX.Y.Z`
   comment: `.github/workflows/depsound.yml` and `examples/depsound.yml`
   here, and depsound's own `.github/workflows/depsound.yml`. Commit as
   `chore: pin self-references to vX.Y.Z` here and
   `chore: pin depsound-action to vX.Y.Z` there.

The action is also released as the tail of every depsound CLI release: the
CLI release bumps `depsound-version` in `action.yml` and the README, then
cuts a patch release here and re-pins. So a CLI release normally produces
two tags, and a pending change here that deserves its own minor or major
should be released on its own before the next CLI cascade rather than riding
an automatic patch bump. Contributors do not release; say in the PR if a
change needs a CLI release first.

## Direction

For an agent asked to improve this project without a brief. The report-only
core is complete; the queued layers are about turning facts into gates
without the tool ever claiming "safe". Good work, roughly in order of value:

- **Policy layer.** Optional repository rules over factual fields, only after
  unknown, uncollected and measured zero remain distinct throughout the contract.
  This is the only layer allowed to escalate the check; the default stays neutral.
- **Installer cooldown.** Derive resolution policy from committed installer
  settings such as pnpm `minimumReleaseAge`, not Dependabot's PR-opening cooldown.
  Exact target age/admit-after facts remain separate from eligibility decisions.
- **The PR's own control surface as facts.** A dependency PR is wider than
  the package bytes: inventory non-manifest executable source, workflow
  files, setup or bootstrap scripts, weakened package-manager policy
  (`.npmrc`, `ignore-scripts`), `.npm-extension.{mjs,cjs}`, agent hook
  configuration and instruction files (`CLAUDE.md`, `AGENTS.md`) introduced
  or materially enlarged, as a list of paths and sizes. Never "this filename
  is malicious", always "this dependency PR also changes executable or
  control-plane files". Instruction file contents are attacker-writable
  data and are never read into the report.
- **A workflow trust analyser** over the consumer's workflows: trigger times
  permissions and secrets times code origin times pins times credential
  persistence, as facts. Together with the inventory above it is the gate
  on any future agent mode.
- **Lockfile-level redirect detection** for npm, pnpm and crates (a
  dependency pointed off the registry), once the CLI exposes it; today only
  Go `replace` and the declaration-file forms are flagged.

Work to avoid:

- An agent that runs in the job. It is deferred behind the inventory and
  analyser above, and behind the containment model (model credential only,
  no shell, no `GITHUB_TOKEN`, read-only tools, a trusted sanitising poster).
  Do not land a partial version.
- Auto-merge, approve, or any `success`/`failure` check conclusion.
- Checking out or executing PR content in either job, or any step that
  needs the PR's code to run.
- Images, badges, emoji or an inline firehose in the comment.
- A second rendering of the headline in bash or JavaScript; fix the wording
  in depsound.
- Reading `evidence/` in the post job.
- Moving-tag pins anywhere, including a convenience `@v1`.

## Keep this file true

When a change makes anything here inaccurate (an input added, a step
reshaped, a contract line with depsound changed, a queued item landed),
update this file in the same PR. Describe the project as it is. No history,
no change notes.

## References

- depsound, the CLI this wraps: https://github.com/rvagg/depsound
- depsound's review skill, the agent hand-off the comment links to:
  https://github.com/rvagg/depsound/blob/master/skills/review-dependency-change/SKILL.md
- GitHub Actions security hardening, including `pull_request_target`:
  https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions
- Artifact attestations and `gh attestation verify`:
  https://docs.github.com/en/actions/security-for-github-actions/using-artifact-attestations
- Composite actions: https://docs.github.com/en/actions/sharing-automations/creating-actions/creating-a-composite-action
- `actions/github-script`: https://github.com/actions/github-script
- Dependabot for GitHub Actions, including `cooldown`:
  https://docs.github.com/en/code-security/dependabot/working-with-dependabot/dependabot-options-reference
