// SPDX-License-Identifier: MIT
// Copyright (c) 2026 CrispCAD contributors
//
// Faceted solids the way CrispCAD's CAD Script lowering builds them: a ruled loft of polygon
// sections becomes a polyhedron (side quads split into two triangles), and a convex one is
// rebuilt through `convexHull`. Coordinates are rounded to six decimals, as the kernelCAD
// converter writes them. Regressions from CrispCAD's catalog cross-check:
// - a hexagonal frustum (chandelier canopy) came out with twice its side area (hull kept two
//   near-identical planes per side as two overlapping faces) while its volume was right;
// - 4-section 10-gon lofts 1 m long (roller-a of postal-pallet-roller-deck, 437 catalog parts)
//   failed with "faces do not close" (hull merged slightly twisted side quads into non-planar
//   faces), while the same loft 30 mm long built.
import { beforeAll, describe, expect, it } from 'vitest';
import { convexHull, createSmlibKernel, ExactKernelError, isConvexPolyhedron, MAX_HULL_POINTS, planarFaces, type ExactKernel, type Vec3 } from '../dist/index.js';

let k: ExactKernel;
beforeAll(async () => { k = await createSmlibKernel(); });
const rel = (a: number, b: number) => Math.abs(a - b) / Math.abs(b);
const fmt = (v: number) => Number(v.toFixed(6));

/** A regular n-gon section at height z, first vertex at `phase` radians. */
const ngon = (r: number, n: number, z: number, phase = 0): Vec3[] => Array.from({ length: n }, (_, i) => {
  const a = phase + (2 * Math.PI * i) / n;
  return [fmt(r * Math.cos(a)), fmt(r * Math.sin(a)), fmt(z)];
});
/** CrispCAD's loftPolyhedron (packages/core/src/code-loft.ts) for counter-clockwise sections ordered along +z. */
function loftPolyhedron(sections: Vec3[][]) {
  const count = sections[0].length, points = sections.flat(), faces: number[][] = [Array.from({ length: count }, (_, i) => count - 1 - i)];
  for (let s = 0; s < sections.length - 1; s++) for (let j = 0; j < count; j++) {
    const a = s * count + j, b = s * count + ((j + 1) % count), c = b + count, d = a + count;
    faces.push([a, b, c], [a, c, d]);
  }
  faces.push(Array.from({ length: count }, (_, i) => points.length - count + i));
  return { points, faces };
}
/** CrispCAD's lowering of a CAD Script polyhedron (packages/exact/src/lower-cad-script.ts). */
function lowered(sections: Vec3[][]) {
  const { points, faces } = loftPolyhedron(sections);
  if (isConvexPolyhedron(points, faces)) { const hull = convexHull(points); return k.polyhedron(hull.points, hull.faces); }
  return k.polyhedron(points, faces);
}
/** Closed forms for a stack of similar, concentric regular n-gons (radii r at heights z). */
function closedForm(n: number, radii: number[], heights: number[]) {
  const A = (r: number) => (n / 2) * r * r * Math.sin((2 * Math.PI) / n), side = (r: number) => 2 * r * Math.sin(Math.PI / n), apo = (r: number) => r * Math.cos(Math.PI / n);
  let volume = 0, area = A(radii[0]) + A(radii.at(-1)!);
  for (let i = 0; i + 1 < radii.length; i++) {
    const h = heights[i + 1] - heights[i], a1 = A(radii[i]), a2 = A(radii[i + 1]);
    volume += (h / 3) * (a1 + a2 + Math.sqrt(a1 * a2));
    area += n * ((side(radii[i]) + side(radii[i + 1])) / 2) * Math.hypot(apo(radii[i + 1]) - apo(radii[i]), h);
  }
  return { volume, area };
}

