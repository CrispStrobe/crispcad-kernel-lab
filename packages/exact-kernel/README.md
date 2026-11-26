# @crispcad/exact-kernel

An exact B-rep kernel for JavaScript and TypeScript, behind a narrow `ExactKernel`
interface, on SMLib through [`@classcad/smlibwasm`](https://github.com/awv-informatik/smlibpy)
0.6.2. Part of the [CrispCAD kernel lab](https://github.com/CrispStrobe/crispcad-kernel-lab);
consumed by [CrispCAD](https://github.com/CrispStrobe/CrispCAD).

- **Licence closure: MIT and Apache-2.0 only.** smlibwasm is built from source (byte-identical to
  the npm package; `BUILD-PROVENANCE.json`) and prebundled into `dist/`, so the package has no
  dependencies. Its default text font module is replaced by an empty
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

Limits (0.1.6):

```ts
const k = await createSmlibKernel({ maxMemoryBytes: 512 * 2 ** 20, guardSeconds: 10 });
k.maxMemoryBytes;          // 536870912 (whole 64 KiB pages)
k.setGuardSeconds(30);     // returns the old value (10); k.guardSeconds() reads it
```

- `maxMemoryBytes`: a ceiling for the kernel's WebAssembly memory (64 MiB initially, 4 GiB
  allowed by the module). An operation that needs more fails with `kernel-failure` ("…ran out of
  memory", SMLib's `SM_ERR_OUT_OF_MEMORY`; the message still names the module's own 4096 MB
  maximum) instead of growing; replace the kernel (its worker) after that. It is held at
  instantiation, on the instance: smlibwasm's `instantiateWasm` hook wraps the loader's
  heap-resize import and the instance memory's `grow`. **The module's bytes are not changed**
  (`dist/smlibwasm.wasm` is the pinned build, `BUILD-PROVENANCE.json`), so a host need not
  rewrite the memory section any more. It works with `wasmModule`, `wasmBinary`, `locateFile` or
  the default file; it covers this kernel, not smlibwasm's probe worker (below). One ceiling per
  process or worker: the same value again is the same kernel, another one is an error.
- `guardSeconds` / `setGuardSeconds(s)` / `guardSeconds()`: smlibwasm's `GUARD_SECONDS` (20 s by
  default, 0 = none), for the process or worker. It holds the steps that can crash or loop:
  `shell` and SMLib's offset, thicken, face and fillet removal, and fillets and chamfers of
  imported parts (not `fillet`/`chamfer` of solids built here). Where a probe worker can run (Node,
  Web Workers of a cross-origin-isolated page) such a step runs there and is ended after that
  many seconds of wall-clock time. Elsewhere (a page's main thread, an ordinary Web Worker) it
  runs in this kernel under SMLib's deadline, which only the long loops of its surface and
  topology intersections check: a step that spends its time elsewhere is not stopped. A host
  that must bound every job still needs its own budget (e.g. terminating the worker).

## API

`ExactKernel` (see [`src/exact-kernel.ts`](src/exact-kernel.ts)); solids and profiles are opaque
handles, freed with `dispose()` or by building inside `scope()`. Conventions follow CAD Script:
primitives are centred on the origin, extrusions start at z = 0, revolutions turn sketch X/Y
about world Z.

| Group | Operations |
| --- | --- |
| Primitives | `box`, `cylinder`, `cone` (frustum, one radius may be 0), `sphere`, `torus`, `polyhedron` (a face that is not planar within 1e-9 is split into triangles) |
| Profiles (`k.profile`) | `polygon` (even-odd, holes; a contour that crosses itself is refused), `circle`, `rectangle`, `roundedRectangle`, `path` (lines, three-point / radius / sagitta arcs, splines; refused if it crosses itself), `text` (always `unsupported`: no font), 2D `union`/`subtract`/`intersect`/`hull`/`offset`, `translate`/`rotate`/`scale`, `bounds`, `area` |
| Solids from profiles | `extrude`, `revolve`, `loft` (smooth or ruled, XY sections; `pairing`, below), `sweep` (polyline rail) |
| Booleans, transforms | `union`, `subtract`, `intersect`, `splitByPlane`, `translate`, `rotate` (axis, pivot), `mirror` (normal, origin), `scale` (per axis, signed) |
| Features | `fillet`, `chamfer` (all edges or one planar face's edges), `shell` (one or more open faces); faces by outward normal, `outermost` to pick among parallel faces |
| Measures | `volume`, `area`, `bbox` (exact, see below), `massProperties` (centroid, inertia, principal moments/axes), `isValid`, `solidCount`, `components` |
| Exchange | `tessellate` (positions, vertex normals, indices), `exportStl` (binary), `exportStep`, `importStep` (exact) |
| Runtime | `memory`, `scope`, `name`, `version`, `licence` (`MIT AND Apache-2.0`); on the SMLib kernel (`SmlibKernel`) also `setGuardSeconds`, `guardSeconds`, `maxMemoryBytes` |

Also exported: `convexHull` (exact hull as planar faces, up to `MAX_HULL_POINTS` = 1024 distinct
points), `isConvexPolyhedron`, `planarFaces` (the triangulation `polyhedron` applies) and
`symmetricEigen`. `polyhedron` itself has no face budget (2,044 faces stitch in about 3 s on a
loaded M1).

**`loft`** pairs the vertices of neighbouring sections by `options.pairing`:

- `'authored'` (the default): sections with equal vertex counts join vertex i to vertex i, as
  drawn, as up to 0.1.4 (path profiles through their outline wires, other profiles through their
  faces). Use it wherever the model defines the sides by its own correspondence (CrispCAD's CAD
  Script).
- `'closest'`: straight-edged single-outline sections (`profile.path` of lines, one-contour
  `profile.polygon`) with equal counts are re-started as OpenCASCADE's
  `BRepOffsetAPI_ThruSections` does: each section starts at the vertex, and runs in the
  direction, where it lies closest to the section before. For models written against OCCT.
- Straight-edged sections with **different** vertex counts have no vertex i to keep: with either
  pairing they get vertices inserted by OCCT's polar rule (each vertex carried to the other
  sections along a ray from their outline centres; an edge is split at the hit, or the hit snaps to
  an edge end within 10 % of the edge unless that end is taken), and the first section keeps its
  start and direction. Other sections with different counts are left to SMLib.

Smooth lofts through outline wires and through faces are different surfaces in SMLib (the same
vertices, another section parametrisation): CrispCAD's 8-gon vase is 72,931.33 mm³ through
polygon faces and 72,922.22 mm³ through path outlines, in 0.1.4 and now.

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

- **0.1.6**: `loft` takes `pairing: 'authored' | 'closest'`, default `'authored'`, which restores
  0.1.4's vertex i → i for sections with equal vertex counts. 0.1.5 re-started such sections as
  OpenCASCADE does whenever they were straight-edged, and built polygon sections as wires of lines
  instead of faces, which broke CrispCAD's CAD Script lofts: a twisted ruled loft no longer had its
  faceted volume, and smooth lofts were another surface (72,922.22 mm³ instead of 72,931.33 for
  CrispCAD's vase). OpenCASCADE's re-start is now `pairing: 'closest'` (the option's name describes
  the rule, so the shipped code and types name no OpenCASCADE, as the licence test requires); different vertex counts keep
  0.1.5's OCCT insertion either way. `createSmlibKernel` takes `maxMemoryBytes` (a memory ceiling
  held at instantiation, the module's bytes unchanged) and `guardSeconds`, and the kernel
  (`SmlibKernel`) has `setGuardSeconds`, `guardSeconds()` and `maxMemoryBytes`.
- **0.1.5**: the release is built on smlibwasm compiled from source (smlibpy v0.6.2, USD BRep
  `c9c5979f`, Emscripten 6.0.12, TypeScript 5.9.3), checked file by file against the pins in the
  shipped `BUILD-PROVENANCE.json` and against the npm package, which it equals byte for byte;
  `@classcad/smlibwasm` is no longer a dependency. `loft` pairs sections of straight-edged
  outlines (`profile.path` of lines, one-contour `profile.polygon`) as OpenCASCADE's
  `BRepOffsetAPI_ThruSections` does (since 0.1.6 for equal counts only with
  `pairing: 'closest'`): where the vertex counts differ, vertices are inserted by
  OCCT's polar rule (each vertex carried to the other sections along a ray from their centres,
  snapping to an edge end within 10 % of the edge), and sections with equal counts start at the
  vertex where they lie closest to the section before. An octagon ruled to a 16-point star, a
  hexagon to a diamond and a pentagon drawn from another vertex now give OCCT's volumes to
  1e-12; catalog models with such lofts were off by 2e-3 to 3.6e-1 (`docs/kernels.md`, "Ruled lofts").
- **0.1.4**: a `loft` of `profile.path` sections joins vertex i of each section to vertex i of
  the next as drawn. A path profile's face came from SMLib's `makeFace`, which may start its
  boundary at another vertex (a square drawn as 8 points, corners and edge midpoints): ruled to
  an octagon 100 mm higher it came out at 113.4e6 mm³ instead of 224.1e6 (the catalog's
  `nature/ground-tile` and `nature/hill-tile`). Path profiles now keep their outline and lofts
  use it. `profile.polygon` sections were not affected.
- **0.1.3**: `profile.polygon` and `profile.path` refuse an outline that crosses itself with
  `invalid-input` and the crossing point. Such an outline (a bow tie, a pentagram) bounds no
  region, but SMLib built a face from it whose extrusion measured the winding-weighted area: the
  catalog's `alpine-expedition/alpine-helmet` chin strap, a bow tie with lobes of 493 and
  89 mm², extruded 14 mm, came out at volume -5656 mm³ (5656 mirrored) and area 4,376.8 mm²,
  and `isValid` was false. Outlines that only touch themselves (a vertex on another edge,
  contours that overlap each other) are still built.
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
| `dist/smlibwasm.wasm` | SMLib / USD BRep (NVIDIA, Apache-2.0) with AWV's bindings (MIT), built from source |
| `dist/*.d.ts` | This package's types (MIT) |
| `dist/bundle-inputs.json` | Every source file in the bundle with its licence, and where the smlibwasm build came from |
| `BUILD-PROVENANCE.json` | The smlibwasm build: sources, Emscripten SDK, build steps and the sha256 of each file (MIT) |
| `LICENSE`, `NOTICE`, `licenses/` | MIT (this package, smlibwasm, Emscripten) and Apache-2.0 (USD BRep) texts |

The WebAssembly contains "Open CASCADE Topology" banners: they belong to smlibwasm's `.brep`
file-format reader and writer, not to OpenCASCADE code.

## Build and release

```sh
cd packages/exact-kernel
npm run build        # dist/ (esbuild; tooling and smlibwasm, checked against its pins, come from the lab's root install)
npm test             # builds, then the four test files above
npm run typecheck
npm pack             # crispcad-exact-kernel-<version>.tgz (prepack rebuilds)
npm run release      # the release tarball, on smlibwasm built from source (below)
```

Release: `npm run release` (`scripts/release.sh`) builds smlibwasm from source
(`scripts/build-smlibwasm.sh`, or an earlier build's tree in `SMLIBWASM_BUILD`), checks every
file of it against the sha256 pinned in `BUILD-PROVENANCE.json` and against the npm package
`@classcad/smlibwasm@0.6.2` (integrity and files), builds, tests and packs this package on it,
and prints the tarball's SHA-256 and integrity; it stops on any difference. Tag
`exact-kernel-v<version>` and attach the tarball to a GitHub release with those. Do not publish
to npm. The package depends on nothing: `BUILD-PROVENANCE.json` (shipped) records the sources,
the Emscripten SDK and the hashes of the smlibwasm build it bundles ([BUILD-WASM.md](BUILD-WASM.md)).

## Provenance

The interface and SMLib adapter come from CrispCAD's `experiments/exact-kernel` (same author,
relicensed MIT here); mass properties, path profiles, loft, sweep and STL follow the lab's
native SMLib backend (`src/kernel/backends/smlib/smlibBackend.ts`,
`src/modeling/backends/smlib/nativeLowerer.ts`). The lab's `smlib-native` backend does not use
this package yet; it could build its feature lowering on `ExactKernel` later.
