// SPDX-License-Identifier: MIT
// Copyright (c) 2026 CrispCAD contributors
//
// A copy of src/modeling/backends/smlib/compatibleSections.ts in the CrispCAD kernel lab.
//
// Equalise the vertex counts of closed polygonal loft sections the way OpenCASCADE's
// ThruSections does before it lofts them, so that a ruled loft joins the same points.
// Written from a description of the algorithm (BRepFill_CompatibleWires, "polar method",
// OCCT 7.8 to 8.0.1, unchanged in that range); no OCCT code is copied.
//
// The rule, for closed sections whose edge counts differ:
//
// - Each section has a centre, the centroid of its outline as a curve (for a polygon, the
//   edge midpoints weighted by edge length; not the area centroid), and a plane normal.
// - A vertex v of section i is carried to section j along a ray: from j's centre in the
//   direction v - centre(i) (rotated between the planes when they are not parallel). The ray
//   runs for the diagonal of j's bounding box; its hit on j's outline is the point nearest the
//   ray (distance ties within 1e-7), and among several the one closest to centre(j) + (v -
//   centre(i)).
// - A hit within 1e-7 of a vertex of j is that vertex. A hit inside an edge closer than 10 % of
//   the edge's length to one of its ends snaps to that end, unless that end is already the image
//   of another vertex, then the edge is split exactly at the hit. Otherwise the edge is split
//   at the hit (a new vertex). The 10 % is of the edge as it is at that moment: an edge split
//   earlier is shorter.
// - Backward pass: for i from the last section down to the second, every vertex of section i
//   (in outline order, including the vertices inserted into it in the step before) is carried
//   to section i - 1, which is updated after each vertex. So the first section collects
//   images of all vertices of all sections.
// - Chains: each vertex of the first section starts a chain, followed upward by the vertex it
//   is the image of in section 2, and so on.
// - Forward pass: for i from the first section to the last but one, each vertex of section i
//   whose chain has no vertex in section i + 1 yet is carried to section i + 1 (snapping only to
//   vertices that are in no chain), and the hit joins its chain.
// - Every section is then walked from the chain member of the first section's first vertex
//   towards that of its second: vertex k of each section is the same chain, and a ruled loft
//   joins them.
//
// Sections with equal edge counts (and a corner somewhere, so not all smooth) are only re-started
// ("ComputeOrigin"): each section after the first, moved in the first section's plane so its
// centre lies over the previous one's, starts at the vertex and runs in the direction (forward
// tried before backward, start vertices in outline order, the first strict minimum wins) that
// minimise the sum of distances from the previous (re-started) section's vertices to its own.

export type P3 = readonly [number, number, number];

/**
 * How sections with equal vertex counts are paired. 'authored': vertex i of each section joins
 * vertex i of the next, as drawn. 'closest': each section is re-started where it lies closest to
 * the one before (ComputeOrigin), as OCCT's ThruSections does. Sections with different counts are
 * matched by the polar rule either way (there is no vertex i to keep).
 */
export type LoftPairing = 'authored' | 'closest';

const CONFUSION = 1e-7;
const PERCENT = 0.1;

const sub = (a: P3, b: P3): P3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: P3, b: P3): P3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: P3, s: number): P3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: P3, b: P3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: P3, b: P3): P3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: P3) => Math.sqrt(dot(a, a));
const dist = (a: P3, b: P3) => norm(sub(a, b));
const unit = (a: P3): P3 => mul(a, 1 / norm(a));

/** Rotate p about the axis (origin o, unit direction d) by angle a (right hand). */
function rotateAbout(p: P3, o: P3, d: P3, a: number): P3 {
  const v = sub(p, o), c = Math.cos(a), s = Math.sin(a);
  return add(o, add(add(mul(v, c), mul(cross(d, v), s)), mul(d, dot(d, v) * (1 - c))));
}

interface Plane { pos: P3; axis: P3 }

