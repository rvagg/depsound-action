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

## Usage

Review is two workflows, and this action is two matching pieces, so each
workflow is a single `uses:`. Copy both from [`examples/`](examples/) into your
`.github/workflows/`:

- [`examples/depsound.yml`](examples/depsound.yml) — `uses: rvagg/depsound-action`
- [`examples/depsound-post.yml`](examples/depsound-post.yml) — `uses: rvagg/depsound-action/post`

The compute action reads Dependabot's metadata itself, so for the common case
there is nothing to configure; pin the two `uses:` to a SHA (see Pinning) and
you are done. To drive it from something other than Dependabot, pass a `deps`
override (see Inputs).

### Why two workflows

Dependabot and fork PRs run with a **read-only** `GITHUB_TOKEN` and no access to
secrets, so a job on `pull_request` cannot post a comment or set a check on
those PRs, exactly the PRs that most need reviewing. The fix is to split the
work by the token each half needs:

- **compute** runs on `pull_request` with read-only permissions. It works out
  the changed dependencies, runs depsound, and uploads the report as an
  artifact. It never posts, so it never needs write access, and it is safe to
  run on untrusted PR code (it does not run that code anyway; depsound analyzes
  the *published* artifact, not the branch).
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
| `deps` | override: newline `<eco>:<name> <from> <to>` list to review; when empty it is derived from the PR's Dependabot metadata |
| `depsound-version` | the depsound release to download and checksum-verify (default `v0.23.3`) |
| `cooldown` | days, forwarded to depsound `--cooldown` to match an install cooldown |
| `github-token` | token to read PR metadata and download the release (defaults to the job token) |

Outputs: `markdown` (the comment body), `title` (the check title), `tripped`.

The post action ([`rvagg/depsound-action/post`](post/action.yml)) takes only an
optional `github-token` (defaults to the job token).

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
post action only downloads the report artifact (data) and posts it, which is
what keeps its write token safe.

## License

Apache-2.0. Copyright 2026 Rod Vagg. See [LICENSE](LICENSE).
