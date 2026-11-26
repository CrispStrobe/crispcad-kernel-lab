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
  loading (2026-11-26, commit `763f97d2d`, `experiments/kernel-qualification/catalogCoverage.ts`,
  results in `results-catalog-native.json`): **2402 (100%)** built without an error,
  70,745 parts. No model crashed the process and none reached for OpenCASCADE. Build time at
  `6005ce246`: median 0.09 s per model, 19 min of build time over 4 workers (9.3 min wall) on an
  M1 shared with other sessions; the slowest, `fire-rescue/quint-fire-apparatus` (210 parts),
  took 3.6 min. (The `763f97d2d` run took 2.7 h wall, median 1.3 s per model, on the same
  machine at a load average of 250 to 500 from other sessions; its times say nothing about the
  kernel.) Per-model volume, area and box (sum and union over the parts at their world
  placements, exact `boundingBox()`) are in `results-catalog-native-volumes.json`, in the
  input format of CrispCAD's catalog cross-check (`--native`; `labCommit` is the commit the
  run was taken at).

  Two changes since the 2394/2402 run at `e203019d8`. `ef07c30bf` corrected the eight models
  whose outlines crossed themselves (see "Outlines that cross themselves" below; the commit
  message lists each edit): every part of them is valid by BRepCheck in OpenCASCADE, and the
  native and OCCT volumes agree part by part to 2.4e-11. `6005ce246` lofts single-loop
  sections through their outlines as drawn (see "Ruled lofts" below), which changed 17 models;
  the other 2385 have the same volume and area (to 2.5e-15) as before. `88eeb9123` pairs loft
  sections as OCCT's ThruSections does ("How OCCT pairs sections" below), which changed 34
  models, every one of them now within 5.7e-10 of OCCT part by part (31 within 8e-15) except the
  three wind turbines, whose smooth lofts are unchanged; the other 2368 have the same volume (to
  9.4e-16) and area (to 2.0e-15) as before.

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
  sliver walls (OCCT keeps them as zero-thickness fins). `nature/rock-arch` differed by up to 6.8e-4 per part, in its XY legs
  as much as in its YZ span (its ruled lofts between rotated 7-gons were paired differently;
  they agree since the pairing below). One model,
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
outline as drawn and lofts go through those outlines.

### How OCCT pairs sections

Drawn order is not the whole rule. Before it lofts, `BRepOffsetAPI_ThruSections` passes its wires
through `BRepFill_CompatibleWires` (read in OCCT 7.8.1, 7.9.3 and 8.0.1, the version
`replicad-opencascadejs` 0.25.1 is built from: the algorithm is the same in all three, 8.0 only
renamed types). It is LGPL, so it was read to learn the rule and nothing was copied;
`src/modeling/backends/smlib/compatibleSections.ts` implements the rule from this description.

**Equal edge counts** (and a corner somewhere, so not every joint is smooth): `ComputeOrigin`.
Each section after the first is moved in the first section's plane so its centre lies over the
previous section's centre, and then starts at the vertex, and runs in the direction, that make
the summed distances from the previous (already re-started) section's vertices to its own
smallest: start vertices in outline order, forward tried before backward, the first strict
minimum wins. The centre is that of the outline as a curve (for a polygon, the edge midpoints
weighted by edge length), not the area centroid.

**Different edge counts** (on closed sections): the "polar method", `SameNumberByPolarMethod`,
not a split by arc length. A vertex v of section i is carried to section j along a ray from j's
centre in the direction of v from i's centre (rotated between the two planes when they are not
parallel, as OCCT's `Transform` does). The ray is as long as the diagonal of j's bounding box;
its hit is the point of j's outline nearest to the ray (BRepExtrema's minimum distance, ties
within 1e-7), and of several hits the one nearest to centre(j) + (v − centre(i)).

- A hit within 1e-7 of a vertex of j is that vertex.
- A hit inside an edge closer to one of its ends than 10 % of the edge's length (`myPercent` =
  0.1 of the edge's parameter range, which for a line is its length) snaps to that end, unless
  the end is already the image of another vertex; then the edge is split exactly at the hit.
  The 10 % is of the edge as it is at that moment: an edge split before is shorter.
- Otherwise the edge is split at the hit, a new vertex.