/** Centre (curve centroid) and unit normal (Newell) of a closed polygon. */
function planeOf(pts: readonly P3[]): Plane {
  let len = 0, c: P3 = [0, 0, 0], n: P3 = [0, 0, 0];
  for (let k = 0; k < pts.length; k++) {
    const a = pts[k]!, b = pts[(k + 1) % pts.length]!, l = dist(a, b);
    len += l;
    c = add(c, mul(add(a, b), l / 2));
    n = add(n, [(a[1] - b[1]) * (a[2] + b[2]), (a[2] - b[2]) * (a[0] + b[0]), (a[0] - b[0]) * (a[1] + b[1])]);
  }
  return { pos: mul(c, 1 / len), axis: unit(n) };
}

/** Carry p from plane 1 to plane 2: translate by the centres' difference and, when the planes
 *  are not parallel (1e-4 rad), rotate about the line through pos2 normal to both axes. */
function transfer(p: P3, from: Plane, to: Plane): P3 {
  let q = add(p, sub(to.pos, from.pos));
  let a1 = from.axis, a2 = to.axis;
  const angle = Math.acos(Math.max(-1, Math.min(1, dot(a1, a2))));
  if (angle <= 1e-4 || angle >= Math.PI - 1e-4) return q;
  const t = sub(to.pos, from.pos);
  if (dot(t, a1) < -1e-7) a1 = mul(a1, -1);
  if (dot(t, a2) < 1e-7) a2 = mul(a2, -1);
  const n2 = cross(a1, a2);
  const vs = add(mul(a2, dot(t, a1)), mul(a1, -dot(t, a2)));
  const alpha = dot(vs, a1), beta = dot(vs, a2);
  const sign = alpha * beta > 0 && Math.abs(alpha) > 1e-4 && Math.abs(beta) > 1e-4 ? -1 : 1;
  // Angle from a1 to a2 about n2 (= a1 x a2, so it is positive), in [0, pi].
  const ang = Math.acos(Math.max(-1, Math.min(1, dot(a1, a2) / (norm(a1) * norm(a2)))));
  q = rotateAbout(q, to.pos, unit(n2), ang * sign);
  return q;
}

interface Vertex { id: number; p: P3 }
type Loop = Vertex[];

interface Hit { vertex?: Vertex; edge?: number; t?: number; p: P3; d: number }

/** Closest points between segment [p0, p1] and segment [q0, q1] as parameters in [0, 1] of
 *  each, from the extremum of the two lines; undefined when parallel. */
function lineLine(p0: P3, p1: P3, q0: P3, q1: P3): { s: number; t: number } | undefined {
  const u = sub(p1, p0), v = sub(q1, q0), w = sub(p0, q0);
  const a = dot(u, u), b = dot(u, v), c = dot(v, v), d = dot(u, w), e = dot(v, w);
  const den = a * c - b * b;
  if (den <= 1e-24 * a * c) return undefined;
  return { s: (b * e - c * d) / den, t: (a * e - b * d) / den };
}

function pointSegment(p: P3, a: P3, b: P3): number {
  const ab = sub(b, a);
  return dot(sub(p, a), ab) / dot(ab, ab);
}

