# depsound-action

A GitHub Action that runs [depsound](https://github.com/rvagg/depsound) on pull
requests that change a dependency and reports what it found, so a human or an
agent can review from the PR without installing the CLI locally.

It presents evidence and points reviewers to the next investigation. Reviewers
decide whether a change is safe.

## What it does

On any PR that touches a dependency manifest (Dependabot's, a teammate's, or a
newcomer's) it:

- diffs the changed manifests to work out what actually moved, a version bump, a
  newly-added dependency, or a `replace`/redirect off the registry, and runs
  depsound over them. **github-actions** `uses:` bumps in workflow files count
  too, read straight from the pinned refs in the diff (any PR author, not just
  Dependabot);
- upserts a single **sticky comment** (one per PR, edited in place across
  rebases) with a plain-language headline and the signals worth weighing;
- uploads the report and bounded review evidence as a workflow **artifact**:
  available package archives, integrity metadata, diffs and inert file copies;
- sets a **neutral check** (never success/failure) that branch protection can
  require. The check and the comment are written independently (one failing
  never suppresses the other), and both upsert on the PR head so reruns do not
  pile up.

If analysis cannot complete, the action posts an **"analysis incomplete"**
comment. A missing comment from a failed run could otherwise look like approval.

A no-change run creates or updates the sticky comment and neutral check, even on
PRs without dependency changes. Reverting a dependency edit therefore replaces
older flags. Missing or corrupt reports are incomplete runs, not no-change runs.

The PR summary, JSON and retained evidence all come from one analysis, so they
describe the same run. If a registry later removes a release, the workflow
artifact retains the bytes collected during review. `evidence/manifest.json`
maps retained files and records hashes, limits and omissions. Treat all package
contents as untrusted data, never executable instructions.

Comments are bounded; larger details stay in the artifact. When replay input is
available, the comment gives a version-pinned command and identifies findings
that need the retained evidence because replay cannot reproduce them. Without
replay input, it points directly to the saved evidence.
Known URL credentials are redacted from structured metadata; package bytes are not.

Artifacts follow the repository's GitHub Actions access and retention controls.
Private dependencies may put private code in the artifact; review who can read it.

## Usage

Review is one workflow with two jobs, each a single `uses:`. Copy
[`examples/depsound.yml`](examples/depsound.yml) into your
`.github/workflows/`:

- job `review`: `uses: rvagg/depsound-action` (computes, read-only token)
- job `post`: `uses: rvagg/depsound-action/post` (comments, write scopes)

The review job diffs the PR's dependency manifests itself, so a change to a
watched manifest is reviewed no matter who opened the PR (not just Dependabot).
For the common case, pin the two `uses:` entries to a SHA (see Pinning) and use
the workflow as shown. Point it at non-standard manifest locations with
`manifests`, or bypass detection entirely with an explicit `deps` list (see
Inputs).

Use the single-workflow `pull_request_target` layout in the example, including
its per-PR concurrency group. The legacy `workflow_run` split is not supported.
Before updating the shared comment, the poster checks the current PR head.

### How the `pull_request_target` workflow handles untrusted PRs

The workflow runs on `pull_request_target`, which means the **base branch's**
workflow definition and action pins execute, never the PR's copy: a PR cannot
edit the workflow, swap the action version, or forge the report the poster
publishes. Its token also carries the repo's write scopes, so the comment
lands on Dependabot and fork PRs, whose own `pull_request` token is read-only.

`pull_request_target` is dangerous when a workflow checks out and executes PR
code (install scripts, builds, tests) next to that token. This workflow never
does either:

- The **review** job checks out the trusted base, fetches the PR head only as
  git *objects*, and reads manifest bytes out of them with `git show`; nothing
  from the PR is checked out onto disk or executed. depsound then fetches and
  analyzes the *published* artifacts those manifests name, treating all of it
  as hostile data. The job's `permissions: contents: read` means even the
  token it holds is read-only.
- The **post** job holds the write scopes (`pull-requests`, `checks`) and only
  downloads the report artifact, produced by the trusted review job in the
  same run, and posts it.

The job split is the token discipline: the code that touches attacker-supplied
bytes never holds a write token.

## Inputs

The compute action ([`rvagg/depsound-action`](action.yml)):

| Input | Purpose |
|---|---|
| `manifests` | newline list of manifest/lockfile **base names** to watch on a PR, matched at any path (default: `go.mod`, the three lockfiles, and the declaration fallbacks `package.json`, `Cargo.toml`, `pnpm-workspace.yaml`). A changed lockfile is preferred over the declaration file beside it (exact + transitive). See [Current limitations](#current-limitations) |
| `deps` | override: a newline depsound list (`<eco>:<name> <from> <to>` bump, `<eco>:<name> <version>` new dep, or `redirect <eco>:<name> <target>`); when set, PR detection is skipped |
| `depsound-version` | the depsound release to download and verify (default `v0.37.0`; requires `v0.36.0` or later for evidence export) |
| `depsound-sha256` | optional caller-supplied sha256 for the platform asset; takes precedence over attestation verification and is required for a selected release without attestations |
| `cooldown` | days, forwarded to depsound `--cooldown` to match an install cooldown |
| `github-token` | token to checkout the PR and download the release (defaults to the job token) |

Outputs: `markdown` (the comment body), `title` (the check title), `tripped`.

The post action ([`rvagg/depsound-action/post`](post/action.yml)) takes only an
optional `github-token` (defaults to the job token).

## Pinning

Pin every action to a full commit SHA. A SHA remains immutable; a tag is a mutable pointer an attacker can re-point (the tj-actions vector). This repo and its examples follow that practice, and Dependabot keeps the SHAs (and their `# vX.Y.Z` comments) current.

## Staying current

The two files you copy contain a single `uses:` each, plus the triggers and minimal permissions. Review logic lives in this action, so new functionality arrives when you bump the pinned ref instead of editing your workflows. Enable Dependabot's `github-actions` updater and it bumps both `uses:` SHAs (and their `# vX.Y.Z` comments) as releases land:

```yaml
# .github/dependabot.yml
version: 2
updates:
  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: weekly
```

The one thing that can force a workflow edit is a new permission scope or
trigger, since those live in your copy, not the action. Changes of that kind are
gated behind a major version bump, a deliberate opt-in, so ordinary updates stay
a version bump with nothing to touch.

## Current limitations

Detection reads a PR's authoritative resolution files, so it inherits their
boundaries:

- **No committed lockfile.** A repo that does not commit a lockfile (common for
  npm and crates *libraries*) is detected from its declaration file
  (`package.json`, `Cargo.toml`) as a labelled fallback: versions there are
  ranges, so each endpoint is resolved to one satisfying version at review time
  (the report says so on the row), and the view is direct-deps-only, with no
  transitive resolution. A directory whose lockfile also changed uses the
  lockfile alone (exact + transitive). Go is unaffected (`go.mod` is always
  both declaration and resolution). pnpm **catalog** bumps (ranges centralized
  in `pnpm-workspace.yaml`) are detected the same way.
- **Retention is bounded.** Archives already unavailable at review time cannot
  be recovered by this Action. Large files or trees can also exceed export
  limits. Check `evidence/manifest.json` to see which bytes were retained.
  Stored `.crate` archives can be supplied to depsound's local-artifact flags
  when continuing an investigation after a takedown.
- **Redirects and mirrors.** Off-registry declarations remain review facts.
  depsound does not fetch replacement URLs. Lockfile acquisition metadata is
  supported by newer depsound releases; when it cannot collect a row's bytes,
  the report records that coverage gap.
- **github-actions.** Standard action `uses:` bumps in `.github/workflows/*.yml`
  and composite `action.yml`/`action.yaml` are detected from their pinned refs
  and fully analysed. depsound cannot fetch a changed or added `docker://`
  image or reusable-workflow call (`owner/repo/.github/workflows/x.yml`), so
  the report identifies it as a "could not be analysed" coverage gap. Local
  (`./`) uses are the repo's own code, reviewed in the PR diff itself.

Every report states the parts depsound did not assess: reachability, runtime
behaviour, your tests, and publish provenance when the lookup fails or does not
apply.

## Security

The action downloads a pinned depsound release, checks it against the
release's checksums (a corrupt-download check), then verifies its sigstore
build-provenance attestation against the expected release workflow and selected
tag, rejecting self-hosted builds. This establishes where the binary was built;
you must still decide whether its behaviour is acceptable. Overriding
`depsound-version` to a release that predates attestations requires
`depsound-sha256` as the caller's own anchor. The review job reads the PR's
manifest bytes as git objects (attacker-controlled data, parsed for names and
versions, never checked out or executed) with a read-only token; depsound
analyzes the *published* artifacts those manifests name, not the branch. The
post job holds the write scopes but only downloads the report artifact,
produced by the trusted review job in the same run, and posts it. It only edits
a Bot-authored comment with both the depsound title and sticky markers;
human-authored comments are not adopted. The full model is under Usage above.

## License

Apache-2.0. Copyright 2026 Rod Vagg. See [LICENSE](LICENSE).
