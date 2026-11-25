// SPDX-License-Identifier: MIT
// Copyright (c) 2026 CrispCAD contributors
//
// Qualification gate: the lab's 27 reference parts (assets/reference-parts/scorecard.json, sources
// in assets/reference-parts/scorecard/*.kcad.ts) built through the ExactKernel interface of the
// built bundle, held to the scorecard's analytic closed forms at 1e-6 relative (1e-8 where the
// scorecard asks for it) and the bounding box to 1e-6 mm.
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSmlibKernel, type ExactKernel, type ExactProfile, type ExactSolid, type PathSegment, type Vec2 } from '../dist/index.js';

interface ScorecardPart {
  id: string; source: string;
  expected: { volumeMm3: number; surfaceAreaMm2: number; bbox: { min: number[]; max: number[] } };
  tolerance: { volumeRelative: number; surfaceAreaRelative: number };
}
const scorecard = JSON.parse(readFileSync(new URL('../../../assets/reference-parts/scorecard.json', import.meta.url), 'utf8')) as { parts: ScorecardPart[] };
const MAX_RELATIVE = 1e-6, BBOX_MM = 1e-6;
/** Parts whose analytic answer is several disjoint bodies. */
const COMPONENTS: Record<string, number> = { 'circular-pattern-pins': 6, 'linear-pattern-pins': 4, 'grid-pattern-pins': 6, 'mirrored-blocks': 2 };

let k: ExactKernel;
const worst = { volume: 0, area: 0, bbox: 0 };
beforeAll(async () => { k = await createSmlibKernel(); });
afterAll(() => { console.log(`reference parts: worst relative volume ${worst.volume.toExponential(2)}, area ${worst.area.toExponential(2)}, bbox ${worst.bbox.toExponential(2)} mm`); });

// kernelCAD conventions on top of the centred ExactKernel primitives.
const box = (x: number, y: number, z: number, centred = false) => (centred ? k.box([x, y, z]) : k.translate(k.box([x, y, z]), [x / 2, y / 2, z / 2]));
/** kernelCAD `cylinder(h, r)`: base on z = 0. */
const cylinder = (h: number, r: number) => k.translate(k.cylinder(r, h), [0, 0, h / 2]);
const path = (start: Vec2, segments: PathSegment[]): ExactProfile => k.profile.path(start, segments);
const lines = (points: Vec2[]) => path(points[0], points.slice(1).map(to => ({ kind: 'line', to })));
/** A circle as four three-point arcs, as the scorecard sources draw it. */
function circle(r: number, cx = 0): ExactProfile {
  const d = r * Math.SQRT1_2;
  return path([cx + r, 0], [
    { kind: 'arc', via: [cx + d, d], to: [cx, r] },
    { kind: 'arc', via: [cx - d, d], to: [cx - r, 0] },
    { kind: 'arc', via: [cx - d, -d], to: [cx, -r] },
    { kind: 'arc', via: [cx + d, -d], to: [cx + r, 0] },
  ]);
}
/** `hole('top', …)`: drilled from the top face centre (u, v offsets) down to `depth`. */
function drill(target: ExactSolid, top: number, at: Vec2, radius: number, depth: number): ExactSolid {
  return k.subtract(target, k.translate(k.cylinder(radius, depth + 1), [at[0], at[1], top - (depth - 1) / 2]));
}
const pin = (x: number, y: number) => k.translate(cylinder(8, 3), [x, y, 0]);
const copies = (n: number, f: (i: number) => ExactSolid) => Array.from({ length: n }, (_, i) => f(i));
const unionAll = ([first, ...rest]: ExactSolid[]) => k.union(first, ...rest);

