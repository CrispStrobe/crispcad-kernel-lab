// SPDX-License-Identifier: MIT
// Copyright (c) 2026 CrispCAD contributors
// Moved from CrispCAD experiments/exact-kernel/src/polytope.ts (BSD-3-Clause there, same author).
// Exact convex hull of a point set as planar polygon faces, for lowering CAD Script `hull` of
// polyhedral inputs (and convex `polyhedron`/`loft` output) to a B-rep with one face per
// supporting plane.
//
// 0.1.1: an incremental hull (triangles, O(n^2)) whose coplanar triangles are then merged
// across shared edges. 0.1.0 enumerated every triple's plane and took all points within a size-
// relative tolerance as one face; for points rounded to six decimals (the CAD Script converter's
// output) on a 1 m long 10-gon loft, that tolerance (1e-6 mm) took in the two triangles of
// slightly twisted side quads as one non-planar face, which SMLib cannot stitch, and kept both
// near-identical planes as two overlapping faces, which doubled the side area of a frustum.
// Triangles are now merged only when every vertex lies within 1e-9 (absolute, model units) of
// the face's plane, and a merged face is always one simple loop of the triangles' edges, so
// neighbouring faces share their edges exactly.
import { ExactKernelError, type Vec3 } from './exact-kernel.ts';

/** Most distinct points a hull takes (0.1.0: 64). */
export const MAX_HULL_POINTS = 1024;

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

export interface Polytope { points: Vec3[]; faces: number[][] }

interface Tri { v: [number, number, number]; n: Vec3; d: number; area: number; alive: boolean }

/** Points of the hull boundary and its faces (counter-clockwise seen from outside, collinear
 * points dropped). Throws for degenerate (flat) or oversized inputs. */
export function convexHull(input: readonly Vec3[]): Polytope {
  const size = Math.max(1, ...input.flatMap(p => p.map(Math.abs)));
  const eps = 1e-9 * size;
  const points = dedupe(input, eps);
  if (points.length > MAX_HULL_POINTS) throw new ExactKernelError('unsupported', `Hull of ${points.length} distinct vertices exceeds the exact hull budget (${MAX_HULL_POINTS}).`);
  if (points.length < 4) throw new ExactKernelError('invalid-input', 'A hull needs at least four non-coplanar points.');
  const tris = hullTriangles(points, eps);
  return mergeCoplanar(points, tris, Math.min(eps, 1e-9));
}

/** Distinct points (within eps), in input order; a spatial hash keeps this near O(n). */
function dedupe(input: readonly Vec3[], eps: number): Vec3[] {
  const cell = Math.max(eps * 4, 1e-300), grid = new Map<string, Vec3[]>(), out: Vec3[] = [];
  for (const p of input) {
    const c = p.map(v => Math.floor(v / cell));
    let dup = false;
    for (let dx = -1; dx <= 1 && !dup; dx++) for (let dy = -1; dy <= 1 && !dup; dy++) for (let dz = -1; dz <= 1 && !dup; dz++) {
      for (const q of grid.get(`${c[0] + dx},${c[1] + dy},${c[2] + dz}`) ?? []) if (Math.hypot(...sub(p, q)) <= eps) { dup = true; break; }
    }
    if (dup) continue;
    const key = c.join(',');
    (grid.get(key) ?? grid.set(key, []).get(key)!).push(p);
    out.push(p);
  }
  return out;
}

function makeTri(points: readonly Vec3[], a: number, b: number, c: number): Tri {
  const nr = cross(sub(points[b], points[a]), sub(points[c], points[a])), len = Math.hypot(...nr);
  const n: Vec3 = len > 0 ? [nr[0] / len, nr[1] / len, nr[2] / len] : [0, 0, 0];
  // Plane offset from the centroid: less sensitive to which vertex is first.
  const g: Vec3 = [(points[a][0] + points[b][0] + points[c][0]) / 3, (points[a][1] + points[b][1] + points[c][1]) / 3, (points[a][2] + points[b][2] + points[c][2]) / 3];
  return { v: [a, b, c], n, d: dot(n, g), area: len / 2, alive: true };
}

