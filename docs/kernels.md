# Geometry kernels

The CrispCAD kernel lab records every model as a feature graph (`FeatureRecord[]`) and lowers it
through a kernel chosen per run. Three kernel ids exist:

| id | geometry | licence of the kernel binary | status |
|---|---|---|---|
| `occt` | OpenCASCADE via replicad (`replicad-opencascadejs`) | LGPL-2.1 with OCCT exception | default; every feature and tool |
| `smlib` | upstream's guarded SMLib mode, checked against OCCT | needs OCCT too | upstream behaviour, unchanged |
| `smlib-native` | SMLib via `@classcad/smlibwasm` | Apache-2.0 (SMLib) + MIT (bindings) | builds without OpenCASCADE |

## Selecting a kernel

- CLI: `crispcad-lab --kernel smlib-native <command> ...` (the option goes before the command).
- Environment: `CRISPCAD_LAB_KERNEL=smlib-native` (CLI, MCP server, library calls);
  the older `CRISPCAD_KERNEL` is still read, and `CRISPCAD_LAB_KERNEL` wins when both are set.
- Library: `buildModel({ code, fileName, kernel: 'smlib-native' })`.

An unknown or unavailable id is an error (`recompute.kernel.unavailable`); nothing
silently falls back to another kernel. When the selected kernel cannot lower a
feature it reports `recompute.kernel.unsupported-feature` for that feature.

OpenCASCADE is imported lazily: with `smlib-native` selected the CLI's `evaluate`,
`validate`, `export`, `parts`, `dfm`, `interference` and the MCP script runner never
load `replicad-opencascadejs`. This was checked with a Node resolve hook that
rejects any import of OpenCASCADE: native runs succeed, the same commands on
`occt` fail at the hook.

## Qualification

- The 27 analytic reference parts (`assets/reference-parts/scorecard.json`) build
  on `smlib-native` within the scorecard tolerances
  (`src/modeling/backends/smlib/nativeLowerer.test.ts`).
- All 2402 catalog models, built on `smlib-native` with OpenCASCADE blocked from
  loading (2026-11-26, commit `6005ce246`, `experiments/kernel-qualification/catalogCoverage.ts`,
  results in `results-catalog-native.json`): **2402 (100%)** built without an error,
  70,745 parts. No model crashed the process and none reached for OpenCASCADE. Build time:
  median 0.09 s per model, 19 min of build time over 4 workers (9.3 min wall) on an M1 shared
  with other sessions. The slowest, `fire-rescue/quint-fire-apparatus` (210 parts), took
  3.6 min. Per-model volume, area and box (sum and union over the parts at their world
  placements, exact `boundingBox()`) are in `results-catalog-native-volumes.json`, in the
  input format of CrispCAD's catalog cross-check (`--native`; `labCommit` is the commit the
  run was taken at).

  Two changes since the 2394/2402 run at `e203019d8`. `ef07c30bf` corrected the eight models
  whose outlines crossed themselves (see "Outlines that cross themselves" below; the commit
  message lists each edit): every part of them is valid by BRepCheck in OpenCASCADE, and the
  native and OCCT volumes agree part by part to 2.4e-11. `6005ce246` lofts single-loop
  sections through their outlines as drawn (see "Ruled lofts" below), which changed 17 models;
  the other 2385 have the same volume and area (to 2.5e-15) as before.

  ```sh
  node --import tsx experiments/kernel-qualification/catalogCoverage.ts --jobs 4 \
    --json experiments/kernel-qualification/results-catalog-native.json \
    --volumes experiments/kernel-qualification/results-catalog-native-volumes.json \
    --log /tmp/coverage.jsonl   # resumable: rerun with the same --log after an interruption
  ```

  In the 2026-11-25 run (2402 built), 11 models built for the first time. Of those 11, the seven without helical sweeps or the YZ loft agree with their OCCT
  builds to 1e-6 in volume, part by part, and the three helical-sweep models to 7.2e-6
  in total (`standard-components/beam-coupling`; the axial helix is a 48-section-per-turn
  loft here and a fitted spine there). The two self-touching outlines with a zero-width slit or a
  back-running edge lose those zero-area slivers, so their area is lower by the
  sliver walls (OCCT keeps them as zero-thickness fins). `nature/rock-arch` differs by up to 6.8e-4 per part, in its XY legs
  as much as in its YZ span: ruled lofts between rotated 7-gons are built differently
  by the two kernels (the same holds on XY before this change). One model,
  `hydroponics/hydroponic-grow-rack`, had lettuce heads lofted to a `startPoint` /
  `endPoint`, which the native loft ignored without an error (25 % short); it is now
  built as OCCT builds it.

  Each worker loads `blockOcct.mjs`, a Node resolve hook that throws on any import
  of `replicad-opencascadejs`.