const BUILD: Record<string, () => ExactSolid> = {
  'rectangular-block': () => box(40, 30, 20),
  'centered-block': () => box(24, 18, 6, true),
  cylinder: () => cylinder(50, 10),
  sphere: () => k.sphere(12),
  'torus-revolve': () => k.revolve(circle(5, 20), 360),
  'cone-frustum-revolve': () => k.revolve(lines([[0, 0], [10, 0], [6, 20], [0, 20]]), 360),
  'plate-through-hole': () => drill(box(60, 40, 10), 10, [30, 20], 5, 12),
  'plate-blind-hole': () => drill(box(40, 30, 12), 12, [20, 15], 4, 5),
  'plate-counterbore': () => drill(drill(box(40, 30, 10), 10, [20, 15], 3, 12), 10, [20, 15], 5, 4),
  'plate-through-slot': () => k.subtract(box(50, 30, 10), k.translate(box(20, 8, 12), [15, 11, -1])),
  'annular-cylinder': () => k.subtract(cylinder(20, 15), cylinder(20, 5)),
  'open-top-shell': () => k.shell(box(50, 40, 30), 3, { faceNormal: [0, 0, 1], outermost: true }),
  'l-bracket-union': () => k.union(box(40, 20, 8), k.translate(box(8, 20, 20), [0, 0, 8])),
  'boolean-intersection': () => k.intersect(box(20, 20, 20), k.translate(box(10, 30, 20), [5, -5, 0])),
  'rounded-box': () => k.fillet(box(40, 30, 20), 3),
  'top-edge-chamfer': () => k.chamfer(box(40, 30, 20), 2, { faceNormal: [0, 0, 1] }),
  'plate-four-holes': () => [[-25, -15], [25, -15], [-25, 15], [25, 15]].reduce((plate, [u, v]) => drill(plate, 10, [40 + u, 25 + v], 3, 12), box(80, 50, 10)),
  'circular-pattern-pins': () => unionAll(copies(6, i => k.rotate(pin(20, 0), [0, 0, 1], 60 * i))),
  'linear-pattern-pins': () => unionAll(copies(4, i => pin(5 + 10 * i, 0))),
  'grid-pattern-pins': () => unionAll(copies(6, i => pin(4 + 10 * (i % 3), 5 + 10 * Math.floor(i / 3)))),
  'mirrored-blocks': () => { const block = k.translate(box(10, 10, 10), [10, 0, 0]); return k.union(block, k.mirror(block, [1, 0, 0])); },
  'sweep-square-prism': () => k.sweep(lines([[-2, -2], [2, -2], [2, 2], [-2, 2]]), [[0, 0, 0], [0, 0, 30]]),
  'sweep-round-prism': () => k.sweep(circle(5), [[0, 0, 0], [0, 0, 20]]),
  'loft-circular-frustum': () => k.loft([{ profile: circle(10), at: [0, 0, 0] }, { profile: circle(5), at: [0, 0, 20] }]),
  'loft-square-frustum': () => k.loft([
    { profile: lines([[-10, -10], [10, -10], [10, 10], [-10, 10]]), at: [0, 0, 0] },
    { profile: lines([[-6, -6], [6, -6], [6, 6], [-6, 6]]), at: [0, 0, 10] },
  ]),
  'stepped-shaft-revolve': () => k.revolve(lines([[0, 0], [4, 0], [4, 10], [8, 10], [8, 20], [0, 20]]), 360),
  'rotated-box': () => k.rotate(box(40, 20, 5), [0, 0, 1], 30),
};

describe('lab reference parts on the bundled SMLib kernel (exact)', () => {
  it('covers all 27 scorecard parts', () => {
    expect(scorecard.parts).toHaveLength(27);
    expect(Object.keys(BUILD).sort()).toEqual(scorecard.parts.map(p => p.id).sort());
  });
  for (const part of scorecard.parts) it(part.id, () => {
    const solid = k.scope(() => BUILD[part.id]());
    try {
      expect(k.isValid(solid)).toBe(true);
      expect(k.solidCount(solid)).toBe(COMPONENTS[part.id] ?? 1);
      const e = part.expected;
      const volume = Math.abs(k.volume(solid) - e.volumeMm3) / e.volumeMm3;
      const area = Math.abs(k.area(solid) - e.surfaceAreaMm2) / e.surfaceAreaMm2;
      const { min, max } = k.bbox(solid);
      const bbox = Math.max(...[0, 1, 2].flatMap(i => [Math.abs(min[i] - e.bbox.min[i]), Math.abs(max[i] - e.bbox.max[i])]));
      worst.volume = Math.max(worst.volume, volume); worst.area = Math.max(worst.area, area); worst.bbox = Math.max(worst.bbox, bbox);
      expect(volume).toBeLessThanOrEqual(Math.min(MAX_RELATIVE, part.tolerance.volumeRelative));
      expect(area).toBeLessThanOrEqual(Math.min(MAX_RELATIVE, part.tolerance.surfaceAreaRelative));
      expect(bbox).toBeLessThanOrEqual(BBOX_MM);
    } finally { solid.dispose(); }
  });
  it('round-trips every part through STEP exactly', () => {
    for (const part of scorecard.parts) k.scope(() => {
      const solid = BUILD[part.id](), back = k.importStep(k.exportStep(solid));
      expect(Math.abs(k.volume(back) - k.volume(solid)) / k.volume(solid), part.id).toBeLessThanOrEqual(1e-9);
      return 0;
    });
  });
  it('frees every kernel object afterwards', () => {
    expect(k.memory().handles).toBe(0);
  });
});
