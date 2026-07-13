# depsound-action

A GitHub Action that runs [depsound](https://github.com/rvagg/depsound) on
dependency-update pull requests and reports what it found, so a human or an
agent can review straight from the PR without installing anything.

Like depsound itself, this is **evidence, not a verdict**. It surfaces facts and
routes the next step; it never claims a change is "safe".

## What it does

On a Dependabot dependency-update PR it:

- resolves the changed dependencies and runs depsound over them;
- upserts a single **sticky comment** (one per PR, edited in place across
  rebases) with a plain-language headline and the signals worth weighing;
- uploads the full depsound report as a workflow **artifact** for anyone, or any
  agent, who wants the detail;
- sets a **neutral check** (never success/failure). The check is the gate, the
  comment is the voice.

Because depsound fetches the *published* artifact and its output is reproducible
from public registry data, there is nothing to host: the report lives in the PR
and the workspace regenerates on demand.

## How it fits together

depsound owns the wording: the human-facing comment body is rendered by depsound,
not by this action. The action is thin plumbing, download the pinned depsound
binary, run it, post the result, which keeps the review logic in one place and
this action small. What it posts are dimensional facts and a neutral check,
never a grade and never "safe".

## Usage

Because Dependabot and fork PRs get a read-only token with no secrets, review
splits into two workflows: a **compute** job on `pull_request` (read-only,
uploads the report as an artifact) and a **post** job on `workflow_run` (holds
the write token, downloads the artifact, upserts the sticky comment, sets the
neutral check). Copy both from [`examples/`](examples/) into your
`.github/workflows/`:

- [`examples/depsound.yml`](examples/depsound.yml) — compute
- [`examples/depsound-post.yml`](examples/depsound-post.yml) — post

The compute job derives the changed dependencies from Dependabot's metadata and
hands them to this action; adapt its "Build dependency list" step if you drive
updates another way.

## Inputs

| Input | Purpose |
|---|---|
| `deps` | newline `<eco>:<name> <from> <to>` list to review (the compute workflow builds this) |
| `depsound-version` | the depsound release to download and checksum-verify (default `v0.23.2`) |
| `cooldown` | days, forwarded to depsound `--cooldown` to match an install cooldown |
| `github-token` | token to download the release (defaults to the job token) |

Outputs: `markdown` (the comment body), `title` (the check title), `tripped`.

## Pinning

Pin every action to a full commit SHA, not a moving tag. A tag is a mutable
pointer an attacker can re-point (the tj-actions vector); a SHA is immutable.
This is depsound's own advice, so this repo and its examples follow it, and
Dependabot keeps the SHAs (and their `# vX.Y.Z` comments) current.

## Security

The action downloads a pinned depsound release and verifies it against the
release's own checksums, which catches a corrupted download though it is not an
independent anchor against a compromised release. It never checks out or runs
the PR's code: depsound analyzes the *published* artifact, not the branch. The
post workflow only downloads the report artifact (data) and posts it, which is
what keeps its write token safe.

## License

Apache-2.0. Copyright 2026 Rod Vagg. See [LICENSE](LICENSE).