- On 74 catalog models built by both kernels, the volume difference had a median of
  2.5e-16 relative and a maximum of 3.1e-4 (a boulder cluster of spheres); the
  native build was faster (15.3 s against 21 s in total).
- Kernel selection for the 27 parts, with timings, against WASMLib:
  `experiments/kernel-qualification/`.

## Outlines that cross themselves

A profile outline that crosses itself (a bow tie, a pentagram) bounds no region. OpenCASCADE
builds a face from it anyway: the extruded solid fails BRepCheck, and its volume is the
winding-weighted area, which is neither a nonzero nor an even-odd fill (the bow tie's two lobes
of opposite orientation subtract, a pentagram's centre counts twice). SMLib did the same, with
the sign of the volume following the orientation. For `alpine-expedition/alpine-helmet`'s chin
straps, a bow tie with lobes of 493 and 89 mm² extruded 14 mm, OCCT gives +5656 mm³ for both and
the native build gave -5656 and +5656 (summing to 0), both with area 4,376.8 mm²; a fill of
both lobes would be 8,148 mm³. Since there is no valid result to match, `smlib-native` and
`@crispcad/exact-kernel` 0.1.3 refuse such outlines (`recompute.lowering.exception`, with the
crossing point; `invalid-input` in the package). Outlines that only touch themselves (a shared
vertex, a vertex on another edge, an edge running back along another) still build. The check
is `src/modeling/backends/smlib/profileCrossing.ts`, a copy of the package's `outline.ts`.
The eight catalog models that had such outlines were corrected (`ef07c30bf`): the helmet's strap
vertices are now in band order, (112,66), (96,62), (4,6), (18,0), a 1008 mm² strap of
14,112 mm³; the other seven had arcs that overshot a straight edge, a swapped pair of points, or
a toe point below its base line.

## Ruled lofts

A ruled loft joins vertex i of one section to vertex i of the next. The native lowering used to
loft the sections' faces, and SMLib's `makeFace` may start a face's boundary at another vertex
than the first one drawn: a square drawn as 8 points (corners and edge midpoints, so
neighbouring edges run on collinearly) starts elsewhere. `nature/ground-tile` and
`nature/hill-tile` loft such a square "so it lofts to an octagon", ruled, and twisted through
their middle (grass 307.6e6 and 1059.6e6 mm³). Since `6005ce246` a single-loop sketch keeps its
outline as drawn and lofts go through those outlines, as OCCT's ThruSections does:
ground-tile's grass is 368,631,795 mm³, OCCT's to 3e-16; hill-tile's grass (1,569,800,667) and
outcrop are the exact ruled volumes (each section between two drawn ones has vertices
(1 − s) a_i + s b_i, so its area is quadratic in s) to 3e-16, where OCCT measures the twisted
ruled faces 5.0e-4 and 2.2e-3 high. `@crispcad/exact-kernel` 0.1.4 does the same for
`profile.path` sections. The change moved 15 more models by 2e-5 to 1.1e-2 in volume, all with lofts
whose start vertex now follows the drawing: mostly ruled lofts between sections with different
vertex counts (hexagon to diamond boulders, an 8-gon to a 16-point petal star, 6- or 7-gon to
pentagon rocks), some smooth (airfoil blades). Neither kernel pairs unequal sections the same
way (OCCT inserts vertices to equalise the counts; an insertion by arc length did not reproduce
its volumes), so these still differ from OCCT, before and after: some parts came closer
(boulders, foam and an island from 12–13 % to about 3 % low, the lily-pad petals from 8.2e-2 to
1.3e-2, the corn-header snouts from 1.0e-2 to 4.3e-3), some moved away (two cliff boulders from
4.6e-2 and 3.0e-1 to 8.6e-2 and 3.6e-1 low, small rocks by up to 2 %).

## Mated assemblies

The mate solver is kernel-agnostic: `mateFk` works on connector frames, mate types,
poses and the parts' `at` placements, never on B-rep geometry. `smlib-native`
therefore lowers a mated `assembly(...).model()` through the same
`lowerAssemblyModel` the OCCT lowerer uses, with the parts as SMLib solids. The only
geometric step in that path, resolving a topology-query connector on the part's
faces, is OCCT-only and is refused natively with
`recompute.kernel.unsupported-feature`. All 35 mated catalog models use numeric
connector origins and now build natively; across their 594 parts the world
transforms are identical to the OCCT build and part volumes agree to 8.7e-6
relative (`src/modeling/backends/smlib/nativeMates.test.ts` checks a revolute +
fastened chain against OCCT).

## What still needs `occt`

`smlib-native` covers primitives, booleans, transforms, sketches (several loops fill
even-odd; self-touching polygon outlines are split into simple loops; outlines that cross
themselves are refused, see below) with extrude /
revolve / loft (sections on XY, YZ or XZ; ruled lofts to a `startPoint` / `endPoint`) /
sweep (polyline rails, and `spine: 'helix'` axial or transverse about X, Y or Z), fillet and
chamfer on all edges, shell, holes on any canonical face (top, bottom, left, right, front,
back, in OCCT's (u, v) frame), linear / circular / grid patterns, mirror, and
`assembly(...).model()` with or without mates. Its bounding box is exact (SMLib's own box
misses extremes of rotated spheres). It exports STEP and STL. It does not yet cover:

- topology selectors (named faces and edges beyond the canonical ones), draft,
  text, threads and other OCCT-specific features;
- `spine: 'smooth'` sweeps, smooth lofts to an apex point, rotated loft sections, twisted
  or tapered extrusions, countersinks (each refused with `recompute.kernel.unsupported-feature`);
- connectors placed by a topology query (`'@kc[part/face/top#normal]'`), which need
  face and edge queries on the solid (numeric connector origins work);
  `solvedModel(poses)` / joint-tree assemblies, kinematics, drawings, exploded views,
  sheet-metal flat patterns and STEP import;
- export formats other than STEP and STL (3MF, GLB, OBJ, PLY, USD, DXF, drawings).

About 45 call sites in tools still construct the OCCT lowerer directly; they move to
`createLowerer(kernel)` as each feature gains a native lowering. The default stays
`occt` until the native kernel covers the catalog and these tools, after which
`replicad-opencascadejs` can become optional and then be removed, clearing the last
entry in `scripts/lib/licenceBaseline.json`.

## The exact-kernel package

[`packages/exact-kernel`](../packages/exact-kernel) (`@crispcad/exact-kernel`) is the
OpenCASCADE-free kernel that CrispCAD consumes: a narrow `ExactKernel` interface
(primitives, path profiles, extrude, revolve, loft, sweep, Booleans, transforms,
fillet, chamfer, shell, measures and mass properties, tessellation, STL and exact STEP
in and out) on SMLib. 0.1.1 makes `bbox` exact (0.1.2 makes it fast again on trimmed curved bodies; 0.1.3 refuses
profile outlines that cross themselves; 0.1.4 lofts path profiles vertex to vertex as drawn), `convexHull` robust for long multi-section
lofts (exact-planarity face merging, 1024-point budget) and splits non-planar polyhedron
faces; see its README. An upstream report for the two smlibwasm problems found on the
way (rotated-sphere `bbox`, hole-first `xor`) is in
[smlibwasm-upstream-report.md](smlibwasm-upstream-report.md); both are filed
(<https://github.com/NVIDIA-Omniverse/usd-brep/issues/75> for the box, which is SMLib's tight box,
and <https://github.com/awv-informatik/smlibpy/issues/45> for `xor`). It prebundles `@classcad/smlibwasm` 0.6.2 with its font module
replaced by an empty one, so the release tarball contains only MIT and Apache-2.0
files; its licence test checks the packed tarball. Its tests build the 27 reference
parts above through the interface at 1e-6 (worst relative volume error 2.5e-15,
area 1.2e-11). Build and test it with `npm run test:exact-kernel`; releases are
GitHub release tarballs on `exact-kernel-v*` tags, never npm.

The bundled WebAssembly can be rebuilt from source:
[`packages/exact-kernel/scripts/build-smlibwasm.sh`](../packages/exact-kernel/scripts/build-smlibwasm.sh)
builds smlibwasm 0.6.2's module from smlibpy `v0.6.2` (`a6320aa2`, MIT: the embind bindings
in `js/cpp`, the build files and a few patched kernel files) and usd-brep `c9c5979f`
(Apache-2.0: SMLib, SM_API, SmPyLib) with emsdk 6.0.12, the version smlibpy's release job uses,
and compares the result with the npm binary. On 2026-11-26 both `smlibwasm.wasm` and its loader
`smlibwasm.mjs` came out byte-identical to `@classcad/smlibwasm@0.6.2` (macOS arm64 host; the
published build ran on Ubuntu x86_64), so the binary the package bundles is reproducible from
permissively licensed source. The npm tarball's integrity also matches the digest in its signed
SLSA provenance, which names smlibpy's release workflow at tag v0.6.2. The release keeps
bundling the npm module; [BUILD-WASM.md](../packages/exact-kernel/BUILD-WASM.md) has the pins,
the licences of everything compiled, and the disk the SDK needs.

The lab's own `smlib-native` backend (`src/modeling/backends/smlib/`) does not use
the package yet. Its feature lowering could move onto `ExactKernel` later; the
package already carries the operations that lowering needs except holes, patterns
and assemblies, which compose from them.
