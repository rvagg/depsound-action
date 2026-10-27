#!/usr/bin/env bash
set -euo pipefail
os=$(uname -s | tr '[:upper:]' '[:lower:]')
arch=$(uname -m)
case "$arch" in x86_64) arch=amd64 ;; aarch64|arm64) arch=arm64 ;; esac
ver="${VERSION#v}"
case "$os" in
  linux)  asset="depsound_${ver}_linux_${arch}.tar.gz" ;;
  darwin) asset="depsound_${ver}_darwin_all.zip" ;;
  *) echo "::error::unsupported runner OS: $os" ; exit 1 ;;
esac
dir="$RUNNER_TEMP/depsound-bin"
mkdir -p "$dir"
if ! release=$(gh release view "$VERSION" --repo rvagg/depsound --json isDraft,tagName); then
  echo "::error::cannot read the published depsound release $VERSION."
  exit 1
fi
if ! jq -e --arg tag "$VERSION" '.isDraft == false and .tagName == $tag' <<<"$release" >/dev/null; then
  echo "::error::depsound $VERSION is not a published release."
  exit 1
fi
gh release download "$VERSION" --repo rvagg/depsound --dir "$dir" \
  --pattern "$asset" --pattern checksums.txt --clobber
# verify against the release's own checksums: a corrupt-download check,
# not an independent anchor against a compromised release
( cd "$dir"
  if command -v sha256sum >/dev/null; then verify="sha256sum -c -"; else verify="shasum -a 256 -c -"; fi
  grep " ${asset}\$" checksums.txt | $verify )
# A supplied digest pins exact bytes; otherwise require the tag's build.
if [ -n "$EXPECT_SHA256" ]; then
  if command -v sha256sum >/dev/null; then verify="sha256sum -c -"; else verify="shasum -a 256 -c -"; fi
  echo "$EXPECT_SHA256  $dir/$asset" | $verify
else
  object=$(gh api "repos/rvagg/depsound/git/ref/tags/$VERSION" --jq .object)
  for ((i = 0; i < 16; i++)); do
    kind=$(jq -r .type <<<"$object")
    source_sha=$(jq -r .sha <<<"$object")
    [[ "$kind" == tag ]] || break
    [[ "$source_sha" =~ ^[0-9a-f]{40}$ ]]
    object=$(gh api "repos/rvagg/depsound/git/tags/$source_sha" --jq .object)
  done
  [[ "$kind" == commit && "$source_sha" =~ ^[0-9a-f]{40}$ ]]
  if ! gh attestation verify "$dir/$asset" --repo rvagg/depsound \
    --signer-workflow rvagg/depsound/.github/workflows/release-binaries.yml \
    --source-ref "refs/tags/$VERSION" --source-digest "$source_sha" \
    --signer-digest "$source_sha" --deny-self-hosted-runners; then
    echo "::error::build-provenance verification failed for $asset ($VERSION)." \
      "For releases without attestations, supply depsound-sha256; otherwise treat the asset as suspect."
    exit 1
  fi
fi
( cd "$dir" && case "$asset" in *.zip) unzip -oq "$asset" ;; *) tar xzf "$asset" ;; esac )
echo "$dir" >> "$GITHUB_PATH"
