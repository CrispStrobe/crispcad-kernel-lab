// SPDX-License-Identifier: MIT
// Copyright (c) 2026 CrispCAD contributors
//
// Faces and edges of an SMLib body with what a host needs to name and pick them: face names
// (SMLib keeps a face's name on the face and on its pieces through Booleans, transforms and
// fillets; faces an operation makes anew have none), surface and curve kinds, sample points, and
// which faces each edge bounds. Edge indices are positions in `part.edges()`, the list `fillet` and
// `chamfer` take with `{ edgeIndices }`; they hold for this solid only, so a host that stores a
// reference to an edge stores names (e.g. the names of its two faces) and resolves them anew.
import type { Edge, Face, Nurbs, Part, Vector } from '@classcad/smlibwasm';
import type { ExactEdgeInfo, ExactFaceInfo, ExactTopology, Vec3 } from './exact-kernel.ts';

type P3 = [number, number, number];
const p3 = (v: Vector): P3 => [v.x, v.y, v.z];
const id = (shape: Face | Edge): string => (shape as unknown as { _identity(): string })._identity();

/** At most this many samples on one edge (a full circle gets 48). */
const MAX_EDGE_SAMPLES = 48;

/** A NURBS curve evaluated by de Boor's algorithm over its whole knot range (homogeneous when
 * rational): cheap, unlike SMLib's arc-length `pointAt`. */
function nurbsAt(n: Nurbs): (s: number) => P3 {
  const p = n.degree, U = n.knots, m = n.points.length - 1, w = n.weights;
  const cw = n.points.map((q, i) => { const wi = w ? w[i] : 1; return [q.x * wi, q.y * wi, q.z * wi, wi]; });
  const t0 = U[p], t1 = U[m + 1];
  const d = Array.from({ length: p + 1 }, () => [0, 0, 0, 0]);
  return s => {
    const t = Math.min(t1, Math.max(t0, t0 + s * (t1 - t0)));
    let k = p;
    while (k < m && U[k + 1] <= t) k++;
    for (let j = 0; j <= p; j++) for (let c = 0; c < 4; c++) d[j][c] = cw[j + k - p][c];
    for (let r = 1; r <= p; r++) for (let j = p; j >= r; j--) {
      const lo = U[j + k - p], den = U[j + 1 + k - r] - lo, a = den > 0 ? (t - lo) / den : 0;
      for (let c = 0; c < 4; c++) d[j][c] = (1 - a) * d[j - 1][c] + a * d[j][c];
    }
    const q = d[p];
    return [q[0] / q[3], q[1] / q[3], q[2] / q[3]];
  };
}

function samples(edge: Edge, kind: string): P3[] {
  const start = p3(edge.start), end = p3(edge.end);
  if (kind === 'line') return [start, end];
  let at: (s: number) => P3 = s => p3(edge.pointAt(s));
  let count = 16;
  if (kind === 'circle') {
    const turn = edge.length / (2 * Math.PI * Math.max(edge.radius, 1e-12));
    count = Math.max(4, Math.min(MAX_EDGE_SAMPLES, Math.ceil(48 * turn)));
  } else if (kind === 'bspline') {
    try {
      const n = edge.nurbs(), f = nurbsAt(n);
      // The NURBS may run against the edge; orient the samples from start to end.
      const first = f(0), d = (a: P3, b: P3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
      at = d(first, start) <= d(first, end) ? f : s => f(1 - s);
      count = Math.max(8, Math.min(MAX_EDGE_SAMPLES, 4 * (n.points.length - n.degree)));
    } catch { /* no NURBS form: arc-length samples */ }
  }
  const points: P3[] = [start];
  for (let i = 1; i < count; i++) points.push(at(i / count));
  points.push(end);
  return points;
}

/** The faces and edges of `part` (see the file header). */
export function topologyOf(part: Part): ExactTopology {
  const faceList = [...part.faces()], index = new Map<string, number>();
  const faces: ExactFaceInfo[] = faceList.map((face, i) => {
    index.set(id(face), i);
    const kind = face.geomType, point = face.interiorPoint();
    const info: ExactFaceInfo = { index: i, name: face.name, surface: kind, area: face.area, point: p3(point), normal: p3(face.normalAt(point)) };
    if (kind === 'cylinder' || kind === 'cone' || kind === 'sphere' || kind === 'torus') {
      const axis = face.axis;
      return { ...info, radius: face.radius, axis: { origin: p3(axis.origin), direction: p3(axis.direction) } };
    }
    return info;
  });
  const edges: ExactEdgeInfo[] = [...part.edges()].map((edge, i) => {
    const kind = edge.geomType, points = samples(edge, kind);
    const bounded = [...edge.faces()].map(f => index.get(id(f))).filter((f): f is number => f !== undefined);
    const info: ExactEdgeInfo = { index: i, curve: kind, faces: bounded, length: edge.length, closed: edge.isClosed, points };
    if (kind === 'circle') return { ...info, radius: edge.radius, center: p3(edge.arcCenter), axis: p3(edge.normal) };
    return info;
  });
  return { faces, edges };
}

/** The same body with face i named `names[i]` (null: unchanged; '' takes a name off). */
export function namedFaces(part: Part, names: readonly (string | null)[]): Part {
  const faceList = [...part.faces()];
  if (names.length !== faceList.length) throw new RangeError(`nameFaces: ${names.length} names for ${faceList.length} faces.`);
  let out = part;
  names.forEach((name, i) => { if (name !== null) out = out.named(name === '' ? null : name, { faces: [faceList[i]] }); });
  return out;
}

/** The edges of `part` at these indices of `part.edges()` (distinct, in range). */
export function edgesAt(part: Part, indices: readonly number[]): Edge[] {
  const all = [...part.edges()];
  if (!indices.length) throw new RangeError('Select at least one edge.');
  if (new Set(indices).size !== indices.length) throw new RangeError('Each edge may be selected once.');
  return indices.map(i => {
    if (!Number.isInteger(i) || i < 0 || i >= all.length) throw new RangeError(`Edge index ${i} is not an edge of this solid (it has ${all.length}).`);
    return all[i];
  });
}

export type { Vec3 };
