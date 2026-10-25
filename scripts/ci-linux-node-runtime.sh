#!/usr/bin/env bash
set -euo pipefail
runtime_dir=${1:?job-owned runtime directory required}
case "$runtime_dir" in /*) ;; *) exit 2 ;; esac
mkdir -m 700 "$runtime_dir"
archive="$runtime_dir/node.tar.xz"
curl --fail --location --silent --show-error --output "$archive" 'https://nodejs.org/dist/v24.22.0/node-v24.22.0-linux-x64.tar.xz'
printf '%s  %s\n' 'cc2f601cee82d9a5a233302fe307abc600727035fd7d2c3a3571755989e95008' "$archive" | sha256sum --check --status
tar --extract --xz --file "$archive" --directory "$runtime_dir" --strip-components=1 --no-same-owner
[[ $("$runtime_dir/bin/node" -p 'process.versions.node') == 24.22.0 ]]
"$runtime_dir/bin/node" -p 'JSON.stringify({node:process.versions.node,execPath:process.execPath,scope:"owned product CI job"})'
printf 'directory=%s\n' "$runtime_dir" >> "${GITHUB_OUTPUT:?CI step output required}"
