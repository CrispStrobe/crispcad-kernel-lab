// SPDX-License-Identifier: MIT
// Copyright (c) 2026 CrispCAD contributors
//
// Exact axis-aligned bounding box of an SMLib body.
//
// SMLib's own `bbox()` is tight but misses interior extremes of some doubly curved faces: a
// sphere of radius 62 turned 11 degrees about X reports min z = -60.861 (its rotated poles)
// instead of -62. The box here is assembled from points that lie on the body, so it can never
// be too large, and it includes every place where a coordinate can be extreme:
// - on edges: line ends; a circle's or arc's analytic extremes (when they lie on the arc) and
//   ends; other curves sampled and refined by golden-section search (B-splines evaluated from
//   their own NURBS, which is cheap, not by SMLib's arc-length `pointAt`, which is not);
// - inside faces: a linear function on a plane, cylinder, cone or extrusion (ruled surfaces)
//   peaks on the face boundary, i.e. on its edges; a sphere peaks at centre +- r e_i, a torus at
//   centre +- R w +- r e_i (w: e_i's direction across the axis) when those points lie on the
//   face; other surfaces are skipped when ruled (degree 1) or when their NURBS control net lies
//   inside the box so far, else sampled on their parameter box and refined by pattern search.
// Only candidate points that would grow the box are checked to lie on the face.
//
// The lab's native backend carries a copy of this file below the marker line
// (src/kernel/backends/smlib/exactBbox.ts); a test keeps the two identical.
// ---- shared with src/kernel/backends/smlib/exactBbox.ts below this line ----
import type { Edge, Face, Nurbs, Part, Vector } from '@classcad/smlibwasm';

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
  add(box, p3(edge.start)); add(box, p3(edge.end));
  const kind = edge.geomType;
  if (kind === 'line') return;
  if (kind === 'circle' && circleExtremes(edge, box)) return;
  // Ellipses, B-splines and other curves: skip unless the control net leaves the box.
  let nurbs: Nurbs | null = null;
  try { nurbs = edge.nurbs(); if (!netGrows(box, nurbs.points)) return; } catch { /* no NURBS form: sample */ }
  // A B-spline edge's NURBS is the edge itself, evaluated here; `pointAt` (a fraction of the
  // length) integrates the length on every call, which took up to half a second per point on
  // long intersection curves. Ellipses and other curves have only an approximate NURBS.
  if (kind === 'bspline' && nurbs) curveExtremes(nurbsCurve(nurbs), box);
  else curveExtremes({ t0: 0, t1: 1, spans: 1, at: t => p3(edge.pointAt(t)) }, box);
}

/** A circle's or arc's extremes along each axis, where they lie on the arc. */
function circleExtremes(edge: Edge, box: Box): boolean {
  const c = p3(edge.arcCenter), n = unit(p3(edge.normal)), r = edge.radius;
  if (!n) return false;
  for (const e of AXES) {
    const w = unit(at(e, [-dot3(e, n), n]));
    if (!w) continue;
    for (const s of [1, -1]) {
      const p = at(c, [s * r, w]);
      if (grows(box, p) && (edge.isClosed || edge.distanceTo(p) <= box.tol)) add(box, p);
    }
  }
  return true;
}

interface Curve { t0: number; t1: number; spans: number; at: (t: number) => P3 }

/** Sample a curve (at least 8 points per knot span), then refine each coordinate's extremes by
 * golden-section search. */
function curveExtremes(curve: Curve, box: Box): void {
  const N = Math.min(1024, Math.max(64, 8 * curve.spans)), h = (curve.t1 - curve.t0) / N, pts: P3[] = [];
  const t = (i: number) => (i === N ? curve.t1 : curve.t0 + i * h);
  for (let i = 0; i <= N; i++) { const p = curve.at(t(i)); pts.push(p); add(box, p); }
  for (let axis = 0; axis < 3; axis++) for (const sign of [1, -1]) {
    let best = 0;
    for (let i = 1; i <= N; i++) if (sign * pts[i][axis] > sign * pts[best][axis]) best = i;
    const f = (s: number) => { const p = curve.at(s); add(box, p); return sign * p[axis]; };
    golden(f, t(Math.max(0, best - 1)), t(Math.min(N, best + 1)));
  }
}

/** Maximise f on [a, b] by golden-section search (f is evaluated, and recorded, at each probe). */
function golden(f: (t: number) => number, a: number, b: number): void {
  const g = (Math.sqrt(5) - 1) / 2, eps = 1e-12 * Math.max(1, Math.abs(a), Math.abs(b));
  let x1 = b - g * (b - a), x2 = a + g * (b - a), f1 = f(x1), f2 = f(x2);
  for (let i = 0; i < 60 && b - a > eps; i++) {
    if (f1 < f2) { a = x1; x1 = x2; f1 = f2; x2 = a + g * (b - a); f2 = f(x2); }
    else { b = x2; x2 = x1; f2 = f1; x1 = b - g * (b - a); f1 = f(x1); }
  }
}

/** A NURBS curve over its whole knot range, evaluated by de Boor's algorithm (in homogeneous
 * coordinates when rational). */