/** Incremental 3D hull: outward triangles over the extreme points. */
function hullTriangles(points: readonly Vec3[], eps: number): Tri[] {
  const n = points.length;
  // Initial tetrahedron from extreme points.
  let i0 = 0;
  for (let i = 1; i < n; i++) if (points[i][0] < points[i0][0]) i0 = i;
  let i1 = -1, best = -1;
  for (let i = 0; i < n; i++) { const d = Math.hypot(...sub(points[i], points[i0])); if (d > best) { best = d; i1 = i; } }
  let i2 = -1; best = -1;
  const axis = sub(points[i1], points[i0]);
  for (let i = 0; i < n; i++) { const d = Math.hypot(...cross(axis, sub(points[i], points[i0]))); if (d > best) { best = d; i2 = i; } }
  if (!(best > eps * Math.hypot(...axis))) throw new ExactKernelError('invalid-input', 'The hull is flat (all points collinear).');
  const base = makeTri(points, i0, i1, i2);
  let i3 = -1; best = -1;
  for (let i = 0; i < n; i++) { const d = Math.abs(dot(base.n, points[i]) - base.d); if (d > best) { best = d; i3 = i; } }
  if (!(best > eps)) throw new ExactKernelError('invalid-input', 'The hull is flat (all points coplanar).');

  const tris: Tri[] = [], edgeOwner = new Map<number, number>(); // directed edge a->b: a * n + b
  const add = (a: number, b: number, c: number) => {
    const t = makeTri(points, a, b, c), id = tris.length;
    tris.push(t);
    edgeOwner.set(a * n + b, id); edgeOwner.set(b * n + c, id); edgeOwner.set(c * n + a, id);
    return id;
  };
  const kill = (id: number) => {
    const t = tris[id]; t.alive = false;
    const [a, b, c] = t.v;
    for (const key of [a * n + b, b * n + c, c * n + a]) if (edgeOwner.get(key) === id) edgeOwner.delete(key);
  };
  // Orient the tetrahedron outward.
  if (dot(base.n, points[i3]) - base.d > 0) { add(i0, i2, i1); add(i0, i1, i3); add(i1, i2, i3); add(i2, i0, i3); }
  else { add(i0, i1, i2); add(i0, i3, i1); add(i1, i3, i2); add(i2, i3, i0); }

  const done = new Set([i0, i1, i2, i3]);
  // Farthest points first gives fewer short-lived triangles.
  const centre = points.reduce((s, p) => [s[0] + p[0] / n, s[1] + p[1] / n, s[2] + p[2] / n] as Vec3, [0, 0, 0] as Vec3);
  const order = [...points.keys()].filter(i => !done.has(i)).sort((a, b) => Math.hypot(...sub(points[b], centre)) - Math.hypot(...sub(points[a], centre)));
  for (const p of order) {
    const P = points[p];
    let start = -1, far = eps;
    for (let id = 0; id < tris.length; id++) {
      const t = tris[id];
      if (!t.alive) continue;
      const s = dot(t.n, P) - t.d;
      if (s > far) { far = s; start = id; }
    }
    if (start < 0) continue; // inside (or within eps of) the hull
    // Visible region: connected faces that see the point.
    const visible = new Set<number>([start]), stack = [start];
    while (stack.length) {
      const id = stack.pop()!, [a, b, c] = tris[id].v;
      for (const [u, v] of [[a, b], [b, c], [c, a]]) {
        const nb = edgeOwner.get(v * n + u);
        if (nb === undefined || visible.has(nb)) continue;
        if (dot(tris[nb].n, P) - tris[nb].d > eps) { visible.add(nb); stack.push(nb); }
      }
    }
    const horizon: [number, number][] = [];
    for (const id of visible) {
      const [a, b, c] = tris[id].v;
      for (const [u, v] of [[a, b], [b, c], [c, a]] as [number, number][]) {
        const nb = edgeOwner.get(v * n + u);
        if (nb === undefined || !visible.has(nb)) horizon.push([u, v]);
      }
    }
    for (const id of visible) kill(id);
    for (const [u, v] of horizon) add(u, v, p);
  }
  return tris.filter(t => t.alive);
}

/** Merge triangles across shared edges into planar faces (one simple loop each). */
function mergeCoplanar(points: readonly Vec3[], tris: Tri[], tolerance: number): Polytope {
  const n = points.length, owner = new Map<number, number>();
  tris.forEach((t, id) => { const [a, b, c] = t.v; owner.set(a * n + b, id); owner.set(b * n + c, id); owner.set(c * n + a, id); });
  const region = new Array<number>(tris.length).fill(-1);
  const regions: number[][] = [];
  const order = [...tris.keys()].sort((a, b) => tris[b].area - tris[a].area);
  for (const seed of order) {
    if (region[seed] >= 0) continue;
    const { n: normal, d } = tris[seed], id = regions.length, members = [seed];
    region[seed] = id;
    for (let k = 0; k < members.length; k++) {
      const [a, b, c] = tris[members[k]].v;
      for (const [u, v] of [[a, b], [b, c], [c, a]]) {
        const nb = owner.get(v * n + u);
        if (nb === undefined || region[nb] >= 0) continue;
        const t = tris[nb];
        if (dot(t.n, normal) < 1 - 1e-6 || t.v.some(i => Math.abs(dot(normal, points[i]) - d) > tolerance)) continue;
        region[nb] = id; members.push(nb);
      }
    }
    const loop = members.length > 1 ? boundaryLoop(members.map(m => tris[m].v), n) : tris[seed].v.slice();
    if (loop) regions.push(loop);
    else { // not one simple loop: keep the triangles
      region[seed] = id; regions.push(tris[seed].v.slice());
      for (const m of members.slice(1)) { region[m] = regions.length; regions.push(tris[m].v.slice()); }
    }
  }
  // A vertex on only two faces lies on their common edge: drop it from both.
  const incident = new Map<number, number>();
  for (const loop of regions) for (const v of loop) incident.set(v, (incident.get(v) ?? 0) + 1);
  const faces = regions.map(loop => {
    const kept = loop.filter(v => (incident.get(v) ?? 0) > 2);
    return kept.length >= 3 ? kept : loop;
  });
  const used = [...new Set(faces.flat())].sort((a, b) => a - b), remap = new Map(used.map((idx, i) => [idx, i]));
  return { points: used.map(idx => points[idx]), faces: faces.map(f => f.map(idx => remap.get(idx)!)) };
}

