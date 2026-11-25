// SPDX-License-Identifier: MIT
// Copyright (c) 2026 CrispCAD contributors
// Moved from CrispCAD experiments/exact-kernel/src/polytope.ts (BSD-3-Clause there, same author).
// Exact convex hull of a small point set as planar polygon faces, for lowering CAD Script
// `hull` of polyhedral inputs (and convex `polyhedron`/`loft` output) to a B-rep with one
// face per supporting plane. Brute-force facet enumeration: O(n^4), bounded by MAX_HULL_POINTS.
import { ExactKernelError, type Vec3 } from './exact-kernel.ts';

export const MAX_HULL_POINTS = 64;

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

export interface Polytope { points: Vec3[]; faces: number[][] }

/** Points of the hull boundary and its faces (counter-clockwise seen from outside, collinear
 * points dropped). Throws for degenerate (flat) or oversized inputs. */
export function convexHull(input: readonly Vec3[]): Polytope {
  const points: Vec3[] = [];
  const size = Math.max(1, ...input.flatMap(p => p.map(Math.abs)));
  const eps = 1e-9 * size;
  for (const p of input) if (!points.some(q => Math.hypot(...sub(p, q)) <= eps)) points.push(p);
  if (points.length > MAX_HULL_POINTS) throw new ExactKernelError('unsupported', `Hull of ${points.length} distinct vertices exceeds the exact hull budget (${MAX_HULL_POINTS}).`);
  if (points.length < 4) throw new ExactKernelError('invalid-input', 'A hull needs at least four non-coplanar points.');
  const planes: { n: Vec3; d: number; members: number[] }[] = [];
  const n = points.length;
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) for (let k = j + 1; k < n; k++) {
    const c = cross(sub(points[j], points[i]), sub(points[k], points[i])), len = Math.hypot(...c);
    if (len <= eps * size) continue;
    let normal: Vec3 = [c[0] / len, c[1] / len, c[2] / len], d = dot(normal, points[i]);
    let above = 0, below = 0;
    for (const p of points) { const s = dot(normal, p) - d; if (s > eps) above++; else if (s < -eps) below++; }
    if (above && below) continue;
    if (!above && !below) continue; // all coplanar: handled by the flat check below
    if (above) { normal = [-normal[0], -normal[1], -normal[2]]; d = -d; }
    if (planes.some(pl => dot(pl.n, normal) > 1 - 1e-12 && Math.abs(pl.d - d) <= eps)) continue;
    planes.push({ n: normal, d, members: points.map((p, idx) => (Math.abs(dot(normal, p) - d) <= eps ? idx : -1)).filter(idx => idx >= 0) });
  }
  if (planes.length < 4) throw new ExactKernelError('invalid-input', 'The hull is flat (all points coplanar).');
  const faces = planes.map(({ n: normal, members }) => {
    // 2D convex hull (monotone chain) in the face plane, counter-clockwise about the outward normal.
    const u0: Vec3 = Math.abs(normal[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const u = cross(normal, u0), ul = Math.hypot(...u), uu: Vec3 = [u[0] / ul, u[1] / ul, u[2] / ul], vv = cross(normal, uu);
    const pts = members.map(idx => ({ idx, x: dot(points[idx], uu), y: dot(points[idx], vv) })).sort((a, b) => a.x - b.x || a.y - b.y);
    const turn = (o: typeof pts[0], a: typeof pts[0], b: typeof pts[0]) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
    const chain = (list: typeof pts) => {
      const out: typeof pts = [];
      for (const p of list) { while (out.length >= 2 && turn(out[out.length - 2], out[out.length - 1], p) <= eps * size) out.pop(); out.push(p); }
      return out;
    };
    const lower = chain(pts), upper = chain([...pts].reverse());
    // (uu, vv, normal) is right-handed, so counter-clockwise in (x, y) is counter-clockwise from outside.
    return [...lower.slice(0, -1), ...upper.slice(0, -1)].map(p => p.idx);
  });
  const used = [...new Set(faces.flat())].sort((a, b) => a - b), remap = new Map(used.map((idx, i) => [idx, i]));
  return { points: used.map(idx => points[idx]), faces: faces.map(f => f.map(idx => remap.get(idx)!)) };
}

/** True if every point lies on or behind every face plane (the polyhedron is convex). */
export function isConvexPolyhedron(points: readonly Vec3[], faces: readonly (readonly number[])[]): boolean {
  const size = Math.max(1, ...points.flatMap(p => p.map(Math.abs))), eps = 1e-9 * size;
  for (const f of faces) {
    // Newell normal, robust for polygons with collinear runs.
    const nrm: [number, number, number] = [0, 0, 0];
    for (let i = 0; i < f.length; i++) {
      const a = points[f[i]], b = points[f[(i + 1) % f.length]];
      nrm[0] += (a[1] - b[1]) * (a[2] + b[2]); nrm[1] += (a[2] - b[2]) * (a[0] + b[0]); nrm[2] += (a[0] - b[0]) * (a[1] + b[1]);
    }
    const len = Math.hypot(...nrm);
    if (!(len > 0)) return false;
    const normal: Vec3 = [nrm[0] / len, nrm[1] / len, nrm[2] / len], d = dot(normal, points[f[0]]);
    if (f.some(i => Math.abs(dot(normal, points[i]) - d) > eps)) return false; // non-planar face
    if (points.some(p => dot(normal, p) - d > eps)) return false;
  }
  return true;
}
