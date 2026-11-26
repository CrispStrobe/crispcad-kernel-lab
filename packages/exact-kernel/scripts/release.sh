#!/bin/sh
# SPDX-License-Identifier: MIT
# Copyright (c) 2026 CrispCAD contributors
#
# Builds the release tarball of @crispcad/exact-kernel from an smlibwasm built from source, and
# fails unless that build, the pins in BUILD-PROVENANCE.json and the npm package all agree.
#
#   sh packages/exact-kernel/scripts/release.sh [out-dir]   # default out-dir: the package
#
# 1. smlibwasm from source: the tree in SMLIBWASM_BUILD (the OUT of an earlier
#    scripts/build-smlibwasm.sh), or a fresh build-smlibwasm.sh run (Emscripten SDK in EMSDK_DIR,
#    1.8 GB, kept; see BUILD-WASM.md). Every file must have its pinned sha256.
# 2. The npm package @classcad/smlibwasm@<version>: its tarball must have the pinned integrity
#    (sha512), and every pinned file in it the pinned sha256, so source build = pins = npm.
# 3. The source-built tree goes into this package's node_modules/@classcad/smlibwasm (where
#    scripts/build.mjs takes it from), the package is built and tested, and `npm pack` writes the
#    tarball, whose dist/smlibwasm.wasm and dist/bundle-inputs.json are checked once more.
# 4. Prints the tarball's sha256 and npm integrity (sha512) for the GitHub release notes.
#
# Any difference stops the release with a non-zero exit status and the files that differ.
set -eu

PKG=$(cd "$(dirname "$0")/.." && pwd)
DEST=${1:-$PKG}
TMP=$(mktemp -d "${TMPDIR:-/tmp}/exact-kernel-release.XXXXXX")
INSTALLED=$PKG/node_modules/@classcad/smlibwasm
cleanup() { rm -rf "$TMP" "$INSTALLED"; rmdir "$PKG/node_modules/@classcad" "$PKG/node_modules" 2>/dev/null || true; }
trap cleanup EXIT
fail() { echo "release: $*" >&2; exit 1; }
pin() { node -p "const p = require('$PKG/BUILD-PROVENANCE.json'); $1"; }

VERSION=$(pin p.version)
INTEGRITY=$(pin p.npm.integrity)
WASM_SHA=$(pin "p.files['wasm/smlibwasm.wasm']")
[ ! -e "$INSTALLED" ] || fail "$INSTALLED exists; remove it first (the release installs the source build there)"

echo "== 1. smlibwasm $VERSION from source"
if [ -n "${SMLIBWASM_BUILD:-}" ]; then
  BUILD=$SMLIBWASM_BUILD
  [ -f "$BUILD/.source-build.json" ] || fail "$BUILD is not a tree written by build-smlibwasm.sh (no .source-build.json)"
else
  BUILD=$TMP/smlibwasm
  OUT=$BUILD sh "$PKG/scripts/build-smlibwasm.sh" || fail "build-smlibwasm.sh failed or its output differs from BUILD-PROVENANCE.json"
fi
node "$PKG/scripts/smlibwasm-provenance.mjs" "$BUILD" || fail "the source build differs from BUILD-PROVENANCE.json"

echo "== 2. npm @classcad/smlibwasm@$VERSION"
packed=$(cd "$TMP" && npm pack --silent "@classcad/smlibwasm@$VERSION")
got=sha512-$(openssl dgst -sha512 -binary "$TMP/$packed" | openssl base64 -A)
[ "$got" = "$INTEGRITY" ] || fail "npm tarball integrity $got, pinned $INTEGRITY"
mkdir "$TMP/npm" && tar -xzf "$TMP/$packed" -C "$TMP/npm"
node "$PKG/scripts/smlibwasm-provenance.mjs" "$TMP/npm/package" || fail "the npm package differs from BUILD-PROVENANCE.json"
echo "source build = BUILD-PROVENANCE.json = npm ($INTEGRITY)"

echo "== 3. build, test and pack @crispcad/exact-kernel on the source build"
mkdir -p "$(dirname "$INSTALLED")"
cp -R "$BUILD" "$INSTALLED"
(cd "$PKG" && npm test >"$TMP/test.log" 2>&1) || { tail -60 "$TMP/test.log" >&2; fail "tests failed (log above)"; }
perl -pe 's/\e\[[0-9;]*m//g' "$TMP/test.log" | grep -E "Tests +[0-9]+ passed" | tail -1
# (prepack prints the build summary before the file name)
tarball=$(cd "$PKG" && npm pack --silent --pack-destination "$DEST" | tail -1)
mkdir "$TMP/packed" && tar -xzf "$DEST/$tarball" -C "$TMP/packed"
[ "$(shasum -a 256 "$TMP/packed/package/dist/smlibwasm.wasm" | awk '{print $1}')" = "$WASM_SHA" ] || fail "the tarball's dist/smlibwasm.wasm is not the pinned module"
node -e "const b = require('$TMP/packed/package/dist/bundle-inputs.json'); if (b.build.from !== 'source') { console.error('bundle-inputs.json: build.from is ' + b.build.from); process.exit(1); }" || fail "the tarball was not built from the source build"
cmp -s "$TMP/packed/package/BUILD-PROVENANCE.json" "$PKG/BUILD-PROVENANCE.json" || fail "the tarball lacks BUILD-PROVENANCE.json"

echo "== 4. $DEST/$tarball"
echo "sha256    $(shasum -a 256 "$DEST/$tarball" | awk '{print $1}')"
echo "integrity sha512-$(openssl dgst -sha512 -binary "$DEST/$tarball" | openssl base64 -A)"
