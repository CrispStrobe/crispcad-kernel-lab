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
| Primitives | `box`, `cylinder`, `cone` (frustum, one radius may be 0), `sphere`, `torus`, `polyhedron` (a face that is not planar within 1e-9 is split into triangles) |
| Profiles (`k.profile`) | `polygon` (even-odd, holes), `circle`, `rectangle`, `roundedRectangle`, `path` (lines, three-point / radius / sagitta arcs, splines), `text` (always `unsupported`: no font), 2D `union`/`subtract`/`intersect`/`hull`/`offset`, `translate`/`rotate`/`scale`, `bounds`, `area` |
| Solids from profiles | `extrude`, `revolve`, `loft` (smooth or ruled, XY sections), `sweep` (polyline rail) |
| Booleans, transforms | `union`, `subtract`, `intersect`, `splitByPlane`, `translate`, `rotate` (axis, pivot), `mirror` (normal, origin), `scale` (per axis, signed) |
| Features | `fillet`, `chamfer` (all edges or one planar face's edges), `shell` (one or more open faces); faces by outward normal, `outermost` to pick among parallel faces |
| Measures | `volume`, `area`, `bbox` (exact, see below), `massProperties` (centroid, inertia, principal moments/axes), `isValid`, `solidCount`, `components` |
| Exchange | `tessellate` (positions, vertex normals, indices), `exportStl` (binary), `exportStep`, `importStep` (exact) |
| Runtime | `memory`, `scope`, `name`, `version`, `licence` (`MIT AND Apache-2.0`) |

Also exported: `convexHull` (exact hull as planar faces, up to `MAX_HULL_POINTS` = 1024 distinct
points), `isConvexPolyhedron`, `planarFaces` (the triangulation `polyhedron` applies) and
`symmetricEigen`. `polyhedron` itself has no face budget (2,044 faces stitch in about 3 s on a
loaded M1).

**`bbox`** is not SMLib's `bbox()`, which misses interior extremes of some rotated spheres
(`sphere(62)` turned 11° about X: min z −60.861 instead of −62). It is built from points on the
body: vertices, line ends, analytic circle extremes, a sphere's centre ± r·eᵢ and a torus'
centre ± R·w ± r·eᵢ where those lie on the face, and sampled-and-refined extremes of other curves
and faces (skipped where the NURBS control net lies inside the box so far). It is never larger
than the body; for analytic faces it matches the closed form to 1e-9 of the size.

**`convexHull`** (0.1.1) builds the hull incrementally and merges triangles into one face only
when all their points lie within 1e-9 of one plane. 0.1.0 took every point within a size-relative
tolerance of a plane as one face: for six-decimal coordinates over a metre, that merged slightly
twisted quads into non-planar faces SMLib could not stitch ("The polyhedron faces do not close",
437 long multi-section lofts in CrispCAD's catalog cross-check), and kept near-identical planes
as overlapping faces (a hexagonal frustum's area 81,727 mm² instead of 47,342).

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
| `tests/bbox.test.ts` | `bbox` of spheres, tori, cylinders, cones and ellipsoids turned about six axes against closed forms (1e-9 of the size; ellipsoids 1e-7), and of a turned hemisphere. |
| `tests/polyhedra.test.ts` | Loft polyhedra as CrispCAD lowers them (six-decimal points, hull for convex ones): the chandelier canopy frustum and 4-section 10/12/16-gon rollers 30 mm to 10 m long against closed-form volume and area (1e-6); non-planar polyhedron faces; hull closure, planarity, Euler characteristic and budget. |
| `tests/no-font.test.ts` | The bundle's font module is empty; `text` is `unsupported`; fillet + shell + STEP round trip still work. |
| `tests/licence.test.ts` | `npm pack`s the package, unpacks the tarball and fails on any file without a known MIT or Apache-2.0 licence, on copyleft or font licence texts, on any of the upstream font's data, on runtime dependencies, and on any reference to OpenCASCADE or its JavaScript bindings outside smlibwasm's `.brep` file-format strings. |

Results with `@classcad/smlibwasm` 0.6.2 (Apple M1, Node 26.4): 27/27 parts, worst relative
volume error 2.5e-15, area 1.2e-11, bbox 1.8e-14 mm.

## Changes

- **0.1.2**: `bbox` is fast again on trimmed curved bodies. 0.1.1 sampled B-spline edges with
  SMLib's `Edge.pointAt`, which takes a fraction of the arc length and integrates the length on
  every call (up to 0.4 s a point on the long intersection curve of an ellipsoid cut by a box), so
  such parts took 1 to 9 minutes; the edges are now evaluated from their own NURBS. The catalog's
  ore heap (`mining/apron-feeder` `ore-heap`) takes 24 ms instead of 134 s, with the same box.
- **0.1.1**: exact `bbox` (rotated spheres); incremental `convexHull` with exact-planarity
  merging (long multi-section lofts build, frustum areas right), hull budget 64 → 1024 points;
  `polyhedron` splits non-planar faces into triangles; even-odd polygon profiles pass the largest
  region to SMLib's `xor` first (hole-first gave inverted faces). Upstream report draft:
  [`docs/smlibwasm-upstream-report.md`](../../docs/smlibwasm-upstream-report.md).
- **0.1.0**: first release.

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
