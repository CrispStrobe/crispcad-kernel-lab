// SPDX-License-Identifier: MIT
// Copyright (c) 2026 CrispCAD contributors
//
// Simple loops of a polygon profile that touches itself. Catalog profiles often reuse a vertex
// (a chevron whose two arms meet at one point, a frame drawn as one outline with a zero-width
// slit to its opening, a closed arc band whose ends coincide) or run back along an edge (a
// zero-area spike). OpenCASCADE builds such outlines as one wire; SMLib's Polygon rejects them
// (`SM_ERR`, `SM_ERR_NULL_POINTER`). Split at repeated vertices and drop the spikes, and the
// region is the even-odd fill of the remaining simple loops.
type Pt = readonly [number, number];

/** The polygon as simple loops (each with at least three points and non-zero area), largest
 * first: SMLib's xor of a hole with its outer region (in that order) gives a solid with inverted
 * faces (negative area). A polygon that needs no cleaning comes back as itself, the same array. */
export function polygonLoops(points: readonly Pt[]): Pt[][] {
  const size = Math.max(1, ...points.flatMap(p => p.map(Math.abs)));
  const eps = 1e-9 * size;
  const same = (a: Pt, b: Pt) => Math.abs(a[0] - b[0]) <= eps && Math.abs(a[1] - b[1]) <= eps;
  const out: Pt[][] = [];
  const split = (loop: Pt[]) => {
    // Consecutive duplicates (also across the closing edge).
    const ring = loop.filter((p, i) => !same(p, loop[(i + 1) % loop.length]));
    for (let i = 0; i < ring.length; i++) for (let j = i + 1; j < ring.length; j++) {
      if (!same(ring[i], ring[j])) continue;
      split(ring.slice(i, j));
      split([...ring.slice(0, i + 1), ...ring.slice(j + 1)]);
      return;
    }
    const cleaned = dropSpikes(ring, eps);
    if (cleaned.length >= 3 && Math.abs(signedArea(cleaned)) > eps * size) out.push(cleaned);
  };
  split([...points]);
  if (out.length === 1 && out[0].length === points.length) return [points as Pt[]];
  return out.sort((a, b) => Math.abs(signedArea(b)) - Math.abs(signedArea(a)));
}

/** Remove vertices where the outline turns back on itself (collinear, reversing). */
function dropSpikes(loop: Pt[], eps: number): Pt[] {
  const ring = [...loop];
  for (let changed = true; changed && ring.length >= 3;) {
    changed = false;
    for (let i = 0; i < ring.length && ring.length >= 3; i++) {
      const a = ring[(i + ring.length - 1) % ring.length], b = ring[i], c = ring[(i + 1) % ring.length];
      const ux = a[0] - b[0], uy = a[1] - b[1], vx = c[0] - b[0], vy = c[1] - b[1];
      const cross = ux * vy - uy * vx, len = Math.hypot(ux, uy) * Math.hypot(vx, vy);
      if (Math.abs(cross) <= eps * Math.max(1, Math.sqrt(len)) && ux * vx + uy * vy > 0) { ring.splice(i, 1); changed = true; i--; }
    }
  }
  return ring;
}

function signedArea(loop: readonly Pt[]): number {
  let s = 0;
  for (let i = 0; i < loop.length; i++) { const a = loop[i], b = loop[(i + 1) % loop.length]; s += a[0] * b[1] - b[0] * a[1]; }
  return s / 2;
}
