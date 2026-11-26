# Upstream report for @classcad/smlibwasm

Status: **filed 2026-11-26**, after both problems were re-checked on `@classcad/smlibwasm` 0.6.2
(the latest on npm) with standalone scripts against the npm package:

- `bbox()` of a rotated sphere: <https://github.com/NVIDIA-Omniverse/usd-brep/issues/75>.
  smlibwasm's `Part.bbox()` calls `SmApiBrepBoundingBox(bTight = TRUE)`, i.e. SMLib's
  `SmFace::CalculateTightBoundingBox`, which smlibwasm does not patch; the kernel (usd-brep) owns it.
- `xor(hole, outer)`: <https://github.com/awv-informatik/smlibpy/issues/45>. smlibwasm's
  `Sketch.xor` runs its own planar-Boolean route (rebuilt operands, fallbacks) on the kernel's
  `Boolean2D`, so it is filed with smlibwasm (its npm `bugs` URL is the smlibpy tracker).

Both problems are worked around in `@crispcad/exact-kernel` 0.1.1 and the lab's `smlib-native`
backend; the repros use smlibwasm alone. The texts below are the drafts; the filed issues use the
same repros (the xor one with a smaller square-in-square case, which does show the problem when
the clockwise square comes first).

---

## `bbox()` of a rotated sphere misses the sphere's extreme points

**Version:** `@classcad/smlibwasm` 0.6.2 (Node 26.4, macOS arm64).

`Part.bbox()` (and `Face.bbox()` of the sphere face) is too small for a sphere turned by some
angles: it seems to take the extremes of the face's boundary (the poles and the seam) without
the interior points where the surface normal is parallel to an axis. Volume and area are right.

```js
import { Sphere, Axis } from '@classcad/smlibwasm';

Sphere(62).rotate(Axis.X, 11).bbox();
// BoundBox(min=(-62, -62, -60.8609), max=(62, 62, 62))   expected min z = -62
Sphere(62).rotate(Axis.X, 11).faces()[0].bbox();
// same

for (const deg of [0, 5, 11, 30, 45, 60, 90]) console.log(deg, Sphere(62).rotate(Axis.X, deg).bbox().min.z);
// 0 -62 | 5 -61.764071 | 11 -60.860885 | 30 -62 | 45 -62 | 60 -62 | 90 -62
```

-60.860885 is 62·cos(11°), the z of the turned south pole. Expected: any rotation of a sphere
about its centre has the box centre ± r. A box can be too large without harm, but one inside the
body is wrong. In CrispCAD's catalog cross-check this affected 59 parts (fruit spheres on a tilted
crate, a scaled sphere on a sloped desk) by up to 3.3 mm.

**Workaround used:** our box is the union of points on the body: vertices, line ends, analytic
circle extremes, the sphere's centre ± r·eᵢ and the torus' centre ± R·w ± r·eᵢ where those lie on
the face (`face.distanceTo`), and sampled and refined extremes of other curves and faces, skipped
where the NURBS control net lies inside the box so far.

---

## `xor(hole, outer)` of polygons can give a solid with inverted faces

**Version:** `@classcad/smlibwasm` 0.6.2.

The symmetric difference of an outer polygon and a clockwise polygon inside it, with the hole
as the first argument, extrudes to a solid with the right volume, negative area, and
`isValid()` true. With the outer region first, or the hole counter-clockwise, it is right.

```js
import { Polygon, xor, extrude } from '@classcad/smlibwasm';

const outer = () => Polygon([-420, 860], [420, 860], [400, 1880], [-400, 1880], [-400, 1820]);
const hole = () => Polygon([340, 1820], [360, 920], [-360, 920], [-360, 1820]); // clockwise

const a = extrude(xor(outer(), hole()), 30);
a.volume, a.area, a.isValid(); // 5904000, 600618.797, true
const b = extrude(xor(hole(), outer()), 30);
b.volume, b.area, b.isValid(); // 5904000, -186581.203, true   expected area 600618.797
```

Expected: `xor` is symmetric, and a solid with a negative area is not valid. A clockwise square
inside a 10 × 10 square, first, shows it too: extruded by 1, area -64 instead of 192.

**Workaround used:** regions are passed to `xor` largest first.
