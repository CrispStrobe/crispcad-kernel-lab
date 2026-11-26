#!/bin/sh
# SPDX-License-Identifier: MIT
# Copyright (c) 2026 CrispCAD contributors
#
# Builds the WebAssembly module of @classcad/smlibwasm 0.6.2 (smlibwasm.wasm and its loader
# smlibwasm.mjs) from source, with pinned sources and a pinned Emscripten, and compares it with the
# binary published on npm (and attached to smlibpy's v0.6.2 GitHub release). See BUILD-WASM.md.
#
#   sh packages/exact-kernel/scripts/build-smlibwasm.sh
#
# Environment:
#   EMSDK_DIR  where the Emscripten SDK is installed and kept (default
#              ~/.cache/crispcad-lab/emsdk-6.0.12, about 1.8 GB); an existing install of the
#              pinned version is reused, a missing one is installed.
#   WORK       scratch directory for the sources and the build tree (default: a new temporary
#              directory, removed at the end unless KEEP=1; under 0.5 GB while building).
#   OUT        where smlibwasm.wasm and smlibwasm.mjs are written (default $WORK/out; set it, or
#              KEEP=1, to keep them).
#
# Exit status: 0 when both files are byte-identical to the published ones, 3 when the build
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
# sha256 of @classcad/smlibwasm@0.6.2's wasm/smlibwasm.wasm and wasm/smlibwasm.mjs
EXPECT_WASM=d00feb54a10da2c6b03e1f5d4af448954fa268512e13e3e394fc3797952c1a9e
EXPECT_MJS=e8887c9732d0a411425e5047b86dd68de27ea4c40f2cd44ae69803e1aef20d8f
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
OUT=${OUT:-$WORK/out}
SRC=$WORK/smlibpy
for tool in git cmake ninja python3 shasum; do
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
mkdir -p "$OUT"
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
  CXXFLAGS="-ffile-prefix-map=$SRC=$CI_ROOT" BUILD_DIR="$WORK/build" OUT_DIR="$OUT" sh js/scripts/build-wasm.sh >"$WORK/build.log" 2>&1
) || { tail -40 "$WORK/build.log" >&2; exit 1; }
rm -rf "$WORK/build"

echo "== compare with @classcad/smlibwasm@0.6.2"
status=0
for pair in "smlibwasm.wasm $EXPECT_WASM" "smlibwasm.mjs $EXPECT_MJS"; do
  set -- $pair
  got=$(shasum -a 256 "$OUT/$1" | awk '{print $1}')
  if [ "$got" = "$2" ]; then echo "$1: identical ($got)"; else echo "$1: DIFFERS: built $got, published $2"; status=3; fi
done
echo "built files: $OUT"
exit $status