describe('loft polyhedra (CrispCAD lowering) against closed forms', () => {
  it('hexagonal frustum (chandelier canopy): area no longer doubled', () => {
    const s = lowered([ngon(14, 6, 780), ngon(90, 6, 830)]);
    try {
      const want = closedForm(6, [14, 90], [780, 830]);
      expect(want.area).toBeCloseTo(47342.29, 2);
      expect(rel(k.volume(s), want.volume)).toBeLessThanOrEqual(1e-7);
      expect(rel(k.area(s), want.area)).toBeLessThanOrEqual(1e-7); // was 81,727 (+73 %)
      expect(k.isValid(s)).toBe(true);
    } finally { s.dispose(); }
  });

  // roller-a: loftCylinder(1080, 15.36, 10): levels 0, 7 %, 93 %, 100 %; radii 0.88 r, r, r, 0.88 r.
  for (const length of [30, 300, 1080, 3000, 10000]) for (const sides of [10, 12, 16]) {
    it(`4-section ${sides}-gon roller ${length} mm long builds with the closed-form volume and area`, () => {
      const r = 15.36, radii = [0.88 * r, r, r, 0.88 * r], heights = [0, 0.07 * length, 0.93 * length, length];
      const s = lowered(heights.map((z, i) => ngon(radii[i], sides, z, Math.PI / 2)));
      try {
        const want = closedForm(sides, radii, heights);
        expect(k.isValid(s)).toBe(true);
        expect(rel(k.volume(s), want.volume)).toBeLessThanOrEqual(1e-6);
        expect(rel(k.area(s), want.area)).toBeLessThanOrEqual(1e-6);
      } finally { s.dispose(); }
    });
  }

  it('a polyhedron with a non-planar face is split, not rejected', () => {
    const P: Vec3[] = [[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0], [0, 0, 10], [10, 0, 10], [10, 10, 10.001], [0, 10, 10]];
    const F = [[3, 2, 1, 0], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]];
    expect(planarFaces(P, F)).toHaveLength(7);
    const s = k.polyhedron(P, F);
    try {
      expect(k.isValid(s)).toBe(true);
      // Divergence theorem over the same triangles.
      const tris = planarFaces(P, F).flatMap(f => f.slice(1, -1).map((_, i) => [f[0], f[i + 1], f[i + 2]]));
      const v = tris.reduce((sum, [a, b, c]) => {
        const [p, q, w] = [P[a], P[b], P[c]];
        return sum + (p[0] * (q[1] * w[2] - q[2] * w[1]) - p[1] * (q[0] * w[2] - q[2] * w[0]) + p[2] * (q[0] * w[1] - q[1] * w[0])) / 6;
      }, 0);
      expect(rel(k.volume(s), v)).toBeLessThanOrEqual(1e-9);
    } finally { s.dispose(); }
  });
});

describe('convexHull', () => {
  const sphere = (count: number, radius: number) => {
    let seed = 7;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    return Array.from({ length: count }, (): Vec3 => { const z = 2 * rnd() - 1, t = 2 * Math.PI * rnd(), r = Math.sqrt(1 - z * z); return [radius * r * Math.cos(t), radius * r * Math.sin(t), radius * z]; });
  };
  it('gives closed, planar, convex faces sharing every edge twice', () => {
    const hull = convexHull(sphere(300, 40));
    expect(isConvexPolyhedron(hull.points, hull.faces)).toBe(true);
    const edges = new Map<string, number>();
    for (const f of hull.faces) f.forEach((a, i) => { const b = f[(i + 1) % f.length], key = `${a},${b}`; edges.set(key, (edges.get(key) ?? 0) + 1); });
    for (const [key, count] of edges) { expect(count).toBe(1); const [a, b] = key.split(','); expect(edges.get(`${b},${a}`)).toBe(1); }
    expect(hull.points.length - edges.size / 2 + hull.faces.length).toBe(2); // Euler
  });
  it('merges exactly coplanar points into one face per plane (a cube with face centres)', () => {
    const pts: Vec3[] = [];
    for (const x of [-1, 0, 1]) for (const y of [-1, 0, 1]) for (const z of [-1, 0, 1]) pts.push([x * 5, y * 5, z * 5]);
    const hull = convexHull(pts);
    expect(hull.faces).toHaveLength(6);
    expect(hull.points).toHaveLength(8);
  });
  it(`takes up to ${MAX_HULL_POINTS} points and builds a valid solid from 600`, () => {
    const hull = convexHull(sphere(600, 50));
    const s = k.polyhedron(hull.points, hull.faces);
    try { expect(k.isValid(s)).toBe(true); expect(k.volume(s)).toBeLessThan((4 / 3) * Math.PI * 50 ** 3); } finally { s.dispose(); }
    let error: unknown;
    try { convexHull(sphere(MAX_HULL_POINTS + 1, 50)); } catch (e) { error = e; }
    expect((error as ExactKernelError).code).toBe('unsupported');
  });
});
