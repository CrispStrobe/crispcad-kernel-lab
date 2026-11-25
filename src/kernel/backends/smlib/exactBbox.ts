// SPDX-License-Identifier: MIT
// Copyright (c) 2026 CrispCAD contributors
//
// Exact axis-aligned bounding box of an SMLib body, for SmlibBackend.boundingBox().
// SMLib's own tight bbox() misses interior extremes of some rotated spheres (Sphere(62) turned
// 11 degrees about X: min z -60.861 instead of -62). This is a copy of
// packages/exact-kernel/src/bbox.ts (see its header for the method); exactBbox.test.ts keeps
// the part below the marker line identical to the package's.
// ---- shared with src/kernel/backends/smlib/exactBbox.ts below this line ----
import type { Edge, Face, Part, Vector } from '@classcad/smlibwasm';

type P3 = [number, number, number];
const AXES: readonly P3[] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
const dot3 = (a: P3, b: P3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const p3 = (v: Vector): P3 => [v.x, v.y, v.z];
const unit = (v: P3): P3 | null => { const l = Math.hypot(v[0], v[1], v[2]); return l > 1e-15 ? [v[0] / l, v[1] / l, v[2] / l] : null; };
const at = (c: P3, ...terms: [number, P3][]): P3 => {
  const out: P3 = [c[0], c[1], c[2]];
  for (const [s, v] of terms) { out[0] += s * v[0]; out[1] += s * v[1]; out[2] += s * v[2]; }
  return out;
};

/** The axis-aligned box of `part`, exact for analytic faces and edges (see the file header). */
export function exactBoundingBox(part: Part): { min: P3; max: P3 } {
  const loose = part.bbox();
  const size = Math.max(1, loose.diagonal), tol = 1e-7 * size;
  const box: Box = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity], tol };
  // Vertices and edges first: the face checks below only query points that would grow the box.
  for (const v of part.vertices()) add(box, [v.x, v.y, v.z]);
  for (const edge of part.edges({ seams: true })) edgeExtremes(edge, box);
  for (const face of part.faces()) faceExtremes(face, box);
  if (!Number.isFinite(box.min[0])) return { min: [loose.min.x, loose.min.y, loose.min.z], max: [loose.max.x, loose.max.y, loose.max.z] };
  return { min: box.min, max: box.max };
}

interface Box { min: P3; max: P3; tol: number }
function add(box: Box, p: P3): void {
  for (let i = 0; i < 3; i++) { if (p[i] < box.min[i]) box.min[i] = p[i]; if (p[i] > box.max[i]) box.max[i] = p[i]; }
}
/** True if p lies outside the box by more than the tolerance (worth an on-shape check). */
const grows = (box: Box, p: P3) => p.some((v, i) => v < box.min[i] - box.tol || v > box.max[i] + box.tol);
/** True if some control point lies outside the box: only then can the curve or surface grow it
 * (a NURBS with positive weights lies in the convex hull of its control points). */
const netGrows = (box: Box, points: readonly Vector[]) => points.some(q => grows(box, [q.x, q.y, q.z]));

function edgeExtremes(edge: Edge, box: Box): void {
  const kind = edge.geomType;
  add(box, p3(edge.start)); add(box, p3(edge.end));
  if (kind === 'line') return;
  if (kind === 'circle') {
    const c = p3(edge.arcCenter), n = unit(p3(edge.normal)), r = edge.radius;
    if (n) {
      const closed = edge.isClosed;
      for (const e of AXES) {
        const w = unit(at(e, [-dot3(e, n), n]));
        if (!w) continue;
        for (const s of [1, -1]) {
          const p = at(c, [s * r, w]);
          if (grows(box, p) && (closed || edge.distanceTo(p) <= box.tol)) add(box, p);
        }
      }
      return;
    }
  }
  // Ellipses, B-splines and other curves: skip unless the control net leaves the box, then
  // sample and refine each coordinate's extremes.
  try { if (!netGrows(box, edge.nurbs().points)) return; } catch { /* no NURBS form: sample */ }
  const N = 64, pts: P3[] = [];
  for (let i = 0; i <= N; i++) { const p = p3(edge.pointAt(i / N)); pts.push(p); add(box, p); }
  for (let axis = 0; axis < 3; axis++) for (const sign of [1, -1]) {
    let best = 0;
    for (let i = 1; i <= N; i++) if (sign * pts[i][axis] > sign * pts[best][axis]) best = i;
    const f = (t: number) => { const p = p3(edge.pointAt(t)); add(box, p); return sign * p[axis]; };
    golden(f, Math.max(0, (best - 1) / N), Math.min(1, (best + 1) / N));
  }
}

