#!/usr/bin/env bash
# macOS product-CI Node at a fixed, runner-owned path (RUNNER_TOOL_CACHE/lattice-node/v<version>):
# ESET on the Mac runner allows inbound LAN connections per executable path, so a per-run
# temporary Node would need a new allow rule every run. An existing directory is reused only
# after the same version / uid / mode assertions a fresh extraction must pass; otherwise it is
# rebuilt in a staging directory and moved into place in one rename.
set -euo pipefail
runtime_dir=${1:?runner-owned runtime directory required}
case "$runtime_dir" in /*) ;; *) exit 2 ;; esac
[[ $(uname -s) == Darwin && $(uname -m) == arm64 ]]
version=24.22.0
sha256=6a9724d9b50a5f22b4816cded441b5a8d9ddae546191a5e5b7efa5a5e2ee26d5

verify() {
  [[ $("$1/bin/node" -p 'process.versions.node') == "$version" ]]
  "$1/bin/node" -e 'const fs = require("node:fs"), assert = require("node:assert/strict"), info = fs.statSync(process.execPath); assert.equal(info.uid, process.getuid()); assert.equal(info.mode & 0o022, 0);'
}

if [[ -d $runtime_dir ]] && ! verify "$runtime_dir" 2>/dev/null; then
  echo "existing runtime at $runtime_dir failed verification; rebuilding" >&2
  rm -rf "$runtime_dir"
fi
if [[ ! -d $runtime_dir ]]; then
  mkdir -p -m 700 "$(dirname "$runtime_dir")"
  staging="$runtime_dir.staging.$$"
  rm -rf "$staging"
  mkdir -m 700 "$staging"
  trap 'rm -rf "$staging"' EXIT
  archive="$staging/node.tar.gz"
  curl --fail --location --silent --show-error --output "$archive" "https://nodejs.org/dist/v$version/node-v$version-darwin-arm64.tar.gz"
  printf '%s  %s\n' "$sha256" "$archive" | shasum --algorithm 256 --check --status
  tar --extract --gzip --file "$archive" --directory "$staging" --strip-components=1 --no-same-owner
  rm "$archive"
  verify "$staging"
  mv "$staging" "$runtime_dir"
  trap - EXIT
fi
verify "$runtime_dir"
"$runtime_dir/bin/node" -p 'JSON.stringify({node:process.versions.node,execPath:process.execPath,scope:"owned product CI job"})'
printf 'directory=%s\n' "$runtime_dir" >> "${GITHUB_OUTPUT:?CI step output required}"
