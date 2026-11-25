# Repo conventions for agents working in the CrispCAD kernel lab

The CrispCAD kernel lab (`crispcad-kernel-lab`) is a renamed fork of kernelCAD (MIT). It builds
the exact kernel consumed by [CrispCAD](https://github.com/CrispStrobe/CrispCAD). Read [AGENTS.md](AGENTS.md).

## No deployment

The lab has no hosted app, website, MCP gateway or npm release pipeline. Never
deploy or publish. Upstream workflows are archived inactive in
`ci/upstream-workflows/`; run checks locally (`npm run typecheck`, `npm test`,
`npm run lint`, `npm run licence:audit`).

## Licence policy

Runtime dependencies, including their transitive, native and WASM closure, must be
MIT/Apache/BSD-like. LGPL/GPL components are being removed (OpenCASCADE, libvips);
do not add new ones. `npm run licence:audit` must not report new findings.

## Naming

Use "CrispCAD kernel lab" for this project and `crispcad-lab` for the CLI (`crispcad` is a
deprecated alias; the npm package name stays `crispcad`). "CrispCAD" alone means the
downstream workbench repository. Name kernelCAD
only to state provenance or `.kcad.ts` format compatibility. Keep upstream copyright
lines, attribution records and catalog provenance verbatim.

## CAD authoring discipline

For any task that creates or modifies CAD output, use the bundled
CrispCAD skill (`skills/kernelcad-*`) first and load `kernelcad-authoring` before editing a
`.kcad.ts` model. The source file is the design source of truth; generated
PNG/MP4/STEP/STL/score artifacts are evidence or deliverables, not files to
hand-edit.

Adopt this loop:

1. Classify the job and write down the engineering intent before coding.
2. Plan the `.kcad.ts` source, parameters, imports, explicit output artifacts,
   and verification commands.
3. Edit source and provenance only.
4. Generate named targets only; do not refresh whole artifact directories unless
   the task is explicitly a release/demo rebuild.
5. Validate with deterministic commands before relying on screenshots.
6. If a rendered artifact is produced, inspect it visually and report concrete
   visible evidence. Do not mark visually broken CAD done because tests passed.
7. When visual evidence matters, run `crispcad-lab render inspect <file> <outDir>`
   to produce a deterministic inspection bundle with a manifest and canonical
   RGB views. Add `--channels rgb,mask,depth,normals` when machine-readable
   object masks, depth, or view-space normals are needed. Use `--focus <names>`
   or `--hide <names>` to isolate feature ids or assembly part names when
   clutter would obscure the check. Keep richer channels in the same manifest
   packet; do not replace the canonical RGB views.

Prefer `lib.fromSTEP(...)` for real purchased components such as servos,
bearings, motors, fasteners, sensors, PCBs, and connectors. Hand-modeled
placeholder boxes/cylinders are acceptable for blockouts, but final review must
either replace them with vendor/catalog geometry or label the limitation.

## Quality ratchet

`scripts/lib/qualityBaseline.json` and `scripts/lib/cycleBaseline.json` may only
shrink over time; a value going back up (even to an old baselined value) fails CI.
After reducing findings or cycles, run `npx tsx scripts/qualityBaselineRegen.ts`
to regenerate both baselines — it refuses to write (exit 1) if any finding is new
or grew, unless you pass `--allow-new`. `eslint.config.js` also enforces a
one-way import layering (shared -> kernel -> modeling -> kinematic -> agent ->
studio); a `no-restricted-imports`/`no-restricted-syntax` error there means you
imported from a higher layer — move the code down or add it to that block's
allowlist with a follow-up ticket, don't silence the rule.
