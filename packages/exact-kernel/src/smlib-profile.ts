// SPDX-License-Identifier: MIT
// Copyright (c) 2026 CrispCAD contributors
//
// 2D profile operations of the SMLib ExactKernel. Path profiles follow the lab's native
// sketch lowering (src/modeling/backends/smlib/nativeLowerer.ts, SKETCH_STEPS).
import { ExactKernelError, type ExactProfileOps, type PathSegment, type Vec2 } from './exact-kernel.ts';
import { call, profileOf, sketchOf, type Smlib } from './smlib-context.ts';
import { outlineCrossing, type OutlinePoint } from './outline.ts';
import { finite, invalid, positive } from './validate.ts';

type Edge = InstanceType<Smlib['Edge']>;
const xyz = (p: Vec2): [number, number, number] => [p[0], p[1], 0];

function pathEdges(sm: Smlib, start: Vec2, segments: readonly PathSegment[]): Edge[] {
  let at = start;
  const edges: Edge[] = [];
  const point = (what: string, p: Vec2) => { if (!Array.isArray(p) || p.length !== 2) invalid(`${what} must be a 2D point.`); finite(what, p[0], p[1]); return p; };
  for (const s of segments) {
    const to = s.kind === 'spline' ? point('Spline point', s.through.at(-1) ?? invalid('A spline needs at least one point.')) : point('Path point', s.to);
    if (s.kind === 'line') edges.push(sm.Line(xyz(at), xyz(to)));
    else if (s.kind === 'arc') edges.push(sm.ThreePointArc(xyz(at), xyz(point('Arc point', s.via)), xyz(to)));
    else if (s.kind === 'radiusArc') { finite('Arc radius', s.radius); edges.push(sm.RadiusArc(xyz(at), xyz(to), s.radius)); }
    else if (s.kind === 'sagittaArc') { finite('Arc sagitta', s.sagitta); edges.push(sm.SagittaArc(xyz(at), xyz(to), s.sagitta)); }
    else if (s.kind === 'spline') edges.push(sm.Spline(xyz(at), ...s.through.map(p => xyz(point('Spline point', p)))));
    else invalid(`Unknown path segment kind '${(s as { kind: string }).kind}'.`);
    at = to;
  }
  if (Math.hypot(at[0] - start[0], at[1] - start[1]) > 1e-9) edges.push(sm.Line(xyz(at), xyz(start)));
  return edges;
}

/** Refuse an outline that crosses itself: it bounds no region (outline.ts). */
function refuseCrossing(what: string, outline: readonly OutlinePoint[]): void {
  const crossing = outlineCrossing(outline);
  if (!crossing) return;
  const [x, y] = crossing.at.map(v => +v.toPrecision(6));
  invalid(`The ${what} crosses itself at (${x}, ${y}), so it bounds no region. Reorder its points so no edges cross, or give each region its own contour.`);
}

/** Points along a closed loop of edges: each line's start, 32 points along each curved edge. */
function loopOutline(edges: readonly Edge[]): OutlinePoint[] {
  const out: OutlinePoint[] = [];
  for (const edge of edges) {
    const a = edge.pointAt(0), b = edge.pointAt(1);
    const straight = Math.abs(edge.length - Math.hypot(b.x - a.x, b.y - a.y)) <= 1e-9 * Math.max(1, edge.length);
    const n = straight ? 1 : 32;
    for (let k = 0; k < n; k++) { const p = k ? edge.pointAt(k / n) : a; out.push([p.x, p.y]); }
  }
  return out;
}