function nurbsCurve(n: Nurbs): Curve {
  const p = n.degree, U = n.knots, m = n.points.length - 1, w = n.weights;
  const cw = n.points.map((q, i) => { const wi = w ? w[i] : 1; return [q.x * wi, q.y * wi, q.z * wi, wi]; });
  const t0 = U[p], t1 = U[m + 1];
  let spans = 0;
  for (let k = p; k <= m; k++) if (U[k + 1] > U[k]) spans++;
  const d = Array.from({ length: p + 1 }, () => [0, 0, 0, 0]);
  const at = (t: number): P3 => {
    t = Math.min(t1, Math.max(t0, t));
    let k = p;
    while (k < m && U[k + 1] <= t) k++; // the span [U[k], U[k + 1]) holding t (the last one at t1)
    for (let j = 0; j <= p; j++) for (let c = 0; c < 4; c++) d[j][c] = cw[j + k - p][c];
    for (let r = 1; r <= p; r++) for (let j = p; j >= r; j--) {
      const lo = U[j + k - p], den = U[j + 1 + k - r] - lo, a = den > 0 ? (t - lo) / den : 0;
      for (let c = 0; c < 4; c++) d[j][c] = (1 - a) * d[j - 1][c] + a * d[j][c];
    }
    const q = d[p];
    return [q[0] / q[3], q[1] / q[3], q[2] / q[3]];
  };
  return { t0, t1, spans: Math.max(1, spans), at };
}

type OnFace = (p: P3) => boolean;

function faceExtremes(face: Face, box: Box): void {
  const kind = face.geomType;
  if (kind === 'plane' || kind === 'cylinder' || kind === 'cone' || kind === 'extrusion') return; // ruled: extremes on edges
  const onFace: OnFace = p => grows(box, p) && face.distanceTo(p) <= box.tol;
  if (kind === 'sphere') return sphereExtremes(face, box, onFace);
  if (kind === 'torus' && torusExtremes(face, box, onFace)) return;
  if (face.isPlanar) return;
  // Surfaces of revolution, B-splines, offsets and others. A surface of degree 1 in one parameter
  // is ruled (extremes on its edges); one whose control net stays inside the box cannot grow it.
  try {
    const net = face.nurbs();
    if (net.degrees[0] === 1 || net.degrees[1] === 1) return;
    if (!netGrows(box, net.points.flat())) return;
  } catch { /* no NURBS form: sample */ }
  surfaceExtremes(face, box);
}

function sphereExtremes(face: Face, box: Box, onFace: OnFace): void {
  const c = p3(face.axis.origin), r = face.radius;
  for (const e of AXES) for (const s of [1, -1]) { const p = at(c, [s * r, e]); if (onFace(p)) add(box, p); }
}

function torusExtremes(face: Face, box: Box, onFace: OnFace): boolean {
  const axis = face.axis, c = p3(axis.origin), a = unit(p3(axis.direction)), R = face.majorRadius, r = face.radius;
  if (!a) return false;
  for (const e of AXES) {
    const w = unit(at(e, [-dot3(e, a), a]));
    if (w && Math.abs(dot3(e, a)) < 1 - 1e-12) {
      for (const s of [1, -1]) for (const t of [1, -1]) { const p = at(c, [s * R, w], [t * r, e]); if (onFace(p)) add(box, p); }
    } else torusCapCircles(c, a, R, r, box, onFace);
  }
  return true;
}

/** e along the torus axis: the extremes are the circles at height +-r; any point of them on the face will do. */
function torusCapCircles(c: P3, a: P3, R: number, r: number, box: Box, onFace: OnFace): void {
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

/** Sample the parameter box, then refine each coordinate's extreme by pattern search; only
 * points that would grow the box are checked to lie on the (possibly trimmed) face. */
function surfaceExtremes(face: Face, box: Box): void {
  const N = 24, samples: { u: number; v: number; p: P3 }[] = [];
  for (let i = 0; i <= N; i++) for (let j = 0; j <= N; j++) samples.push({ u: i / N, v: j / N, p: p3(face.positionAt(i / N, j / N)) });
  for (let axis = 0; axis < 3; axis++) for (const sign of [1, -1]) {
    const ranked = samples.filter(s => grows(box, s.p)).sort((a, b) => sign * b.p[axis] - sign * a.p[axis]);
    const start = ranked.find(s => face.distanceTo(s.p) <= box.tol);
    if (!start) continue;
    add(box, start.p);
    const peak = patternSearch(face, start, axis, sign, 1 / N);
    if (face.distanceTo(peak) <= box.tol) add(box, peak); // else the peak is off the trimmed face: its edges hold it
  }
}

function patternSearch(face: Face, start: { u: number; v: number; p: P3 }, axis: number, sign: number, step0: number): P3 {
  let { u, v } = start, value = sign * start.p[axis], best = start.p;
  for (let step = step0; step > 1e-9; step /= 2) {
    for (let moved = true, guard = 0; moved && guard < 64; guard++) {
      moved = false;
      for (const [du, dv] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nu = Math.min(1, Math.max(0, u + du * step)), nv = Math.min(1, Math.max(0, v + dv * step));
        const p = p3(face.positionAt(nu, nv));
        if (sign * p[axis] > value) { u = nu; v = nv; value = sign * p[axis]; best = p; moved = true; }
      }
    }
  }
  return best;
}
