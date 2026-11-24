# Geometry kernels

CrispCAD records every model as a feature graph (`FeatureRecord[]`) and lowers it
through a kernel chosen per run. Three kernel ids exist:

| id | geometry | licence of the kernel binary | status |
|---|---|---|---|
| `occt` | OpenCASCADE via replicad (`replicad-opencascadejs`) | LGPL-2.1 with OCCT exception | default; every feature and tool |
| `smlib` | upstream's guarded SMLib mode, checked against OCCT | needs OCCT too | upstream behaviour, unchanged |
| `smlib-native` | SMLib via `@classcad/smlibwasm` | Apache-2.0 (SMLib) + MIT (bindings) | builds without OpenCASCADE |

## Selecting a kernel

- CLI: `crispcad --kernel smlib-native <command> ...` (the option goes before the command).
- Environment: `CRISPCAD_KERNEL=smlib-native` (CLI, MCP server, library calls).
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
  loading (2026-11-24, `experiments/kernel-qualification/catalogCoverage.ts`,
  results in `results-catalog-native.json`): **2356 (98.1%)** built without an
  error. Of the 46 that did not: 35 use mates; 3 sweep along curved rails; 2 drill
  holes on side faces; 1 has a multi-loop sketch; 1 lofts sections on non-XY planes;
  4 hit an SMLib extrude error (`SM_ERR` x3, `SM_ERR_NULL_POINTER` x1). No model
  crashed the process and none reached for OpenCASCADE. This counts successful
  builds; the geometry was compared with OCCT on the sample below.

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

## What still needs `occt`

`smlib-native` covers primitives, booleans, transforms, sketches with extrude /
revolve / loft / sweep, fillet and chamfer on all edges, shell, holes on the
canonical top and bottom faces, linear / circular / grid patterns, mirror, and
assemblies without mates. It exports STEP and STL. It does not yet cover:

- topology selectors (named faces and edges beyond the canonical ones), draft,
  text, threads and other OCCT-specific features;
- mates and the assembly solver, kinematics, drawings, exploded views, sheet-metal
  flat patterns and STEP import;
- export formats other than STEP and STL (3MF, GLB, OBJ, PLY, USD, DXF, drawings).

About 45 call sites in tools still construct the OCCT lowerer directly; they move to
`createLowerer(kernel)` as each feature gains a native lowering. The default stays
`occt` until the native kernel covers the catalog and these tools, after which
`replicad-opencascadejs` can become optional and then be removed, clearing the last
entry in `scripts/lib/licenceBaseline.json`.
