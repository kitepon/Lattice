#!/usr/bin/env bash
#
# Assemble the npm thin-installer packages from built bundles (esbuild pattern).
#
# Produces, under release/npm/:
#   lattice-sensor-<target>/   one per built bundle — the vendored Node + app, tagged
#                         with os/cpu so npm installs only the matching one.
#   main/                 the @kitepon/Lattice shim package: a tiny bin
#                         that execs the matching platform bundle, with every
#                         platform package in optionalDependencies.
#
# The release pipeline then `npm publish`es each dir. This does NOT touch the
# repo's package.json — the dev/from-source path keeps working; the *published*
# main package's shape is generated here.
#
# Prereq: run build-bundle.sh for each target first (release/lattice-sensor-*.tar.gz).
# Usage:  scripts/pack-npm.sh [version]    (default: version from package.json)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="${1:-$(node -p "require('$ROOT/package.json').version")}"
SCOPE="@colbymchenry"
REL="$ROOT/release"
NPM="$REL/npm"

rm -rf "$NPM"
mkdir -p "$NPM/main"

shopt -s nullglob
archives=("$REL"/lattice-sensor-*.tar.gz "$REL"/lattice-sensor-*.zip)
[ ${#archives[@]} -gt 0 ] || { echo "[pack-npm] no bundles in $REL — run build-bundle.sh first" >&2; exit 1; }

targets=()
for archive in "${archives[@]}"; do
  fname="$(basename "$archive")"
  case "$fname" in
    *.tar.gz) base="${fname%.tar.gz}" ;;   # lattice-sensor-<target>
    *.zip)    base="${fname%.zip}" ;;
  esac
  target="${base#lattice-sensor-}"             # <target>, e.g. darwin-arm64 / win32-x64
  os="${target%-*}"                       # darwin | linux | win32
  arch="${target##*-}"                    # arm64 | x64
  pkgdir="$NPM/$base"
  mkdir -p "$pkgdir"
  case "$fname" in
    *.zip)
      tmpx="$(mktemp -d)"
      unzip -q "$archive" -d "$tmpx"
      mv "$tmpx/lattice-sensor-${target}"/* "$pkgdir"/
      rm -rf "$tmpx"
      nodefile="node.exe"
      ;;
    *)
      tar -xzf "$archive" -C "$pkgdir" --strip-components=1
      nodefile="node"
      ;;
  esac
  # The browser viewer must survive the archive round-trip too: a tar/zip that
  # dropped dist/viewer would publish a platform package whose `lattice sensor ui`
  # serves a 404.
  node "$ROOT/scripts/check-ui-build.mjs" --root "$pkgdir/lib"
  VERSION="$VERSION" SCOPE="$SCOPE" TARGET="$target" OSV="$os" ARCHV="$arch" NODEFILE="$nodefile" \
    node -e '
      const fs=require("fs");
      fs.writeFileSync(process.argv[1], JSON.stringify({
        name: `${process.env.SCOPE}/lattice-sensor-${process.env.TARGET}`,
        version: process.env.VERSION,
        description: `Lattice sensor self-contained bundle for ${process.env.TARGET}`,
        os: [process.env.OSV], cpu: [process.env.ARCHV],
        files: [process.env.NODEFILE, "lib", "bin"],
        license: "MIT",
        // npm --provenance refuses to publish unless this matches the repo
        // the release workflow runs in.
        repository: { type: "git", url: "git+https://github.com/kitepon/Lattice.git" }
      }, null, 2) + "\n");
    ' "$pkgdir/package.json"
  targets+=("$target")
  echo "[pack-npm] ${SCOPE}/lattice-sensor-${target}@${VERSION}"
done

# Main shim package.
#   npm-shim.js  CLI/MCP launcher (execs the bundled Node) — the `bin`.
#   npm-sdk.js   programmatic/embedded entry (#354): re-exports the installed
#                platform bundle's compiled library — the `main`.
#   dist/        the .d.ts tree only (types). The runtime .js stays in the
#                per-platform bundle so its deps aren't duplicated here.
cp "$ROOT/scripts/npm-shim.js" "$NPM/main/npm-shim.js"
cp "$ROOT/scripts/npm-sdk.js" "$NPM/main/npm-sdk.js"
[ -f "$ROOT/README.md" ] && cp "$ROOT/README.md" "$NPM/main/README.md"

# Ship the type declarations so `types`/`exports.types` resolve. Built from this
# same release, so they can't skew from the runtime npm-sdk.js re-exports.
[ -f "$ROOT/dist/index.d.ts" ] || ( echo "[pack-npm] building dist for .d.ts" >&2 && cd "$ROOT" && npm run build >/dev/null )
ROOT="$ROOT" DEST="$NPM/main" node -e '
  const fs=require("fs"), path=require("path");
  const src=path.join(process.env.ROOT,"dist"), dest=path.join(process.env.DEST,"dist");
  fs.cpSync(src, dest, { recursive:true, filter(s){
    try { return fs.statSync(s).isDirectory() || s.endsWith(".d.ts"); } catch (e) { return false; }
  }});
'

VERSION="$VERSION" SCOPE="$SCOPE" TARGETS="${targets[*]}" \
  node -e '
    const fs=require("fs");
    const opt={};
    for (const t of process.env.TARGETS.split(/\s+/).filter(Boolean))
      opt[`${process.env.SCOPE}/lattice-sensor-${t}`]=process.env.VERSION;
    fs.writeFileSync(process.argv[1], JSON.stringify({
      name: `${process.env.SCOPE}/lattice-sensor`,
      version: process.env.VERSION,
      description: "Local-first code intelligence for AI agents (MCP). Self-contained — bundles its own runtime.",
      bin: { lattice-sensor: "npm-shim.js" },
      main: "npm-sdk.js",
      types: "dist/index.d.ts",
      exports: {
        ".": { types: "./dist/index.d.ts", default: "./npm-sdk.js" },
        "./package.json": "./package.json"
      },
      optionalDependencies: opt,
      files: ["npm-shim.js","npm-sdk.js","dist","README.md"],
      license: "MIT",
      repository: { type: "git", url: "git+https://github.com/kitepon/Lattice.git" }
    }, null, 2) + "\n");
  ' "$NPM/main/package.json"

echo "[pack-npm] ${SCOPE}/lattice-sensor@${VERSION} (${#targets[@]} platform packages in optionalDependencies)"
echo "[pack-npm] output: $NPM"

# ---------------------------------------------------------------------------
# @kitepon/Lattice-ui — the viewer's components as a Svelte library.
#
# Staged into release/npm-ui/, NOT release/npm/: the workflow publishes
# `release/npm/lattice-sensor-*` by glob, and a directory named lattice-sensor-ui in
# there would be swept into that loop the moment it existed.
#
# OFF by default. The package is prepared, versioned with the engine and
# tested (CG-61), but publishing it is a decision the maintainer has not
# made — and `ui/package.json` still carries `"private": true`, which is what
# actually stops an accidental `npm publish`. Set LATTICE_SENSOR_PACK_UI=1 to build
# the tarball; publishing it additionally means removing that flag.
# ---------------------------------------------------------------------------
if [ "${LATTICE_SENSOR_PACK_UI:-0}" = "1" ]; then
  UIREL="$REL/npm-ui"
  rm -rf "$UIREL"
  mkdir -p "$UIREL"
  ( cd "$ROOT" && npm run build:lib --workspace ui )
  # `npm pack` honours "files" and works on a private package; `npm publish`
  # does not, which is exactly the guard we want to keep for now.
  ( cd "$ROOT/ui" && npm pack --pack-destination "$UIREL" >/dev/null )
  echo "[pack-npm] ${SCOPE}/lattice-sensor-ui@${VERSION} packed (not published) -> $UIREL"
else
  echo "[pack-npm] skipping ${SCOPE}/lattice-sensor-ui (set LATTICE_SENSOR_PACK_UI=1 to pack it)"
fi