The passes: backward, for i from the last section down to the second, every vertex of section i
(in outline order, including the ones inserted into it the step before) is carried down to
section i − 1, which changes after each vertex; so the first section collects the images of
every vertex of every section. Chains then run from each vertex of the first section upward
through the vertices whose images they are. Forward, for i from the first section to the last
but one, each vertex of section i whose chain has no vertex in section i + 1 yet (the first
section's own vertices, and those just inserted) is carried up to section i + 1, snapping only
to vertices in no chain, and the hit joins its chain. Finally each section is walked from the
chain member of the first section's first vertex towards that of its second, so vertex k of
every section is one chain, and the ruled faces join them.

Which edges are split, and how often, follows from that: an edge is split once for every ray
from another section that crosses its inner 80 %, and a ray near its ends reuses the end unless
that end is taken. An octagon lofted to a 16-point star gets the star's inner vertices as edge
midpoints; a hexagon lofted to a diamond becomes an octagon with vertices at 0, 60, 90, 120, 180,
−120, −90, −60 degrees and the diamond gets the same eight directions. Nothing in it depends on
anything the native kernel lacks: it needs the polygon's vertices, centres and normals, and
segment distances. Curved section edges (arcs, splines) are not handled: the native lowering
applies the rule only when every section is a single loop of straight edges, which covers the
catalog's ruled lofts.

### Native lowering and `@crispcad/exact-kernel`

`smlib-native` applies both rules to every loft (ruled or smooth) whose sections are all
single straight-edged loops, and builds the sections as wires of lines in the matched order. The
package does the same for `profile.path` sections of lines and one-contour `profile.polygon`
sections (0.1.5, `compatible-sections.ts`, a copy). Per part against OCCT
(`experiments/kernel-qualification/partVolumes.ts`, which builds a model on both kernels and
prints the volumes part by part):

| model | parts that differed | before (6005ce246) | now |
|---|---|---|---|
| `farm-machinery/corn-header` | 9 snouts | −4.5e-3, −4.2e-3 | 2.9e-15 |
| `nature/lily-pads` | 2 petal crowns (8-gon to 16-point star) | −1.3e-2 | 4.9e-16 |
| `props/watering-can` | rose (6-gon to 8-gon) | −8.8e-3 | 1.4e-10 |
| `terrain/cave-entrance` | 3 boulders (hexagon to diamond) | −3.1e-2 | −1.5e-10 |
| `terrain/cliff-corner-tile` | 3 boulders (6-gon to pentagon) | −4.2e-3, −8.6e-2, −3.6e-1 | −8.9e-16 |
| `terrain/cliff-wall-tile` | 3 boulders | −4.2e-3, −8.6e-2, −3.6e-1 | 3.9e-16 |
| `terrain/lava-tile` | island | −2.6e-2 | −5.9e-16 |
| `terrain/ramp-tile` | 3 rocks | −9.4e-3 to −8.0e-3 | −4.0e-15 |
| `terrain/sand-tile` | dune, 3 pebbles | −2.0e-2 to −2.1e-3 | −3.8e-16 |
| `terrain/shore-edge-tile` | 2 rocks | +1.0e-2, +5.5e-3 | 4.6e-16 |
| `terrain/snow-tile` | drift, 2 rocks | −2.0e-2 to +6.2e-4 | 4.5e-16 |
| `terrain/waterfall-tile` | 4 foam pads | −3.2e-2 | −1.2e-15 |
| `nature/hill-tile` | grass, outcrop | −5.0e-4, −2.2e-3 | −4.6e-16 |
| `nature/rock-arch` | legs, span | up to 6.8e-4 | 2.8e-16 |
| 20 more models (below) | lofts between equal sections re-started by OCCT | model 2.7e-5 to 4.7e-3 low | 5.7e-10 |
| `wind-energy/horizontal-axis-wind-turbine` | 3 blades, 3 tips | −5.8e-3, +4.3e-4 | unchanged |
| `wind-energy/offshore-wind-turbine` | 3 blades, 3 tips | −6.0e-3, +3.7e-4 | unchanged |
| `wind-energy/wind-turbine-blade` | blade, tip band | −4.5e-2, +9.6e-4 | unchanged |

(The relative difference of the worst part; "now" is the largest over all parts of the model.
The two at 1.5e-10 union or subtract the loft with other solids.) The 20 more models changed in
the full catalog run, all through ComputeOrigin (equal vertex counts, OCCT starting the
sections at another vertex than the drawn one), and match OCCT now to 7.7e-15, `props/scarecrow`
to 5.7e-10: `interior/hanging-planter` (model volume 3.2e-3 low before), `nature/bird-nest`,
`bonsai-tree`, `boulder-cluster`, `bramble`, `cairn`, `pebble-cluster`, `rock-pillar`, `rock`,
`snowy-fir-tree`, `stone-slab`, `termite-mound`, `tumbleweed` (4.7e-3), `props/sack`,
`scarecrow`, `trash-bags`, `terrain/mountain-peak`, `river-bend-tile` (1.2e-3),
`rocky-ground-tile` and `ruins-column-tile` (2.7e-5 to 9.7e-4 low for the rest). hill-tile and rock-arch were
taken for OCCT measuring twisted ruled faces high; it was the pairing: OCCT re-starts their
sections (ComputeOrigin), and with the same start the volumes agree. The three wind-turbine
models loft airfoils of equal vertex counts smoothly: the pairing is the same as drawn, and the
difference is in the surfaces, which SMLib and OCCT skin differently (OCCT approximates one
B-spline surface through all sections).

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
profile outlines that cross themselves; 0.1.4 lofts path profiles vertex to vertex as drawn; 0.1.5 pairs loft sections as OCCT does and is built on smlibwasm compiled from source), `convexHull` robust for long multi-section
lofts (exact-planarity face merging, 1024-point budget) and splits non-planar polyhedron
faces; see its README. An upstream report for the two smlibwasm problems found on the
way (rotated-sphere `bbox`, hole-first `xor`) is in
[smlibwasm-upstream-report.md](smlibwasm-upstream-report.md); both are filed
(<https://github.com/NVIDIA-Omniverse/usd-brep/issues/75> for the box, which is SMLib's tight box,
and <https://github.com/awv-informatik/smlibpy/issues/45> for `xor`). It prebundles smlibwasm 0.6.2 (built from source, below) with its font module
replaced by an empty one, so the release tarball contains only MIT and Apache-2.0
files; its licence test checks the packed tarball. Its tests build the 27 reference
parts above through the interface at 1e-6 (worst relative volume error 2.5e-15,
area 1.2e-11). Build and test it with `npm run test:exact-kernel`; releases are
GitHub release tarballs on `exact-kernel-v*` tags, never npm.

Since 0.1.5 the release is built from source:
[`packages/exact-kernel/scripts/build-smlibwasm.sh`](../packages/exact-kernel/scripts/build-smlibwasm.sh)
builds smlibwasm 0.6.2 (the module, its loader and the JavaScript, with TypeScript 5.9.3) from smlibpy `v0.6.2` (`a6320aa2`, MIT: the embind bindings
in `js/cpp`, the build files and a few patched kernel files) and usd-brep `c9c5979f`
(Apache-2.0: SMLib, SM_API, SmPyLib) with emsdk 6.0.12, the version smlibpy's release job uses,
and compares the result with the npm binary. On 2026-11-26 both `smlibwasm.wasm` and its loader
`smlibwasm.mjs` came out byte-identical to `@classcad/smlibwasm@0.6.2` (macOS arm64 host; the
published build ran on Ubuntu x86_64), so the binary the package bundles is reproducible from
permissively licensed source. The npm tarball's integrity also matches the digest in its signed
SLSA provenance, which names smlibpy's release workflow at tag v0.6.2. The whole package tree
(all 119 files but the font's licence) is byte-identical to the npm package, and
`BUILD-PROVENANCE.json` (shipped) pins each file's sha256; `scripts/release.sh` builds the release
on the source build and stops if it, the pins and the npm tarball ever differ. The package no
longer depends on `@classcad/smlibwasm`. [BUILD-WASM.md](../packages/exact-kernel/BUILD-WASM.md) has the pins,
the licences of everything compiled, and the disk the SDK needs.

The lab's own `smlib-native` backend (`src/modeling/backends/smlib/`) does not use
the package yet. Its feature lowering could move onto `ExactKernel` later; the
package already carries the operations that lowering needs except holes, patterns
and assemblies, which compose from them.
