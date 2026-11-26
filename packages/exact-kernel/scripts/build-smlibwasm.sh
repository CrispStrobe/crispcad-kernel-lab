#!/bin/sh
# SPDX-License-Identifier: MIT
# Copyright (c) 2026 CrispCAD contributors
#
# Builds @classcad/smlibwasm 0.6.2 from source, with pinned sources, a pinned Emscripten and the
# pinned TypeScript: the WebAssembly module (wasm/smlibwasm.wasm and its loader
# wasm/smlibwasm.mjs) and the JavaScript (dist/), assembled as the npm package's tree, and checks
# every file against the sha256 pinned in BUILD-PROVENANCE.json (the npm package's). This tree is
# what scripts/release.sh bundles. See BUILD-WASM.md.
#
#   sh packages/exact-kernel/scripts/build-smlibwasm.sh
#
# Environment:
#   EMSDK_DIR  where the Emscripten SDK is installed and kept (default
#              ~/.cache/crispcad-lab/emsdk-6.0.12, about 1.8 GB); an existing install of the
#              pinned version is reused, a missing one is installed.
#   WORK       scratch directory for the sources and the build tree (default: a new temporary
#              directory, removed at the end unless KEEP=1; under 0.5 GB while building).
#   OUT        where the package tree is written: wasm/, dist/, package.json, NOTICE, LICENSE,
#              LICENSE.usd-brep, README.md and .source-build.json (default $WORK/out; set it, or
#              KEEP=1, to keep it).
#
# Exit status: 0 when every file is byte-identical to the pinned (published) one, 3 when the build
# succeeded but differs, anything else on a failure.
set -eu

SMLIBPY_REPO=https://github.com/awv-informatik/smlibpy.git
SMLIBPY_COMMIT=a6320aa21df7c7fa4980e10ed5a94f5bcd94ce65   # tag v0.6.2 (npm provenance names it)
USD_BREP_REPO=https://github.com/NVIDIA-Omniverse/usd-brep.git
USD_BREP_COMMIT=c9c5979f04cea8c38213004d4f04df0dcfb40d05  # v0.6.2's third_party/usd-brep submodule
EMSDK_REPO=https://github.com/emscripten-core/emsdk.git
EMSDK_VERSION=6.0.12                                       # smlibpy's release.yml, job "npm"
EMSDK_COMMIT=35ff8a6d150541276abbc6bae512ca90bcfbe220      # emsdk tag 6.0.12
EMSCRIPTEN_RELEASE=6e9f6885cb17a3d6c8fd488a5cff730f50aba61d # what 6.0.12 resolves to (CI log)
# The sha256 of every file of the package tree is in BUILD-PROVENANCE.json, in this script's
# package (the published package's files; checked by smlibwasm-provenance.mjs).
HERE=$(cd "$(dirname "$0")" && pwd)
# The published module was built in GitHub Actions with the sources checked out here. Source
# paths end up in the module (the kernel's error messages carry __FILE__), so this build maps its
# own checkout to the same path; nothing else about the build depends on where it runs.
CI_ROOT=/home/runner/work/smlibpy/smlibpy

EMSDK_DIR=${EMSDK_DIR:-$HOME/.cache/crispcad-lab/emsdk-$EMSDK_VERSION}
KEEP=${KEEP:-0}
if [ -z "${WORK:-}" ]; then
  WORK=$(mktemp -d "${TMPDIR:-/tmp}/smlibwasm-build.XXXXXX")
  [ "$KEEP" = 1 ] || trap 'rm -rf "$WORK"' EXIT
fi
# The compiler sees normalised paths: a TMPDIR ending in / (macOS) gives WORK a //, and the
# -ffile-prefix-map below would then match nothing and leave the checkout's path in the module.
WORK=$(cd "$WORK" && pwd)
OUT=${OUT:-$WORK/out}
SRC=$WORK/smlibpy
for tool in git cmake ninja python3 shasum node npm; do
  command -v "$tool" >/dev/null 2>&1 || { echo "needs $tool on the PATH" >&2; exit 1; }
done

# A shallow checkout of one commit.
fetch() { # repo commit dir
  mkdir -p "$3"
  git -C "$3" init -q
  git -C "$3" fetch -q --depth 1 "$1" "$2"
  git -C "$3" -c advice.detachedHead=false checkout -q FETCH_HEAD
  [ "$(git -C "$3" rev-parse HEAD)" = "$2" ] || { echo "$1: got $(git -C "$3" rev-parse HEAD), want $2" >&2; exit 1; }
}

