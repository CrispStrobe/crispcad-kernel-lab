// SPDX-License-Identifier: MIT
// Copyright (c) 2026 CrispCAD contributors
//
// bbox() against closed forms for rotated primitives. SMLib's own tight box misses interior
// extremes of rotated spheres (Sphere(62) turned 11 degrees about X: min z -60.861, not -62);
// the package's box must match the closed forms to 1e-9 relative to the size.
import { beforeAll, describe, expect, it } from 'vitest';
import { createSmlibKernel, type BoundingBox, type ExactKernel, type ExactSolid, type Vec3 } from '../dist/index.js';

let k: ExactKernel;
beforeAll(async () => { k = await createSmlibKernel(); });

type M = [Vec3, Vec3, Vec3];
/** Rotation matrix (rows) for `degrees` about the unit `axis` (right-handed, as k.rotate). */
function rotation(axis: Vec3, degrees: number): M {
  const l = Math.hypot(...axis), [x, y, z] = axis.map(v => v / l), t = (degrees * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t), C = 1 - c;
  return [[c + x * x * C, x * y * C - z * s, x * z * C + y * s], [y * x * C + z * s, c + y * y * C, y * z * C - x * s], [z * x * C - y * s, z * y * C + x * s, c + z * z * C]];
}
const apply = (m: M, v: Vec3): Vec3 => [0, 1, 2].map(i => m[i][0] * v[0] + m[i][1] * v[1] + m[i][2] * v[2]) as Vec3;
const box = (centre: Vec3, half: Vec3): BoundingBox => ({ min: centre.map((c, i) => c - half[i]) as Vec3, max: centre.map((c, i) => c + half[i]) as Vec3 });
const unionBox = (a: BoundingBox, b: BoundingBox): BoundingBox => ({ min: a.min.map((v, i) => Math.min(v, b.min[i])) as Vec3, max: a.max.map((v, i) => Math.max(v, b.max[i])) as Vec3 });
/** Box of a circle: centre c, unit normal n, radius r. */
const circleBox = (c: Vec3, n: Vec3, r: number) => box(c, n.map(ni => r * Math.sqrt(Math.max(0, 1 - ni * ni))) as Vec3);

function expectBox(s: ExactSolid, want: BoundingBox, tol = 1e-9) {
  try {
    const got = k.bbox(s), size = Math.hypot(...want.max.map((v, i) => v - want.min[i]));
    for (let i = 0; i < 3; i++) {
      expect(Math.abs(got.min[i] - want.min[i]), `min[${i}] ${got.min[i]} vs ${want.min[i]}`).toBeLessThanOrEqual(tol * size);
      expect(Math.abs(got.max[i] - want.max[i]), `max[${i}] ${got.max[i]} vs ${want.max[i]}`).toBeLessThanOrEqual(tol * size);
    }
  } finally { s.dispose(); }
}

const turns: [Vec3, number][] = [[[1, 0, 0], 11], [[1, 0, 0], 37], [[0, 1, 0], 73], [[1, 2, 3], 29], [[-2, 1, 0.5], 131], [[0, 0, 1], 45]];

describe('bbox of rotated primitives (closed forms)', () => {
  it('Sphere(62).rotate(X, 11): the upstream repro', () => {
    expectBox(k.scope(() => k.rotate(k.sphere(62), [1, 0, 0], 11)), box([0, 0, 0], [62, 62, 62]));
  });
  for (const [axis, deg] of turns) {
    it(`sphere, off-centre, turned ${deg} deg about [${axis}]`, () => {
      const c = apply(rotation(axis, deg), [7, -3, 11]);
      expectBox(k.scope(() => k.rotate(k.translate(k.sphere(25), [7, -3, 11]), axis, deg)), box(c, [25, 25, 25]));
    });
    it(`torus (R 40, r 10) turned ${deg} deg about [${axis}]`, () => {
      const m = rotation(axis, deg), a = apply(m, [0, 0, 1]), c = apply(m, [5, 6, -7]);
      expectBox(k.scope(() => k.rotate(k.translate(k.torus(40, 10), [5, 6, -7]), axis, deg)), box(c, a.map(ai => 40 * Math.sqrt(1 - ai * ai) + 10) as Vec3));
    });
    it(`cylinder (r 10, h 50) turned ${deg} deg about [${axis}]`, () => {
      const m = rotation(axis, deg), a = apply(m, [0, 0, 1]);
      expectBox(k.scope(() => k.rotate(k.cylinder(10, 50), axis, deg)), unionBox(circleBox(apply(m, [0, 0, -25]), a, 10), circleBox(apply(m, [0, 0, 25]), a, 10)));
    });
    it(`cone (r 20 -> 5, h 30) turned ${deg} deg about [${axis}]`, () => {
      const m = rotation(axis, deg), a = apply(m, [0, 0, 1]);
      expectBox(k.scope(() => k.rotate(k.cone(20, 5, 30), axis, deg)), unionBox(circleBox(apply(m, [0, 0, -15]), a, 20), circleBox(apply(m, [0, 0, 15]), a, 5)));
    });
    it(`ellipsoid (sphere scaled 1, 1, 0.5) turned ${deg} deg about [${axis}]`, () => {
      const m = rotation(axis, deg), semi = [62, 62, 31];
      const half = [0, 1, 2].map(i => Math.sqrt(m[i].reduce((s, q, j) => s + q * q * semi[j] * semi[j], 0))) as Vec3;
      expectBox(k.scope(() => k.rotate(k.scale(k.sphere(62), [1, 1, 0.5]), axis, deg)), box([0, 0, 0], half), 1e-7);
    });
  }
  it('a hemisphere (a trimmed sphere face) turned 11 deg about X', () => {
    // Lower half (z <= 0) of a sphere r 62, turned 11 deg about X: min z and max y are interior
    // points of the bowl; min y and max z lie on the rim circle.
    const c = Math.cos((11 * Math.PI) / 180), s = Math.sin((11 * Math.PI) / 180);
    expectBox(k.scope(() => {
      const [above, below] = k.splitByPlane(k.sphere(62), [0, 0, 1], 0);
      above.dispose();
      return k.rotate(below, [1, 0, 0], 11);
    }), { min: [-62, -62 * c, -62], max: [62, 62, 62 * s] });
  });
});