/** The boundary of a set of consistently oriented triangles as one loop, or null. */
function boundaryLoop(tris: readonly (readonly number[])[], n: number): number[] | null {
  const edges = new Set<number>();
  for (const [a, b, c] of tris) for (const [u, v] of [[a, b], [b, c], [c, a]]) edges.add(u * n + v);
  const next = new Map<number, number>();
  for (const key of edges) {
    const u = Math.floor(key / n), v = key % n;
    if (edges.has(v * n + u)) continue; // interior edge
    if (next.has(u)) return null; // pinched
    next.set(u, v);
  }
  const start = next.keys().next().value as number, loop = [start];
  for (let v = next.get(start)!; v !== start; v = next.get(v)!) {
    if (v === undefined || loop.length > next.size) return null;
    loop.push(v);
  }
  return loop.length === next.size ? loop : null;
}

/** The faces with every non-planar one (a vertex more than `tolerance` off its Newell plane)
 * split into triangles by ear clipping in that plane. Planar faces are returned unchanged. */
export function planarFaces(points: readonly Vec3[], faces: readonly (readonly number[])[], tolerance = 1e-9): number[][] {
  const out: number[][] = [];
  for (const f of faces) {
    const normal = newell(points, f);
    if (f.length === 3 || !normal) { out.push([...f]); continue; }
    const d = f.reduce((s, i) => s + dot(normal, points[i]), 0) / f.length;
    if (f.every(i => Math.abs(dot(normal, points[i]) - d) <= tolerance)) { out.push([...f]); continue; }
    out.push(...earClip(points, f, normal));
  }
  return out;
}

function newell(points: readonly Vec3[], f: readonly number[]): Vec3 | null {
  const nrm: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < f.length; i++) {
    const a = points[f[i]], b = points[f[(i + 1) % f.length]];
    nrm[0] += (a[1] - b[1]) * (a[2] + b[2]); nrm[1] += (a[2] - b[2]) * (a[0] + b[0]); nrm[2] += (a[0] - b[0]) * (a[1] + b[1]);
  }
  const len = Math.hypot(...nrm);
  return len > 0 ? [nrm[0] / len, nrm[1] / len, nrm[2] / len] : null;
}

/** Triangles of a simple polygon (counter-clockwise about `normal`), same orientation. */
function earClip(points: readonly Vec3[], f: readonly number[], normal: Vec3): number[][] {
  const u0: Vec3 = Math.abs(normal[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const uc = cross(normal, u0), ul = Math.hypot(...uc), u: Vec3 = [uc[0] / ul, uc[1] / ul, uc[2] / ul], v = cross(normal, u);
  const p2 = new Map(f.map(i => [i, [dot(points[i], u), dot(points[i], v)] as [number, number]]));
  const turn = (a: number, b: number, c: number) => { const [ax, ay] = p2.get(a)!, [bx, by] = p2.get(b)!, [cx, cy] = p2.get(c)!; return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax); };
  const inside = (p: number, a: number, b: number, c: number) => turn(a, b, p) >= 0 && turn(b, c, p) >= 0 && turn(c, a, p) >= 0;
  const ring = [...f], tris: number[][] = [];
  let guard = 0;
  while (ring.length > 3 && guard++ < 10 * f.length * f.length) {
    let clipped = false;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[(i + ring.length - 1) % ring.length], b = ring[i], c = ring[(i + 1) % ring.length];
      if (turn(a, b, c) <= 0) continue;
      if (ring.some(p => p !== a && p !== b && p !== c && inside(p, a, b, c))) continue;
      tris.push([a, b, c]); ring.splice(i, 1); clipped = true; break;
    }
    if (!clipped) break;
  }
  if (ring.length > 3) { for (let i = 1; i + 1 < ring.length; i++) tris.push([ring[0], ring[i], ring[i + 1]]); } // degenerate: fan the rest
  else tris.push(ring);
  return tris;
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