/** The ray's hit on the loop (minimum distance, ties within 1e-7, nearest to `target`). */
function hitOnLoop(loop: Loop, origin: P3, target: P3): Hit | undefined {
  const lo: number[] = [Infinity, Infinity, Infinity], hi: number[] = [-Infinity, -Infinity, -Infinity];
  for (const { p } of loop) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k]!, p[k]!); hi[k] = Math.max(hi[k]!, p[k]!); }
  const diag = Math.hypot(hi[0]! - lo[0]!, hi[1]! - lo[1]!, hi[2]! - lo[2]!);
  const end = add(origin, mul(unit(sub(target, origin)), diag));
  const hits: Hit[] = [];
  const onRay = (s: number) => s > 0 && s < 1;
  // Vertices of the ray against vertices of the loop.
  for (const v of loop) for (const r of [origin, end]) hits.push({ vertex: v, p: v.p, d: dist(r, v.p) });
  // Ray vertices against loop edges (inside the edge).
  for (let k = 0; k < loop.length; k++) {
    const a = loop[k]!.p, b = loop[(k + 1) % loop.length]!.p;
    for (const r of [origin, end]) {
      const t = pointSegment(r, a, b);
      if (onRay(t)) { const p = add(a, mul(sub(b, a), t)); hits.push({ edge: k, t, p, d: dist(r, p) }); }
    }
  }
  // Loop vertices against the ray (inside the ray).
  for (const v of loop) {
    const s = pointSegment(v.p, origin, end);
    if (onRay(s)) hits.push({ vertex: v, p: v.p, d: dist(v.p, add(origin, mul(sub(end, origin), s))) });
  }
  // The ray against loop edges, both inside.
  for (let k = 0; k < loop.length; k++) {
    const a = loop[k]!.p, b = loop[(k + 1) % loop.length]!.p;
    const st = lineLine(origin, end, a, b);
    if (!st || !onRay(st.s) || !onRay(st.t)) continue;
    const p = add(a, mul(sub(b, a), st.t));
    hits.push({ edge: k, t: st.t, p, d: dist(p, add(origin, mul(sub(end, origin), st.s))) });
  }
  if (!hits.length) return undefined;
  const dmin = Math.min(...hits.map(h => h.d));
  let best: Hit | undefined;
  for (const h of hits) if (h.d <= dmin + CONFUSION && (!best || dist(target, h.p) < dist(target, best.p))) best = h;
  return best;
}

/**
 * Carry `p` (already moved into the target's frame: `target`) onto `loop` from `origin`.
 * Returns the vertex hit and whether it is new; inserts a new vertex into `loop`.
 */
function carry(loop: Loop, origin: P3, target: P3, isImage: (v: Vertex) => boolean, nextId: () => number): Vertex | undefined {
  const hit = hitOnLoop(loop, origin, target);
  if (!hit) return undefined;
  if (hit.vertex) return hit.vertex;
  const k = hit.edge!, a = loop[k]!, b = loop[(k + 1) % loop.length]!;
  const t = hit.t!;
  let snapped: Vertex | undefined;
  if (t < PERCENT) snapped = a;
  else if (1 - t < PERCENT) snapped = b;
  if (snapped && !isImage(snapped)) return snapped;
  const len = dist(a.p, b.p);
  if (t * len < CONFUSION || (1 - t) * len < CONFUSION) return snapped;
  const v: Vertex = { id: nextId(), p: hit.p };
  loop.splice(k + 1, 0, v);
  return v;
}

/**
 * Closed polygonal sections with equal vertex counts, to be paired index by index. Different
 * counts: matched as OCCT's ThruSections matches them (polar rule). Equal counts: as drawn
 * ('authored'), or re-started as OCCT does ('closest', computeOrigin). Undefined when the polar rule
 * fails (OCCT then fails too).
 */
