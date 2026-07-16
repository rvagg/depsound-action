# depsound-action

A GitHub Action that runs [depsound](https://github.com/rvagg/depsound) on pull
requests that change a dependency and reports what it found, so a human or an
agent can review straight from the PR without installing anything.

Like depsound itself, this is **evidence, not a verdict**. It surfaces facts and
routes the next step; it never claims a change is "safe".

## What it does

On any PR that touches a dependency manifest (Dependabot's, a teammate's, or a
newcomer's) it:

- diffs the changed manifests to work out what actually moved, a version bump, a
  newly-added dependency, or a `replace`/redirect off the registry, and runs
  depsound over them;
- upserts a single **sticky comment** (one per PR, edited in place across
  rebases) with a plain-language headline and the signals worth weighing;
- uploads the full depsound report as a workflow **artifact** for anyone, or any
  agent, who wants the detail;
- sets a **neutral check** (never success/failure) that branch protection can
  require. The check and the comment are written independently (one failing
  never suppresses the other), and both upsert on the PR head so reruns do not
  pile up.

If the analysis itself fails, the action still posts an **"analysis incomplete"**
comment rather than going silent, since silence on a broken run would read as a
clean approval.

Because depsound fetches the *published* artifact and its output is reproducible
from public registry data, there is nothing to host: the report lives in the PR
and the workspace regenerates on demand.

## Usage

Review is two workflows, and this action is two matching pieces, so each
workflow is a single `uses:`. Copy both from [`examples/`](examples/) into your
`.github/workflows/`:

- [`examples/depsound.yml`](examples/depsound.yml) — `uses: rvagg/depsound-action`
- [`examples/depsound-post.yml`](examples/depsound-post.yml) — `uses: rvagg/depsound-action/post`

The compute action diffs the PR's dependency manifests itself, so a change to a
watched manifest is reviewed no matter who opened the PR (not just Dependabot),
and for the common case there is nothing to configure; pin the two `uses:` to a
SHA (see Pinning) and you are done. Point it at non-standard manifest locations
with `manifests`, or bypass detection entirely with an explicit `deps` list (see
Inputs).

### Why two workflows

Dependabot and fork PRs run with a **read-only** `GITHUB_TOKEN` and no access to
secrets, so a job on `pull_request` cannot post a comment or set a check on
those PRs, exactly the PRs that most need reviewing. The fix is to split the
work by the token each half needs:

- **compute** runs on `pull_request` with read-only permissions. It checks out
  the PR to diff its manifests, runs depsound, and uploads the report as an
  artifact. It never posts, so it never needs write access. Checking out
  untrusted PR code is safe here because it only *reads* the manifest text
  (never runs the code), and depsound then fetches and analyzes the *published*
  artifacts those manifests name, not the branch's contents.
- **post** runs on `workflow_run`, which fires after compute finishes and runs
  in the base repo's context with the **write** token. It only downloads the
  report artifact (data) and posts it; it never checks out or runs any PR code.

That separation is what keeps a write token away from untrusted code while still
letting the comment land on Dependabot and fork PRs. It is the standard, safe
`workflow_run` pattern, not a workaround.

## Inputs

The compute action ([`rvagg/depsound-action`](action.yml)):

| Input | Purpose |
|---|---|
| `manifests` | newline list of manifest/lockfile **base names** to watch on a PR, matched at any path (default: `go.mod`, `package-lock.json`, `pnpm-lock.yaml`, `Cargo.lock`). A committed lockfile is watched in preference to its declaration file (`package.json`, `Cargo.toml`) because it pins exact + transitive versions. See [Current limitations](#current-limitations) for repos with no lockfile |
| `deps` | override: a newline depsound list (`<eco>:<name> <from> <to>` bump, `<eco>:<name> <version>` new dep, or `redirect <eco>:<name> <target>`); when set, PR detection is skipped |
| `depsound-version` | the depsound release to download and checksum-verify (default `v0.24.0`) |
| `cooldown` | days, forwarded to depsound `--cooldown` to match an install cooldown |
| `github-token` | token to checkout the PR and download the release (defaults to the job token) |

Outputs: `markdown` (the comment body), `title` (the check title), `tripped`.

The post action ([`rvagg/depsound-action/post`](post/action.yml)) takes only an
optional `github-token` (defaults to the job token).

## Pinning

Pin every action to a full commit SHA, not a moving tag. A tag is a mutable
pointer an attacker can re-point (the tj-actions vector); a SHA is immutable.
This is depsound's own advice, so this repo and its examples follow it, and
Dependabot keeps the SHAs (and their `# vX.Y.Z` comments) current.

## Current limitations

Detection reads a PR's authoritative resolution files, so it inherits their
boundaries:

- **No committed lockfile.** A repo that does not commit a lockfile (common for
  npm and crates *libraries*) carries its dependency changes only in the
  declaration file (`package.json`, `Cargo.toml`), which detection does not yet
  read, so those changes are currently missed. Go is unaffected (`go.mod` is
  always both declaration and resolution). A labelled declaration-file fallback
  is planned.
- **Redirects.** A `replace`/`patch`/override pointing a dependency off the
  registry is flagged for **Go** today; npm/pnpm/crates redirect detection is a
  follow-on.

What depsound itself does not assess (reachability, runtime behaviour, your
tests, transitive depth, publish provenance) is stated on every report.

## Security

The action downloads a pinned depsound release and verifies it against the
release's own checksums, which catches a corrupted download though it is not an
independent anchor against a compromised release. The compute half checks out
the PR to diff its manifests, but only *reads* the manifest text (attacker-
controlled data, parsed for names and versions); it never runs the PR's code,
and depsound analyzes the *published* artifacts those manifests name, not the
branch. It runs with a read-only token and never posts. The post half holds the
write token but only downloads the report artifact (data) and posts it, never
touching PR code, which is what keeps that token safe. It only edits a sticky
comment authored by its own bot identity, so a PR author cannot plant the
comment marker and have the trusted workflow overwrite their comment.

## License

Apache-2.0. Copyright 2026 Rod Vagg. See [LICENSE](LICENSE).