echo "== sources: smlibpy $SMLIBPY_COMMIT, usd-brep $USD_BREP_COMMIT"
fetch "$SMLIBPY_REPO" "$SMLIBPY_COMMIT" "$SRC"
pinned=$(git -C "$SRC" ls-tree HEAD third_party/usd-brep | awk '{print $3}')
[ "$pinned" = "$USD_BREP_COMMIT" ] || { echo "smlibpy pins usd-brep $pinned, this script $USD_BREP_COMMIT" >&2; exit 1; }
rmdir "$SRC/third_party/usd-brep" 2>/dev/null || true
fetch "$USD_BREP_REPO" "$USD_BREP_COMMIT" "$SRC/third_party/usd-brep"

echo "== Emscripten $EMSDK_VERSION in $EMSDK_DIR"
if [ ! -d "$EMSDK_DIR/.git" ]; then
  git clone -q --depth 1 --branch "$EMSDK_VERSION" "$EMSDK_REPO" "$EMSDK_DIR"
fi
[ "$(git -C "$EMSDK_DIR" rev-parse HEAD)" = "$EMSDK_COMMIT" ] || { echo "$EMSDK_DIR is not emsdk $EMSDK_VERSION ($EMSDK_COMMIT)" >&2; exit 1; }
"$EMSDK_DIR/emsdk" install "$EMSDK_VERSION" >/dev/null
"$EMSDK_DIR/emsdk" activate "$EMSDK_VERSION" >/dev/null
rm -rf "$EMSDK_DIR/downloads"
grep -q "$EMSCRIPTEN_RELEASE" "$EMSDK_DIR/upstream/.emsdk_version" || { echo "emsdk did not install release $EMSCRIPTEN_RELEASE" >&2; exit 1; }

echo "== build (smlibpy's js/scripts/build-wasm.sh, Release, Ninja)"
mkdir -p "$OUT/wasm"
# (CXXFLAGS reaches CMAKE_CXX_FLAGS on the first configure, so every C++ compile gets the map)
(
  # (the pinned SDK first on the PATH: build-wasm.sh takes whatever emcmake it finds there, and a
  # system Emscripten, such as Homebrew's, would win otherwise)
  # (emsdk_env.sh sets and unsets variables of its own, EMSDK_DIR among them)
  sdk=$EMSDK_DIR
  cd "$sdk"
  set +u
  . ./emsdk_env.sh >/dev/null 2>&1
  set -u
  cd "$SRC"
  case "$(command -v emcmake)" in "$sdk"/*) ;; *) echo "emcmake is $(command -v emcmake), not the pinned SDK's" >&2; exit 1 ;; esac
  emcc --version | head -1
  CXXFLAGS="-ffile-prefix-map=$SRC=$CI_ROOT" BUILD_DIR="$WORK/build" OUT_DIR="$OUT/wasm" sh js/scripts/build-wasm.sh >"$WORK/build.log" 2>&1
) || { tail -40 "$WORK/build.log" >&2; exit 1; }
rm -rf "$WORK/build"

echo "== JavaScript (smlibpy's npm run build, TypeScript 5.9.3 from js/package-lock.json)"
(
  cd "$SRC/js"
  npm ci --ignore-scripts --no-audit --no-fund >"$WORK/npm.log" 2>&1
  [ "$(node -p 'require("typescript/package.json").version')" = 5.9.3 ] || { echo "TypeScript is not 5.9.3" >&2; exit 1; }
  rm -rf dist
  ./node_modules/.bin/tsc -p tsconfig.build.json
  node scripts/declarations.mjs >/dev/null
) || { cat "$WORK/npm.log" >&2; exit 1; }
# The package tree as npm publishes it (prepack.mjs copies the two licence texts), without
# fonts/ (the Lato font's licence; the font is not bundled).
rm -rf "$OUT/dist"
cp -R "$SRC/js/dist" "$OUT/dist"
cp "$SRC/js/package.json" "$SRC/js/NOTICE" "$SRC/js/README.md" "$OUT/"
cp "$SRC/LICENSE" "$OUT/LICENSE"
cp "$SRC/third_party/usd-brep/LICENSE" "$OUT/LICENSE.usd-brep"
printf '{ "smlibpy": "%s", "usd-brep": "%s", "emsdk": "%s", "emscriptenRelease": "%s", "builtAt": "%s", "host": "%s" }\n' \
  "$SMLIBPY_COMMIT" "$USD_BREP_COMMIT" "$EMSDK_VERSION" "$EMSCRIPTEN_RELEASE" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(uname -sm)" >"$OUT/.source-build.json"

echo "== compare with BUILD-PROVENANCE.json (the files of @classcad/smlibwasm@0.6.2 on npm)"
status=0
node "$HERE/smlibwasm-provenance.mjs" "$OUT" || status=3
echo "built tree: $OUT"
exit $status
