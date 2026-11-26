// SPDX-License-Identifier: MIT
// Copyright (c) 2026 CrispCAD contributors
//
// Where a closed planar outline crosses itself.
//
// A self-crossing outline (a bow tie, a pentagram) does not bound a region. SMLib's Polygon and
// makeFace still build a face from it, and an extrusion of that face measures the
// winding-weighted area: a bow tie with lobes of 493 and 89 mm^2 gives 404 mm^2 (or -404, by its
// orientation), the pentagram counts its centre twice. SMLib's isValid() rejects those solids,
// but nothing stops them from being returned and measured. Outlines are checked here first and
// refused. Outlines that only touch themselves (a shared vertex, an edge that runs
// back along another) are not crossings.
// ---- shared with src/modeling/backends/smlib/profileCrossing.ts below this line ----

export type OutlinePoint = readonly [number, number];
type Crossing = { edges: [number, number]; at: [number, number] };

/** The first place where the closed polyline `points` crosses itself: the two edges (edge k runs
 * from point k to point k + 1, the last one back to point 0) and the crossing point, or null when
 * it does not cross itself. Edges that cross in their interiors count, and so does a vertex lying
 * on another edge where the outline passes from one side of that edge to the other. Touching
 * without crossing does not count. */
export function outlineCrossing(points: readonly OutlinePoint[]): Crossing | null {
  const n = points.length;
  if (n < 4) return null;
  let size = 1;
  for (const p of points) size = Math.max(size, Math.abs(p[0]), Math.abs(p[1]));
  const g = geometry(points, 1e-9 * size);
  for (let i = 0; i < n; i++) {
    // Adjacent edges share a vertex and cannot cross in their interiors.
    for (let j = i + 2; j < n; j++) {
      const at = i === 0 && j === n - 1 ? null : g.edgesCross(i, j);
      if (at) return { edges: [i, j], at };
    }
    for (let k = 0; k < n; k++) if (g.passesThrough(i, k)) return { edges: [i, (k - 1 + n) % n], at: [points[k][0], points[k][1]] };
  }
  return null;
}

function geometry(points: readonly OutlinePoint[], tol: number) {
  const n = points.length;
  const pt = (k: number) => points[((k % n) + n) % n];
  /** Side of `c` from the line through edge (a, b): -1, 0 (within the tolerance) or 1. */
  const side = (a: OutlinePoint, b: OutlinePoint, c: OutlinePoint) => {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const d = len <= tol ? 0 : ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / len;
    return Math.abs(d) <= tol ? 0 : Math.sign(d);
  };
  /** Whether `c`, on the line through (a, b), lies strictly between a and b. */
  const inside = (a: OutlinePoint, b: OutlinePoint, c: OutlinePoint) => {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const t = ((c[0] - a[0]) * (b[0] - a[0]) + (c[1] - a[1]) * (b[1] - a[1])) / len;
    return t > tol && t < len - tol;
  };
  /** The first side of edge (a, b) that the outline reaches from vertex k, stepping by `step`. */
  const nextSide = (a: OutlinePoint, b: OutlinePoint, k: number, step: 1 | -1) => {
    for (let s = 1; s < n; s++) { const v = side(a, b, pt(k + step * s)); if (v) return v; }
    return 0;
  };
  return {
    /** Where edges i and j cross in their interiors, or null. */
    edgesCross(i: number, j: number): [number, number] | null {
      const a = pt(i), b = pt(i + 1), c = pt(j), d = pt(j + 1);
      if (side(a, b, c) * side(a, b, d) >= 0 || side(c, d, a) * side(c, d, b) >= 0) return null;
      const den = (b[0] - a[0]) * (d[1] - c[1]) - (b[1] - a[1]) * (d[0] - c[0]);
      const t = ((c[0] - a[0]) * (d[1] - c[1]) - (c[1] - a[1]) * (d[0] - c[0])) / den;
      return [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
    },
    /** Whether vertex k lies inside edge i and the outline passes there from one side to the other. */
    passesThrough(i: number, k: number): boolean {
      if (k === i || k === (i + 1) % n) return false;
      const a = pt(i), b = pt(i + 1), v = pt(k);
      if (side(a, b, v) !== 0 || !inside(a, b, v)) return false;
      return nextSide(a, b, k, -1) * nextSide(a, b, k, 1) < 0;
    },
  };
}