export function createProfileOps(sm: Smlib): ExactProfileOps {
  return {
    polygon(contours) {
      if (!Array.isArray(contours) || !contours.length) invalid('A polygon profile needs at least one contour.');
      for (const c of contours) {
        if (!Array.isArray(c) || c.length < 3) invalid('Each polygon contour needs at least three points.');
        for (const p of c) finite('Polygon points', p[0], p[1]);
        refuseCrossing('polygon contour', c);
      }
      return call('Polygon', () => {
        // Even-odd fill: the symmetric difference of the contour regions, largest first (SMLib's
        // xor of a hole with its outer region, in that order, inverts the solid's faces).
        const regions = contours.map(c => sm.Polygon(c.map((p: Vec2) => [p[0], p[1]] as [number, number]))).sort((a, b) => b.area - a.area);
        const single = contours.length === 1 ? contours[0]!.filter((p: Vec2, i: number, c: readonly Vec2[]) => i < c.length - 1 || p[0] !== c[0]![0] || p[1] !== c[0]![1]) : undefined;
        return profileOf(regions.length === 1 ? regions[0] : sm.xor(regions[0], ...regions.slice(1)), undefined, single?.map((p: Vec2) => [p[0], p[1], 0] as const));
      });
    },
    circle(radius) { positive('Circle radius', radius); return call('Circle', () => profileOf(sm.Circle(radius))); },
    rectangle(width, height, centred) {
      positive('Rectangle size', width, height);
      return call('Rectangle', () => profileOf(centred ? sm.Rectangle(width, height) : sm.Rectangle(width, height, { align: 'min' })));
    },
    roundedRectangle(width, height, radius) {
      positive('Rounded rectangle size and radius', width, height, radius);
      if (radius >= Math.min(width, height) / 2) invalid('The corner radius must be below half the short side.');
      return call('RoundedRectangle', () => profileOf(sm.RoundedRectangle(width, height, radius)));
    },
    path(start, segments) {
      if (!Array.isArray(segments) || !segments.length) invalid('A path profile needs at least one segment.');
      finite('Path start', ...(Array.isArray(start) ? start : [NaN]));
      return call('path', () => {
        const edges = pathEdges(sm, start, segments);
        const outline = loopOutline(edges);
        refuseCrossing('path outline', outline);
        const polygon = outline.length === edges.length ? outline.map(([x, y]) => [x, y, 0] as const) : undefined;
        return profileOf(sm.makeFace(new sm.Wire(edges)), new sm.Wire(edges), polygon);
      });
    },
    text(content, size) {
      if (typeof content !== 'string' || !content.length) invalid('Text must be a non-empty string.');
      positive('Text size', size);
      try {
        return profileOf(sm.Text(content, size));
      } catch (error) {
        if (error instanceof sm.FontError) throw new ExactKernelError('unsupported', `Text needs a font, and this package ships none (the upstream default font is left out): ${error.message}`, { cause: error });
        return call('Text', () => { throw error; });
      }
    },
    union: (first, ...rest) => call('fuse (2D)', () => profileOf(rest.length ? sm.fuse(sketchOf(first), ...rest.map(sketchOf)) : sketchOf(first))),
    subtract: (base, ...cutters) => call('cut (2D)', () => profileOf(cutters.length ? sm.cut(sketchOf(base), ...cutters.map(sketchOf)) : sketchOf(base))),
    intersect: (first, ...rest) => call('intersect (2D)', () => profileOf(rest.length ? sm.intersect(sketchOf(first), ...rest.map(sketchOf)) : sketchOf(first))),
    hull: (...profiles) => {
      if (!profiles.length) invalid('A hull needs at least one profile.');
      return call('Hull (2D)', () => profileOf(sm.Hull(...profiles.map(sketchOf))));
    },
    translate: (p, [x, y]) => { finite('Profile offset', x, y); return call('translate (2D)', () => profileOf(sketchOf(p).translate([x, y, 0]))); },
    rotate: (p, degrees) => { finite('Profile angle', degrees); return call('rotate (2D)', () => profileOf(sketchOf(p).rotate(sm.Axis.Z, degrees))); },
    scale: (p, [x, y]) => {
      finite('Profile scale', x, y);
      if (x === 0 || y === 0) invalid('A zero profile scale flattens the profile.');
      return call('scale (2D)', () => profileOf(sketchOf(p).scale([x, y, 1])));
    },
    offset: (p, distance, round) => {
      finite('Profile offset distance', distance);
      return call('offset (2D)', () => profileOf(sm.offset(sketchOf(p), distance, { corners: round ? 'round' : 'sharp' })));
    },
    bounds: p => {
      const b = sketchOf(p).bbox();
      return { min: [b.min.x, b.min.y], max: [b.max.x, b.max.y] };
    },
    area: p => call('area (2D)', () => sketchOf(p).area),
  };
}
