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
  loading (2026-11-25, `experiments/kernel-qualification/catalogCoverage.ts`,
  results in `results-catalog-native.json`): **2391 (99.5%)** built without an
  error. The 11 that did not: 3 sweep along curved rails; 2 drill holes on side
  faces; 1 has a multi-loop sketch; 1 lofts sections on non-XY planes; 4 hit an
  SMLib extrude error (`SM_ERR` x3, `SM_ERR_NULL_POINTER` x1). No model crashed the
  process and none reached for OpenCASCADE. Before mated assemblies were native
  (previous run, same harness) the count was 2356; the difference is exactly the
  35 mated models. This counts successful builds; the geometry was compared with
  OCCT on the samples below.

  ```sh
  node --import tsx experiments/kernel-qualification/catalogCoverage.ts --jobs 4 \
    --json experiments/kernel-qualification/results-catalog-native.json
  ```

  Each worker loads `blockOcct.mjs`, a Node resolve hook that throws on any import
  of `replicad-opencascadejs`.
- On 74 catalog models built by both kernels, the volume difference had a median of
  2.5e-16 relative and a maximum of 3.1e-4 (a boulder cluster of spheres); the
  native build was faster (15.3 s against 21 s in total).
- Kernel selection for the 27 parts, with timings, against WASMLib:
  `experiments/kernel-qualification/`.

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
even-odd; self-touching polygon outlines are split into simple loops) with extrude /
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
in and out) on SMLib. 0.1.1 makes `bbox` exact, `convexHull` robust for long multi-section
lofts (exact-planarity face merging, 1024-point budget) and splits non-planar polyhedron
faces; see its README. A draft upstream report for the two smlibwasm problems found on the
way (rotated-sphere `bbox`, hole-first `xor`) is in
[smlibwasm-upstream-report.md](smlibwasm-upstream-report.md); it has not been sent. It prebundles `@classcad/smlibwasm` 0.6.2 with its font module
replaced by an empty one, so the release tarball contains only MIT and Apache-2.0
files; its licence test checks the packed tarball. Its tests build the 27 reference
parts above through the interface at 1e-6 (worst relative volume error 2.5e-15,
area 1.2e-11). Build and test it with `npm run test:exact-kernel`; releases are
GitHub release tarballs on `exact-kernel-v*` tags, never npm.

The lab's own `smlib-native` backend (`src/modeling/backends/smlib/`) does not use
the package yet. Its feature lowering could move onto `ExactKernel` later; the
package already carries the operations that lowering needs except holes, patterns
and assemblies, which compose from them.