/** Maximise f on [a, b] by golden-section search (f is evaluated, and recorded, at each probe). */
function golden(f: (t: number) => number, a: number, b: number): void {
  const g = (Math.sqrt(5) - 1) / 2;
  let x1 = b - g * (b - a), x2 = a + g * (b - a), f1 = f(x1), f2 = f(x2);
  for (let i = 0; i < 60 && b - a > 1e-12; i++) {
    if (f1 < f2) { a = x1; x1 = x2; f1 = f2; x2 = a + g * (b - a); f2 = f(x2); }
    else { b = x2; x2 = x1; f2 = f1; x1 = b - g * (b - a); f1 = f(x1); }
  }
}

function faceExtremes(face: Face, box: Box): void {
  const kind = face.geomType;
  if (kind === 'plane' || kind === 'cylinder' || kind === 'cone' || kind === 'extrusion') return; // ruled: extremes on edges
  const onFace = (p: P3) => grows(box, p) && face.distanceTo(p) <= box.tol;
  if (kind === 'sphere') {
    const c = p3(face.axis.origin), r = face.radius;
    for (const e of AXES) for (const s of [1, -1]) { const p = at(c, [s * r, e]); if (onFace(p)) add(box, p); }
    return;
  }
  if (kind === 'torus') {
    const axis = face.axis, c = p3(axis.origin), a = unit(p3(axis.direction)), R = face.majorRadius, r = face.radius;
    if (a) {
      for (const e of AXES) {
        const w = unit(at(e, [-dot3(e, a), a]));
        if (w && Math.abs(dot3(e, a)) < 1 - 1e-12) {
          for (const s of [1, -1]) for (const t of [1, -1]) { const p = at(c, [s * R, w], [t * r, e]); if (onFace(p)) add(box, p); }
        } else {
          // e along the axis: the extremes are the circles at height +-r; any point of them on the face will do.
          const u0 = unit(Math.abs(a[0]) < 0.9 ? at([1, 0, 0], [-a[0], a]) : at([0, 1, 0], [-a[1], a]))!;
          const v0: P3 = [a[1] * u0[2] - a[2] * u0[1], a[2] * u0[0] - a[0] * u0[2], a[0] * u0[1] - a[1] * u0[0]];
          for (const t of [1, -1]) {
            if (!grows(box, at(c, [t * r, a]))) continue;
            for (let k = 0; k < 72; k++) {
              const phi = (2 * Math.PI * k) / 72;
              const p = at(c, [R * Math.cos(phi), u0], [R * Math.sin(phi), v0], [t * r, a]);
              if (onFace(p)) { add(box, p); break; }
            }
          }
        }
      }
      return;
    }
  }
  if (face.isPlanar) return;
  // Surfaces of revolution, B-splines, offsets and others. A surface of degree 1 in one parameter
  // is ruled (extremes on its edges); one whose control net stays inside the box cannot grow it.
  try {
    const net = face.nurbs();
    if (net.degrees[0] === 1 || net.degrees[1] === 1) return;
    if (!netGrows(box, net.points.flat())) return;
  } catch { /* no NURBS form: sample */ }
  // Sample the parameter box, then refine each coordinate's extreme by pattern search; only
  // points that would grow the box are checked to lie on the (possibly trimmed) face.
  const N = 24, samples: { u: number; v: number; p: P3 }[] = [];
  for (let i = 0; i <= N; i++) for (let j = 0; j <= N; j++) samples.push({ u: i / N, v: j / N, p: p3(face.positionAt(i / N, j / N)) });
  for (let axis = 0; axis < 3; axis++) for (const sign of [1, -1]) {
    const ranked = samples.filter(s => grows(box, s.p)).sort((a, b) => sign * b.p[axis] - sign * a.p[axis]);
    const start = ranked.find(s => face.distanceTo(s.p) <= box.tol);
    if (!start) continue;
    add(box, start.p);
    let { u, v } = start, value = sign * start.p[axis], bestP = start.p;
    for (let step = 1 / N; step > 1e-9; step /= 2) {
      for (let moved = true, guard = 0; moved && guard < 64; guard++) {
        moved = false;
        for (const [du, dv] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nu = Math.min(1, Math.max(0, u + du * step)), nv = Math.min(1, Math.max(0, v + dv * step));
          const p = p3(face.positionAt(nu, nv));
          if (sign * p[axis] > value) { u = nu; v = nv; value = sign * p[axis]; bestP = p; moved = true; }
        }
      }
    }
    if (face.distanceTo(bestP) <= box.tol) add(box, bestP); // else the peak is off the trimmed face: its edges hold it
  }
}
