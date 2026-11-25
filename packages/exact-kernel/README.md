# @crispcad/exact-kernel

An exact B-rep kernel for JavaScript and TypeScript, behind a narrow `ExactKernel`
interface, on SMLib through [`@classcad/smlibwasm`](https://github.com/awv-informatik/smlibpy)
0.6.2. Part of the [CrispCAD kernel lab](https://github.com/CrispStrobe/crispcad-kernel-lab);
consumed by [CrispCAD](https://github.com/CrispStrobe/CrispCAD).

- **Licence closure: MIT and Apache-2.0 only.** smlibwasm is prebundled into `dist/`, so the
  package has no runtime dependencies. Its default text font module is replaced by an empty
  one at build time (the font is not MIT or Apache-2.0); modeling and STEP do not use it.
- **No OpenCASCADE.** Nothing here loads OpenCASCADE or its JavaScript bindings.
- Distributed as a tarball attached to a GitHub release (`exact-kernel-v*` tags), not on npm.

## Use

```ts
import { createSmlibKernel } from '@crispcad/exact-kernel';

const k = await createSmlibKernel(); // loads the 9.4 MB WebAssembly once
const part = k.scope(() => k.shell(k.fillet(k.box([60, 40, 30]), 4), 2, [0, 0, 1]));
k.volume(part);        // 14950.678… mm³
k.exportStep(part);    // AP214 STEP text
part.dispose();
```

Importing the module loads nothing; `createSmlibKernel()` loads `dist/smlibwasm.wasm` from
next to the bundle. In a worker, compile the module once and pass it:
`createSmlibKernel({ wasmModule })` (also `wasmBinary`, `locateFile`). Options count only on
the first call in a process or worker.

## API

`ExactKernel` (see [`src/exact-kernel.ts`](src/exact-kernel.ts)); solids and profiles are opaque
handles, freed with `dispose()` or by building inside `scope()`. Conventions follow CAD Script:
primitives are centred on the origin, extrusions start at z = 0, revolutions turn sketch X/Y
about world Z.

| Group | Operations |
| --- | --- |
| Primitives | `box`, `cylinder`, `cone` (frustum, one radius may be 0), `sphere`, `torus`, `polyhedron` (planar faces) |
| Profiles (`k.profile`) | `polygon` (even-odd, holes), `circle`, `rectangle`, `roundedRectangle`, `path` (lines, three-point / radius / sagitta arcs, splines), `text` (always `unsupported`: no font), 2D `union`/`subtract`/`intersect`/`hull`/`offset`, `translate`/`rotate`/`scale`, `bounds`, `area` |
| Solids from profiles | `extrude`, `revolve`, `loft` (smooth or ruled, XY sections), `sweep` (polyline rail) |
| Booleans, transforms | `union`, `subtract`, `intersect`, `splitByPlane`, `translate`, `rotate` (axis, pivot), `mirror` (normal, origin), `scale` (per axis, signed) |
| Features | `fillet`, `chamfer` (all edges or one planar face's edges), `shell` (one or more open faces); faces by outward normal, `outermost` to pick among parallel faces |
| Measures | `volume`, `area`, `bbox`, `massProperties` (centroid, inertia, principal moments/axes), `isValid`, `solidCount`, `components` |
| Exchange | `tessellate` (positions, vertex normals, indices), `exportStl` (binary), `exportStep`, `importStep` (exact) |
| Runtime | `memory`, `scope`, `name`, `version`, `licence` (`MIT AND Apache-2.0`) |

Also exported: `convexHull` / `isConvexPolyhedron` (exact hull as planar faces) and
`symmetricEigen`.

Errors are `ExactKernelError` with `code`:

- `invalid-input`: malformed requests, rejected before the kernel runs;
- `unsupported`: no exact construction here (for example `text`);
- `kernel-failure`: the kernel rejected the operation; it stays usable afterwards.

Nothing falls back to a mesh.

## Qualification

`npm test` here builds the bundle and tests **the built `dist/`**:

| Test | Gate |
| --- | --- |
| `tests/reference-parts.test.ts` | The lab's 27 reference parts (`assets/reference-parts/scorecard.json`) at 1e-6 relative volume and area (1e-8 where the scorecard asks), bbox within 1e-6 mm, valid, expected component count; every part round-trips STEP exactly (1e-9); no kernel handles leak. |
| `tests/kernel.test.ts` | Fillet, chamfer, shell, cylinder-rim fillet against closed forms (1e-8); mass properties, path profiles, loft, sweep, split, components, mirror, STL; malformed input and kernel failures; recovery afterwards. |
| `tests/no-font.test.ts` | The bundle's font module is empty; `text` is `unsupported`; fillet + shell + STEP round trip still work. |
| `tests/licence.test.ts` | `npm pack`s the package, unpacks the tarball and fails on any file without a known MIT or Apache-2.0 licence, on copyleft or font licence texts, on any of the upstream font's data, on runtime dependencies, and on any reference to OpenCASCADE or its JavaScript bindings outside smlibwasm's `.brep` file-format strings. |

Results with `@classcad/smlibwasm` 0.6.2 (Apple M1, Node 26.4): 27/27 parts, worst relative
volume error 2.5e-15, area 1.2e-11, bbox 1.8e-14 mm.

## Contents of the tarball

| Path | Licence |
| --- | --- |
| `dist/index.js`, `dist/chunk-*.js` | This package (MIT) and smlibwasm's JavaScript (MIT, AWV Informatik AG), including the Emscripten loader (MIT) and the Brotli dictionary (MIT) |
| `dist/_defeature_supervisor.js`, `dist/_defeature_worker.js` | smlibwasm's probe workers (MIT), which it starts from files next to its module |
| `dist/smlibwasm.wasm` | SMLib / USD BRep (NVIDIA, Apache-2.0) with AWV's bindings (MIT), unmodified |
| `dist/*.d.ts` | This package's types (MIT) |
| `dist/bundle-inputs.json` | Every source file in the bundle with its licence |
| `LICENSE`, `NOTICE`, `licenses/` | MIT (this package, smlibwasm, Emscripten) and Apache-2.0 (USD BRep) texts |

The WebAssembly contains "Open CASCADE Topology" banners: they belong to smlibwasm's `.brep`
file-format reader and writer, not to OpenCASCADE code.

## Build and release

```sh
cd packages/exact-kernel
npm run build        # dist/ (esbuild; tooling and smlibwasm come from the lab's root install)
npm test             # builds, then the four test files above
npm run typecheck
npm pack             # crispcad-exact-kernel-<version>.tgz (prepack rebuilds)
```

Release: tag `exact-kernel-v<version>` and attach the tarball to a GitHub release with its
SHA-256. Do not publish to npm.

## Provenance

The interface and SMLib adapter come from CrispCAD's `experiments/exact-kernel` (same author,
relicensed MIT here); mass properties, path profiles, loft, sweep and STL follow the lab's
native SMLib backend (`src/kernel/backends/smlib/smlibBackend.ts`,
`src/modeling/backends/smlib/nativeLowerer.ts`). The lab's `smlib-native` backend does not use
this package yet; it could build its feature lowering on `ExactKernel` later.