export function compatibleSections(sections: readonly (readonly P3[])[], pairing: LoftPairing = 'authored'): P3[][] | undefined {
  const n = sections.length;
  if (n < 2) return sections.map(s => [...s]);
  if (sections.every(s => s.length === sections[0]!.length)) return pairing === 'closest' ? computeOrigin(sections) : sections.map(s => [...s]);
  let id = 0;
  const nextId = () => id++;
  const loops: Loop[] = sections.map(s => s.map(p => ({ id: nextId(), p })));
  const planes = sections.map(planeOf);
  const maxVertices = sections.reduce((m, s) => m + s.length, 0);

  // Backward pass: images of each section's vertices on the section below.
  const imageOf = new Map<number, number>(); // vertex id -> id of its image one section down
  const images = new Set<number>();
  for (let i = n - 1; i > 0; i--) {
    const upper = [...loops[i]!];
    if (upper.length > maxVertices) return undefined;
    for (const v of upper) {
      const target = transfer(v.p, planes[i]!, planes[i - 1]!);
      if (dist(target, planes[i - 1]!.pos) <= CONFUSION) continue;
      const w = carry(loops[i - 1]!, planes[i - 1]!.pos, target, x => images.has(x.id), nextId);
      if (!w) return undefined;
      imageOf.set(v.id, w.id);
      images.add(w.id);
    }
  }
  // Chains from the first section upward.
  const sourceOf = new Map<number, number>();
  for (const [src, img] of imageOf) if (!sourceOf.has(img)) sourceOf.set(img, src);
  const chains = new Map<number, number[]>(); // first-section vertex id -> chain of ids
  const chainOf = new Map<number, number>(); // vertex id -> chain key
  for (const v of loops[0]!) {
    const chain = [v.id];
    chainOf.set(v.id, v.id);
    let cur = v.id;
    while (chain.length < n && sourceOf.has(cur)) {
      cur = sourceOf.get(cur)!;
      if (cur === v.id) break;
      chain.push(cur);
      chainOf.set(cur, v.id);
    }
    chains.set(v.id, chain);
  }
  // Forward pass: carry vertices whose chain stops at section i up to section i + 1.
  const sizeMap = loops[0]!.length;
  for (let i = 0; i < n - 1; i++) {
    const lower = [...loops[i]!];
    if (lower.length > maxVertices || lower.length > sizeMap) return undefined;
    for (const v of lower) {
      const root = chainOf.get(v.id);
      if (root === undefined) return undefined;
      const chain = chains.get(root)!;
      const above = new Set(loops[i + 1]!.map(x => x.id));
      if (chain.some(x => above.has(x))) continue;
      const target = transfer(v.p, planes[i]!, planes[i + 1]!);
      if (dist(target, planes[i + 1]!.pos) <= CONFUSION) continue;
      const w = carry(loops[i + 1]!, planes[i + 1]!.pos, target, x => chainOf.has(x.id), nextId);
      if (!w) return undefined;
      chain.push(w.id);
      chainOf.set(w.id, root);
    }
  }
  // Walk each section from the chain member of the first section's first edge.
  const first = loops[0]!;
  const out: P3[][] = [first.map(v => v.p)];
  for (let i = 1; i < n; i++) {
    const loop = loops[i]!;
    if (loop.length !== first.length) return undefined;
    const a = chains.get(first[0]!.id)?.[i], b = chains.get(first[1]!.id)?.[i];
    const ia = loop.findIndex(v => v.id === a), ib = loop.findIndex(v => v.id === b);
    if (ia < 0 || ib < 0) return undefined;
    const m = loop.length;
    const step = (ia + 1) % m === ib ? 1 : (ib + 1) % m === ia ? -1 : 0;
    if (!step) return undefined;
    out.push(Array.from({ length: m }, (_, k) => loop[(((ia + step * k) % m) + m) % m]!.p));
  }
  return out;
}

/** Equal vertex counts: re-start each section where it lies closest to the one before. */
export function computeOrigin(sections: readonly (readonly P3[])[]): P3[][] {
  const first = planeOf(sections[0]!);
  const out: P3[][] = [[...sections[0]!]];
  let prevBary = first.pos;
  for (let i = 1; i < sections.length; i++) {
    const cur = sections[i]!, len = cur.length, prev = out[i - 1]!;
    let bary = planeOf(cur).pos;
    const v = sub(bary, prevBary);
    bary = sub(bary, mul(first.axis, dot(v, first.axis)));
    const offset = sub(prevBary, bary);
    let best = Infinity, jmin = 0, forward = true;
    const sum = (order: (n: number) => number) => {
      let s = 0;
      for (let k = 0; k < len; k++) s += dist(prev[k]!, add(cur[order(k)]!, offset));
      return s;
    };
    for (let j = 0; j < len; j++) {
      const f = sum(k => (j + k) % len);
      if (f < best) { best = f; jmin = j; forward = true; }
      const b = sum(k => (((j - k) % len) + len) % len);
      if (b < best) { best = b; jmin = j; forward = false; }
    }
    out.push(Array.from({ length: len }, (_, k) => cur[forward ? (jmin + k) % len : (((jmin - k) % len) + len) % len]!));
    prevBary = bary;
  }
  return out;
}
