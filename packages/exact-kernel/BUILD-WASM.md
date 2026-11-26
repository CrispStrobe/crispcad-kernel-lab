# Building smlibwasm's WebAssembly from source

`@crispcad/exact-kernel` bundles `dist/smlibwasm.wasm`, the WebAssembly module of
[`@classcad/smlibwasm`](https://www.npmjs.com/package/@classcad/smlibwasm) 0.6.2 from npm.
[`scripts/build-smlibwasm.sh`](scripts/build-smlibwasm.sh) rebuilds that module from source
with pinned sources and a pinned Emscripten and compares it with the published one. On
2026-11-26 the rebuild was **byte-identical** to the npm binary: `smlibwasm.wasm` and its
loader `smlibwasm.mjs` both matched (sha256 below). The release still bundles the npm module;
the script shows that it can be reproduced from source.

```sh
sh packages/exact-kernel/scripts/build-smlibwasm.sh   # exit 0: identical; 3: built but differs
```

Needs `git`, `cmake` (3.20 or later; 4.1.1 was used), `ninja`, `python3` and `shasum` on the
PATH, and about 2.3 GB of disk: 1.8 GB for the Emscripten SDK, which is kept in
`~/.cache/crispcad-lab/emsdk-6.0.12` (`EMSDK_DIR`) for the next run, and under 0.5 GB of sources and
build tree in a temporary directory (`WORK`) that is removed afterwards. Remove the SDK with
`rm -rf ~/.cache/crispcad-lab/emsdk-6.0.12`. The module and loader are written to `OUT`
(default inside `WORK`; set `OUT` or `KEEP=1` to keep them). The build compiles about 365 files
and took 5.5 min on an M1 shared with other jobs (6 min on smlibpy's GitHub runner), with the SDK
already installed.

## What is pinned

| Input | Pin | Where it comes from |
|---|---|---|
| smlibpy (bindings, build files, kernel patches) | `a6320aa21df7c7fa4980e10ed5a94f5bcd94ce65`, tag `v0.6.2` | the commit named in the npm package's SLSA provenance |
| usd-brep (SMLib, SM_API, SmPyLib) | `c9c5979f04cea8c38213004d4f04df0dcfb40d05` | smlibpy v0.6.2's `third_party/usd-brep` submodule (checked by the script) |
| Emscripten SDK | emsdk `6.0.12` (commit `35ff8a6d150541276abbc6bae512ca90bcfbe220`), release `6e9f6885cb17a3d6c8fd488a5cff730f50aba61d`, emcc 6.0.12 (`5488e0871d46d19a3209988190fa6a653126256f`) | `EMSDK_VERSION` in smlibpy's `.github/workflows/release.yml`, job `npm`; the release hash from that job's log |
| Build | smlibpy's `js/scripts/build-wasm.sh`: CMake, Release, Ninja | as in the release job |

| File | sha256 (npm `@classcad/smlibwasm@0.6.2`, smlibpy's v0.6.2 release assets, and this build) |
|---|---|
| `wasm/smlibwasm.wasm` (9,430,902 bytes) | `d00feb54a10da2c6b03e1f5d4af448954fa268512e13e3e394fc3797952c1a9e` |
| `wasm/smlibwasm.mjs` (87,118 bytes) | `e8887c9732d0a411425e5047b86dd68de27ea4c40f2cd44ae69803e1aef20d8f` |

The module embeds source paths: the kernel's error messages carry `__FILE__`, and the published
build ran in `/home/runner/work/smlibpy/smlibpy`. The script compiles with
`-ffile-prefix-map=<its checkout>=/home/runner/work/smlibpy/smlibpy`, which changes only those
strings. Nothing else in the output depends on the host: the build here ran on macOS arm64 with
the SDK's arm64 binaries, the published one on Ubuntu x86_64. Emscripten's own system libraries
are built with their paths mapped to `/emsdk/emscripten`, whatever the install path.

The script puts the pinned SDK first on the PATH and checks that `emcmake` is its own, because
`build-wasm.sh` takes any `emcmake` it finds (a Homebrew Emscripten 6.0.2 was found first here).
A Docker build (`emscripten/emsdk:6.0.12`) would work the same way with the checkout mounted at
`/home/runner/work/smlibpy/smlibpy`; it was not tried here.

## Licences of what is compiled

| Part | Licence | Source |
|---|---|---|
| SMLib, SM_API, SmPyLib's binders and error messages (usd-brep `source/`) | Apache-2.0 (`SPDX-License-Identifier: Apache-2.0` in every file) | NVIDIA-Omniverse/usd-brep |
| Patched copies of a few SMLib files (`third_party/patches`), each with a change notice | Apache-2.0 | awv-informatik/smlibpy |
| usd-brep's OpenCASCADE `.brep` reader and writer, copied into `src/cpp/occt` (no OpenCASCADE code: it parses the file format itself) | Apache-2.0 | awv-informatik/smlibpy, from usd-brep |
| smlibpy's C++ (`src/cpp`), the embind layer (`js/cpp`), the TypeScript port (`js/src`) | MIT (AWV Informatik AG) | awv-informatik/smlibpy |
| Emscripten's runtime and system libraries (musl, libc++, libc++abi, compiler-rt, dlmalloc) | MIT / Apache-2.0 with LLVM exception / public domain | emscripten-core |

The npm package as a whole is `MIT AND Apache-2.0 AND OFL-1.1`: the OFL part is the Lato font
in its JavaScript (`dist/_fonts.js`), which this package replaces with an empty module. The
WebAssembly module contains no font. Nothing compiled is under a copyleft licence.

## The published binary's provenance

Independently of the rebuild, the npm tarball can be checked against its provenance:

- `npm view @classcad/smlibwasm@0.6.2 dist.integrity` is
  `sha512-JDHQDdX13u1DiXJvNMfAWG7iyUVPpCVIL8Sfuw+p0CZq1E5sqN9VBFeuj+mEGbSFbZ+6/8ftRn6wnwlMWBu3SQ==`,
  the digest the npm attestations (`https://registry.npmjs.org/-/npm/v1/attestations/@classcad%2fsmlibwasm@0.6.2`)
  sign. Their SLSA provenance names `.github/workflows/release.yml` of awv-informatik/smlibpy at
  `refs/tags/v0.6.2`, commit `a6320aa2`, run 40623359209 on a GitHub-hosted runner.
- The wasm and loader attached to smlibpy's v0.6.2 GitHub release have the same sha256 as the
  files in the npm tarball.
