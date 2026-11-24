# Exact-kernel qualification without OpenCASCADE

Builds the 27 analytic reference parts (`assets/reference-parts/scorecard.json`)
natively in a candidate B-rep kernel and compares the kernel's own volume, area and
bounding box with the scorecard at its tolerances (1e-6 relative; 1e-8 for the
fillet and chamfer parts; 0.05 mm bbox). OpenCASCADE is not loaded.

```sh
node experiments/kernel-qualification/run.mjs smlibwasm --json results-smlibwasm.json
WASMLIB_DIR=/path/to/WASMLib node experiments/kernel-qualification/run.mjs wasmlib --json results-wasmlib.json
```

## Results (2026-11-24, Linux x64 container, Node 24.22.2)

| Kernel | Licence | Reference parts | Build time, 27 parts | 48-hole plate | Filleted + shelled box |
| --- | --- | --- | --- | --- | --- |
| `@classcad/smlibwasm` 0.6.2 | MIT, Apache-2.0 (SMLib), OFL-1.1 (fonts) | **27/27**, errors ≤ 3e-15 (one area 1e-11) | 1.1–1.5 s | 0.7–0.8 s | 0.6 s |
| WASMLib `c7abc5d` | Apache-2.0 | **27/27**, errors ≤ 1e-10 (sphere 8e-9) | 2.0–3.0 s | 0.7–1.0 s | 0.6–1.2 s |

Both kernels agree on the stress cases to 1e-11 (36 984.071 mm³ and 14 950.678 mm³).
WASMLib needed non-default arguments: the sphere's volume fails (`SM_ERR`) at 1e-10
accuracy and succeeds at 1e-8; `SmApiShellBrepFull` fails or **silently returns the
unshelled solid** unless both `bDoExtendedOffset` and `bDoSelfInt` are set. smlibwasm
needed no special arguments.

## Decision

CrispCAD's exact kernel is **SMLib through `@classcad/smlibwasm`**. Both candidates
run NVIDIA's Apache-2.0 SMLib core and pass the scorecard; smlibwasm additionally
reads and writes STEP (WASMLib writes only), has a high-level modeling API close to
CrispCAD's own operations (sketches, extrude/revolve/loft/sweep, fillet/chamfer/shell,
locations), is a pinned npm dependency already, and behaved correctly with default
arguments. WASMLib's SMLib fixes (speed, fillet edge cases, screw sweeps for threads)
are candidates to adopt later, as patches or for specific operations.

These are local Node measurements on synthetic parts, not deployed or hardware
acceptance; timings vary run to run (both columns show the observed range).
