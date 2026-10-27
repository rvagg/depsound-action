# depsound-action agent guide

depsound-action is a GitHub Action that runs
[depsound](https://github.com/rvagg/depsound) on pull requests that change a
dependency and reports what it found: one sticky comment, one neutral check,
one workflow artifact holding the report and the reviewed bytes. It is two
composite actions (`action.yml` computes, `post/action.yml` publishes) and
some shell and `github-script` glue. There is no build step. CI runs the Node
poster tests and validates the action YAML and shell blocks.

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
2. **Always speak.** A check-run alone can read as approval. Analysis posts a
   report; failure posts "analysis incomplete". A PR without dependency changes
   gets an explicit no-change comment and check. The check is always `neutral`,
   never `success` or `failure`.
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
- `.github/scripts/download-depsound.sh` verifies the binary for the compute
  action and the read-only release preflight. It extracts but does not execute it.
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
- a build-provenance attestation on every asset, verified against the expected
  release workflow, selected tag and its peeled commit SHA, rejecting self-hosted
  builds; the tag identity depends on the producer's tag-protection rules;
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

The `depsound-version` default names the CLI version this Action downloads.
Evidence export needs `v0.36.0` or later. Default changes can be prepared before
the CLI release, but the Action must not be released until that CLI version is
published and verified. The maintainer command must check this before tagging;
the tag workflow repeats it with a read-only token.

## Making a change

`.github/workflows/ci.yml` runs the Node tests and YAML/shell validation with
`contents: read`. Run the same checks locally and say what was exercised:

1. Read the security model in the README and the two "may and may not"
   lists above before touching `action.yml` or `post/action.yml`. State in
   the PR which rule you touched and why it still holds.
2. Run `node --check post/post.cjs`, `node --test post/post.test.cjs`, and
   `ruby .github/scripts/validate-action.rb action.yml post/action.yml`.
   Also run `bash -n .github/scripts/download-depsound.sh`. The YAML validator
   checks inline shell blocks; the shared verifier is a separate program.
3. Download/verification changes need a transport fixture that covers published,
   draft, checksum, signer, source-SHA and supplied-digest paths. Failed integrity
   or provenance must stop before extraction. Test real assets only when
   authorised.
   Cover the no-change and failure paths too: incomplete analysis must still be
   reported and uploaded.
4. The poster: run the `github-script` body under Node with the `github`,
   `context` and `core` objects stubbed and the writes logged, against a
   report directory from step 3. Check the Bot-author rule, the marker
   splice, the reproduce command for one ref and for several.
5. A live end-to-end run needs explicit authorisation. Use a controlled
   repository and the proposed branch SHA, then read the comment as a reviewer.
   The pinned dogfood workflow does not exercise an unreleased change.
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
- Keep automation helpers, configuration and version metadata under `.github/`.
  `action.yml` stays at the root for Marketplace, alongside the public docs
  and changelog. Never delete files to tidy; move them to `_archive/`.

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

The Action's own version lives in `.github/version.txt`, independently of its
`depsound-version` download input. Release Please updates that file,
`CHANGELOG.md` and `.github/release-please-manifest.json` in one preparation PR.
Its workflow can write branches, PRs and labels, and uses `actions: write` to
dispatch read-only CI on the exact candidate SHA. It does not create tags or
GitHub releases. The configured publisher runs only on version-tag pushes.

The maintainer command must verify the candidate, its exact-head CI and the
repository's tag/environment/immutability settings. It must recheck the base and
head, merge with a head-SHA lease, require the resulting tree to match the
candidate, and create the version tag at that merge commit using the
maintainer's credential. Tag authority follows that account, not tagger email.

Before merging an Action candidate, the maintainer command must verify all six
CLI assets against the protected Go tag and source-bound build attestations.
The published `depsound-sha256` default must stay empty because archives vary
by platform. Workflow callers can still supply a platform-specific checksum.

`.github/workflows/release.yml` checks that the tag, source version and tracking
version agree, then verifies the CLI download default in its read-only job.
The publisher runs in the tag-restricted `release` environment and consumes
only this run attempt's notes. It creates its own
draft, retains the release ID, and publishes that object last. Existing releases
or drafts for the tag stop the run. This source-only Action attaches no assets;
the published release must be immutable, with the expected tag and empty asset
inventory. Consumers pin its commit SHA; there is no moving major alias.

All tags need creation/update/deletion protection. Ruleset bypass must be
`RepositoryRole: admin` (currently rvagg only), never Write/Maintain roles,
GitHub Actions, other apps or deploy keys. Adding an administrator changes who
can release. Immutable releases and the tag-only environment must be enabled
before tagging; the workflow's actor check is additional protection.
A write-capable collaborator can still edit or publish drafts before they
become immutable. Tag rules and published immutability do not close that race.

After verified publication, the maintainer command must relabel the selected
merged candidate from `autorelease: pending` to `autorelease: tagged`, allowing
the next candidate. Recovery requires a full workflow rerun for fresh attempt-specific
artifacts. The maintainer must inspect a partial draft before removing it and
retrying. Published immutable tags are not moved or reused.

CLI download updates and consumer re-pins are ordinary reviewed changes.
Land the CLI download default and README update on master before freezing the
Action candidate. Release Please then refreshes its head/base; its PR changes
only the version file, manifest and changelog.
Combined releases must select and show both prepared versions and head/base
SHAs upfront. The Action candidate must already contain the selected Go
download version. Verify Go publication before merging and releasing the same
Action candidate, then re-pin references. CI reruns must check that frozen
head; drift must stop the flow. Standalone Action and explicit depsound-only
releases remain supported. The helper must not calculate another version.

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
