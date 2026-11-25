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
  const min: P3 = [Infinity, Infinity, Infinity], max: P3 = [-Infinity, -Infinity, -Infinity];
  const add = (p: P3) => { for (let i = 0; i < 3; i++) { if (p[i] < min[i]) min[i] = p[i]; if (p[i] > max[i]) max[i] = p[i]; } };
  const onFace = (face: Face, p: P3) => face.distanceTo(p) <= tol;

  for (const edge of part.edges({ seams: true })) edgeExtremes(edge, add, tol);
  for (const face of part.faces()) faceExtremes(face, add, onFace);
  for (const v of part.vertices()) add([v.x, v.y, v.z]);
  if (!Number.isFinite(min[0])) return { min: [loose.min.x, loose.min.y, loose.min.z], max: [loose.max.x, loose.max.y, loose.max.z] };
  return { min, max };
}

function edgeExtremes(edge: Edge, add: (p: P3) => void, tol: number): void {
  const kind = edge.geomType;
  add(p3(edge.start)); add(p3(edge.end));
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
          if (closed || edge.distanceTo(p) <= tol) add(p);
        }
      }
      return;
    }
  }
  // Ellipses, B-splines and other curves: sample, then refine each coordinate's extremes.
  const N = 64, pts: P3[] = [];
  for (let i = 0; i <= N; i++) { const p = p3(edge.pointAt(i / N)); pts.push(p); add(p); }
  for (let axis = 0; axis < 3; axis++) for (const sign of [1, -1]) {
    let best = 0;
    for (let i = 1; i <= N; i++) if (sign * pts[i][axis] > sign * pts[best][axis]) best = i;
    const f = (t: number) => { const p = p3(edge.pointAt(t)); add(p); return sign * p[axis]; };
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

function faceExtremes(face: Face, add: (p: P3) => void, onFace: (face: Face, p: P3) => boolean): void {
  const kind = face.geomType;
  if (kind === 'plane' || kind === 'cylinder' || kind === 'cone' || kind === 'extrusion') return; // ruled: extremes on edges
  if (kind === 'sphere') {
    const c = p3(face.axis.origin), r = face.radius;
    for (const e of AXES) for (const s of [1, -1]) { const p = at(c, [s * r, e]); if (onFace(face, p)) add(p); }
    return;
  }
  if (kind === 'torus') {
    const axis = face.axis, c = p3(axis.origin), a = unit(p3(axis.direction)), R = face.majorRadius, r = face.radius;
    if (a) {
      for (const e of AXES) {
        const w = unit(at(e, [-dot3(e, a), a]));
        if (w && Math.abs(dot3(e, a)) < 1 - 1e-12) {
          for (const s of [1, -1]) for (const t of [1, -1]) { const p = at(c, [s * R, w], [t * r, e]); if (onFace(face, p)) add(p); }
        } else {
          // e along the axis: the extremes are the circles at height +-r; any point of them on the face will do.
          const u0 = unit(Math.abs(a[0]) < 0.9 ? at([1, 0, 0], [-a[0], a]) : at([0, 1, 0], [-a[1], a]))!;
          const v0: P3 = [a[1] * u0[2] - a[2] * u0[1], a[2] * u0[0] - a[0] * u0[2], a[0] * u0[1] - a[1] * u0[0]];
          for (const t of [1, -1]) for (let k = 0; k < 72; k++) {
            const phi = (2 * Math.PI * k) / 72;
            const p = at(c, [R * Math.cos(phi), u0], [R * Math.sin(phi), v0], [t * r, a]);
            if (onFace(face, p)) { add(p); break; }
          }
        }
      }
      return;
    }
  }
  // Surfaces of revolution, B-splines, offsets and others: sample the parameter box and refine.
  const N = 24, samples: { u: number; v: number; p: P3 }[] = [];
  for (let i = 0; i <= N; i++) for (let j = 0; j <= N; j++) {
    const p = p3(face.positionAt(i / N, j / N));
    if (onFace(face, p)) { samples.push({ u: i / N, v: j / N, p }); add(p); }
  }
  for (let axis = 0; axis < 3; axis++) for (const sign of [1, -1]) {
    if (!samples.length) return;
    let best = samples[0];
    for (const s of samples) if (sign * s.p[axis] > sign * best.p[axis]) best = s;
    let { u, v } = best, value = sign * best.p[axis];
    for (let step = 1 / N; step > 1e-10; step /= 2) {
      for (let moved = true, guard = 0; moved && guard < 64; guard++) {
        moved = false;
        for (const [du, dv] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nu = Math.min(1, Math.max(0, u + du * step)), nv = Math.min(1, Math.max(0, v + dv * step));
          const p = p3(face.positionAt(nu, nv));
          if (sign * p[axis] > value && onFace(face, p)) { u = nu; v = nv; value = sign * p[axis]; add(p); moved = true; }
        }
      }
    }
  }
}
