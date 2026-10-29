#!/usr/bin/env bash
set -euo pipefail
runtime_dir=${1:?job-owned runtime directory required}
case "$runtime_dir" in /*) ;; *) exit 2 ;; esac
[[ $(uname -s) == Darwin && $(uname -m) == arm64 ]]
mkdir -m 700 "$runtime_dir"
archive="$runtime_dir/node.tar.gz"
curl --fail --location --silent --show-error --output "$archive" 'https://nodejs.org/dist/v24.22.0/node-v24.22.0-darwin-arm64.tar.gz'
printf '%s  %s\n' '6a9724d9b50a5f22b4816cded441b5a8d9ddae546191a5e5b7efa5a5e2ee26d5' "$archive" | shasum --algorithm 256 --check --status
tar --extract --gzip --file "$archive" --directory "$runtime_dir" --strip-components=1 --no-same-owner
[[ $("$runtime_dir/bin/node" -p 'process.versions.node') == 24.22.0 ]]
"$runtime_dir/bin/node" -e 'const fs = require("node:fs"), assert = require("node:assert/strict"), info = fs.statSync(process.execPath); assert.equal(info.uid, process.getuid()); assert.equal(info.mode & 0o022, 0);'
"$runtime_dir/bin/node" -p 'JSON.stringify({node:process.versions.node,execPath:process.execPath,scope:"owned product CI job"})'
printf 'directory=%s\n' "$runtime_dir" >> "${GITHUB_OUTPUT:?CI step output required}"
