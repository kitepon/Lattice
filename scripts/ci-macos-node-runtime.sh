#!/usr/bin/env bash
# macOS product-CI Node in non-overwriting generations under <base>/lattice-node[.N]/v<version>-<sha16>/gN.
# ESET on the Mac runner allows inbound LAN per executable path and its chooser cannot reach the 0700
# runner home, so the tree lives under /Users/Shared (1777 sticky). No exclusive cache or prior-consumer
# exit handoff exists, so a tree another job may run is never replaced, renamed over or deleted:
# a generation is reserved with mkdir (exclusive create), built in place, and published by a marker.
# Contract: docs/architecture/dfd-ci-macos-runtime.md.
set -euo pipefail
umask 022
base=${1:?runtime base directory required}
case "$base" in /*) ;; *) exit 2 ;; esac
[[ $(uname -s) == Darwin && $(uname -m) == arm64 ]]
version=24.22.0
sha256=6a9724d9b50a5f22b4816cded441b5a8d9ddae546191a5e5b7efa5a5e2ee26d5
identity="v$version-${sha256:0:16}"
uid=$(id -u)
marker_line="version=$version sha256=$sha256 uid=$uid"

# Called under `!`/`if`, where errexit is off: every check must return on its own.
verify() {
  [[ $("$1/bin/node" -p 'process.versions.node' 2>/dev/null) == "$version" ]] || return 1
  "$1/bin/node" -e 'const fs = require("node:fs"), assert = require("node:assert/strict"), info = fs.statSync(process.execPath); assert.equal(info.uid, process.getuid()); assert.equal(info.mode & 0o022, 0);'
}

# A root is used only if it is a real directory owned by this UID with no group/other write.
safe_root() {
  [[ -d $1 && ! -L $1 ]] || return 1
  [[ $(stat -f %u "$1") == "$uid" ]] || return 1
  (( (8#$(stat -f %Lp "$1") & 8#022) == 0 ))
}

# Numeric suffixes of existing "<prefix><N>" entries, ascending.
suffixes() {
  local entry
  for entry in "$1"*; do
    [[ -e $entry || -L $entry ]] || continue
    entry=${entry#"$1"}
    [[ $entry =~ ^[0-9]+$ ]] && printf '%s\n' "$entry"
  done | sort -n
}

# Unsafe (squatted) root names are skipped and never modified.
root=
for n in 1 $(suffixes "$base/lattice-node."); do
  name="$base/lattice-node"; [[ $n == 1 ]] || name+=".$n"
  if safe_root "$name"; then root=$name; break; fi
done
if [[ -z $root ]]; then
  n=$(suffixes "$base/lattice-node." | tail -n 1); n=$(( ${n:-1} + 1 ))
  [[ -e $base/lattice-node || -L $base/lattice-node ]] || n=1
  for (( ; ; n++ )); do
    name="$base/lattice-node"; [[ $n == 1 ]] || name+=".$n"
    if mkdir -m 755 "$name" 2>/dev/null || safe_root "$name"; then root=$name; break; fi
    [[ -e $name || -L $name ]] || { echo "cannot create runtime root $name" >&2; exit 1; }
  done
fi

identity_dir="$root/$identity"
mkdir -m 755 "$identity_dir" 2>/dev/null || [[ -d $identity_dir && ! -L $identity_dir ]]

selected=
for n in $(suffixes "$identity_dir/g"); do
  candidate="$identity_dir/g$n"
  [[ -f $candidate/.lattice-complete && $(<"$candidate/.lattice-complete") == "$marker_line" ]] || continue
  if verify "$candidate" 2>/dev/null; then selected=$candidate; break; fi
  echo "complete generation $candidate failed verification; left untouched" >&2
done

if [[ -z $selected ]]; then
  n=$(suffixes "$identity_dir/g" | tail -n 1); n=$(( ${n:-0} + 1 ))
  until mkdir -m 755 "$identity_dir/g$n" 2>/dev/null; do
    [[ -e $identity_dir/g$n ]] || { echo "cannot reserve $identity_dir/g$n" >&2; exit 1; }
    n=$(( n + 1 ))
  done
  generation="$identity_dir/g$n"
  echo "reserved $generation" >&2
  # Only this process's own unpublished generation is removed; nothing else ever is.
  trap 'rm -rf "$generation"' EXIT
  archive="$generation/node.tar.gz"
  curl --fail --location --silent --show-error --output "$archive" "https://nodejs.org/dist/v$version/node-v$version-darwin-arm64.tar.gz"
  printf '%s  %s\n' "$sha256" "$archive" | shasum --algorithm 256 --check --status
  tar --extract --gzip --file "$archive" --directory "$generation" --strip-components=1 --no-same-owner
  rm "$archive"
  verify "$generation"
  printf '%s\n' "$marker_line" > "$generation/.lattice-complete.tmp"
  mv -f "$generation/.lattice-complete.tmp" "$generation/.lattice-complete"
  trap - EXIT
  selected=$generation
fi

verify "$selected"
"$selected/bin/node" -e '
  const fs = require("node:fs");
  const info = fs.statSync(process.execPath);
  console.log(JSON.stringify({ node: process.versions.node, execPath: process.execPath,
    identity: process.argv[1], generation: process.argv[2], sha256: process.argv[3],
    uid: info.uid, mode: (info.mode & 0o7777).toString(8), scope: "owned product CI job" }));
' "$identity" "$(basename "$selected")" "$sha256"
printf 'directory=%s\n' "$selected" >> "${GITHUB_OUTPUT:?CI step output required}"
