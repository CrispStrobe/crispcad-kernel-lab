// SPDX-License-Identifier: MIT
// Copyright (c) 2026 CrispCAD contributors
// Features the native SMLib kernel gained for the last catalog failures (docs/kernels.md),
// against closed forms: holes on side faces, multi-loop sketches, lofts on YZ/XZ planes and
// to apex points, helical sweeps, and self-touching polygon outlines; self-crossing outlines are
// refused.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildModel } from '../../buildModel';
import { polygonLoops } from './polygonLoops';
import { outlineCrossing } from './profileCrossing';
import type { ShapeBackend } from '../../../kernel/backends/backend';

async function native(code: string): Promise<ShapeBackend> {
  const model = await buildModel({ code, fileName: 'gap.kcad.ts', kernel: 'smlib-native' });
  expect(model.diagnostics.filter(d => d.severity === 'error').map(d => d.message)).toEqual([]);
  return model.rootShape!;
}
const rel = (a: number, b: number) => Math.abs(a - b) / Math.abs(b);
const expectBox = (s: ShapeBackend, min: number[], max: number[]) => {
  const b = s.boundingBox();
  for (let i = 0; i < 3; i++) { expect(b.min[i]).toBeCloseTo(min[i], 6); expect(b.max[i]).toBeCloseTo(max[i], 6); }
};
const PROFILE = 'path().moveTo(0.5,-1).lineTo(3,-0.6).lineTo(2.2,1.2).lineTo(0.2,0.8).close()';
const PTS = [[0.5, -1], [3, -0.6], [2.2, 1.2], [0.2, 0.8]];
/** Area and first moment in x of PTS. */
const moments = () => {
  let a2 = 0, mx6 = 0;
  PTS.forEach(([x0, y0], i) => { const [x1, y1] = PTS[(i + 1) % PTS.length], c = x0 * y1 - x1 * y0; a2 += c; mx6 += (x0 + x1) * c; });
  return { area: Math.abs(a2 / 2), mx: Math.abs(mx6 / 6) };
};

describe('native SMLib: former catalog gaps', () => {
  it('drills holes on left, right, front and back faces in OCCT\'s (u, v) frame', async () => {
    const s = await native("return box(20, 50, 80).hole('left', { u: 5, v: 11, diameter: 8, depth: 'through' }).hole('front', { u: 3, v: -20, diameter: 6, depth: 12 }).hole('back', { u: -4, v: 25, diameter: 5, depth: 'through' }).hole('right', { u: -9, v: -30, diameter: 4, depth: 7 })");
    const disc = (d: number) => Math.PI * (d / 2) ** 2;
    expect(rel(s.volume(), 20 * 50 * 80 - disc(8) * 20 - disc(6) * 12 - disc(5) * 50 - disc(4) * 7)).toBeLessThan(1e-9);
    expect(rel(s.volume(), 77585.68604571625)).toBeLessThan(1e-9); // the OCCT build
  });

  it('fills a sketch of several loops even-odd (a moveTo starts the next loop)', async () => {
    const s = await native('return path().moveTo(-60, -62).lineTo(60, -62).lineTo(60, 62).lineTo(-60, 62).moveTo(-40, -28).lineTo(-40, 28).lineTo(40, 28).lineTo(40, -28).moveTo(45, 40).lineTo(55, 40).lineTo(55, 50).close().extrude(10)');
    expect(rel(s.volume(), (120 * 124 - 80 * 56 - 50) * 10)).toBeLessThan(1e-12);
    expect(s.surfaceArea()).toBeGreaterThan(0);
  });

  it('lofts sections on YZ and XZ planes as replicad places them', async () => {
    const sq = (h: number) => `path().moveTo(${-h},${-h}).lineTo(${h},${-h}).lineTo(${h},${h}).lineTo(${-h},${h}).close()`;
    const yz = await native(`return ${sq(5)}.loft([${sq(3)}], { planes: [{ plane: 'YZ', origin: [0, 1, 2] }, { plane: 'YZ', origin: [30, 1, 2] }], ruled: true })`);
    expect(rel(yz.volume(), (30 / 3) * (100 + 36 + 60))).toBeLessThan(1e-9);
    expectBox(yz, [0, -4, -3], [30, 6, 7]);
    const xz = await native(`return ${sq(5)}.loft([${sq(3)}], { planes: [{ plane: 'XZ', origin: [1, 0, 2] }, { plane: 'XZ', origin: [1, 30, 2] }], ruled: true })`);
    expect(rel(xz.volume(), (30 / 3) * (100 + 36 + 60))).toBeLessThan(1e-9);
    expectBox(xz, [-4, 0, -3], [6, 30, 7]);
  });

  it('runs a ruled loft on to its startPoint and endPoint', async () => {
    const d = 'path().moveTo(10,0).lineTo(0,10).lineTo(-10,0).lineTo(0,-10).close()';
    const s = await native(`return ${d}.loft(${d}, { ruled: true, planes: [{ plane: 'XY', origin: [0,0,-3] }, { plane: 'XY', origin: [0,0,3] }], startPoint: [0,0,-6], endPoint: [1,2,9] })`);
    expect(rel(s.volume(), 200 * 6 + (200 * 3) / 3 + (200 * 6) / 3)).toBeLessThan(1e-9);
    expectBox(s, [-10, -10, -6], [10, 10, 9]);
  });

  for (const axis of ['Z', 'X', 'Y']) {
    it(`sweeps an axial profile along an exact helix about ${axis} (closed-form volume)`, async () => {
      const s = await native(`return ${PROFILE}.sweep(helix({ radius: 8, pitch: 4, turns: 2.3, startAngle: 0.4, axis: '${axis}' }), { spine: 'helix' })`);
      const { area, mx } = moments();
      expect(rel(s.volume(), 2 * Math.PI * 2.3 * (8 * area + mx))).toBeLessThan(2e-6);
    });
    it(`sweeps a transverse section along a helix about ${axis} (a twisted extrusion)`, async () => {
      const s = await native(`return ${PROFILE}.sweep(helix({ radius: 8, pitch: 4, turns: 2.3, startAngle: 0.4, axis: '${axis}' }), { spine: 'helix', section: 'transverse' })`);
      expect(rel(s.volume(), moments().area * 4 * 2.3)).toBeLessThan(1e-6);
    });
  }

  it('places helical sweeps as the OCCT build does (0.3 turns, start angle 0.4)', async () => {
    // Boxes of the OCCT builds; OCCT's own box of these B-spline faces is up to 6e-4 loose.
    const axial = await native(`return ${PROFILE}.sweep(helix({ radius: 8, pitch: 4, turns: 0.3, startAngle: 0.4, axis: 'Y' }), { spine: 'helix' })`);
    const a = axial.boundingBox();
    [-7.2048, -1, 3.1932].forEach((v, i) => expect(a.min[i]).toBeCloseTo(v, 3));
    [10.1317, 2.4, 11.0004].forEach((v, i) => expect(a.max[i]).toBeCloseTo(v, 2));
    const transverse = await native(`return ${PROFILE}.sweep(helix({ radius: 8, pitch: 4, turns: 0.3, startAngle: 0.4, axis: 'Y' }), { spine: 'helix', section: 'transverse' })`);
    const t = transverse.boundingBox();
    [-2.4183, 0, -0.659].forEach((v, i) => expect(t.min[i]).toBeCloseTo(v, 3));
    [2.5295, 1.2, 3.0601].forEach((v, i) => expect(t.max[i]).toBeCloseTo(v, 2));
  });

  it('extrudes self-touching polygon outlines (SMLib Polygon rejected them)', async () => {
    // Chevron whose arms meet in one vertex (miniature-park-tram-engine).
    const chevron = await native('return extrudePolygon([[-1040,-360],[-1210,0],[-1040,360],[-1060,360],[-1210,0],[-1060,-360]], 34)');
    expect(rel(chevron.volume(), 244800)).toBeLessThan(1e-12);
    // A frame drawn as one outline with a zero-width slit (skid-steer-loader door frame).
    const frame = await native('return extrudePolygon([[-420,860],[420,860],[400,1880],[-400,1880],[-400,1820],[340,1820],[360,920],[-360,920],[-360,1820],[-400,1820]], 30)');
    expect(rel(frame.volume(), 5904000)).toBeLessThan(1e-12);
    expect(frame.surfaceArea()).toBeGreaterThan(0);
    // A closing edge that runs back along the first one (impulse-merchandiser upright).
    const spike = await native('return extrudePolygon([[-180,110],[180,110],[180,1500],[60,1500],[-140,1240],[-140,110]], 16)');
    expect(rel(spike.volume(), 6700800)).toBeLessThan(1e-12);
  });

  it('refuses outlines that cross themselves (alpine-helmet chin strap as first written) with a clear error', async () => {
    // A bow tie with lobes of 493 and 89 mm^2. SMLib built it as a solid of volume -5656 (5656
    // mirrored) and area 4376.8; OpenCASCADE builds the same signed volume, invalid by BRepCheck.
    const refused = async (code: string) => {
      const model = await buildModel({ code, fileName: 'gap.kcad.ts', kernel: 'smlib-native' });
      const errors = model.diagnostics.filter(d => d.severity === 'error');
      expect(errors[0]?.code).toBe('recompute.lowering.exception');
      return errors[0].message;
    };
    expect(await refused('return path().moveTo(112,66).lineTo(96,62).lineTo(18,0).lineTo(4,6).close().extrude(14)'))
      .toBe('The sketch outline crosses itself at (75.5714, 45.7619), so it bounds no region and cannot be built as a solid.');
    expect(await refused('return extrudePolygon([[-112,66],[-96,62],[-18,0],[-4,6]], 14)')).toMatch(/^The polygon outline crosses itself at \(-75\.5714, 45\.7619\)/);
    expect(await refused('return path().moveTo(0,100).lineTo(59,-81).lineTo(-95,31).lineTo(95,31).lineTo(-59,-81).close().revolve()')).toMatch(/crosses itself/);
    expect(await refused('return path().moveTo(0,0).lineTo(10,0).sagittaArc(10,10,12).close().extrude(1)')).toMatch(/crosses itself/);
    const file = fileURLToPath(new URL('../../../../catalog/kits/alpine-expedition/alpine-helmet.kcad.ts', import.meta.url));
    // The catalog helmet's strap vertices were reordered into the simple outline they meant: it builds.
    const helmet = await buildModel({ code: readFileSync(file, 'utf8'), fileName: file, kernel: 'smlib-native' });
    expect(helmet.diagnostics.filter(d => d.severity === 'error')).toEqual([]);
  });

  it('lofts ruled sections vertex to vertex as drawn (an 8-point square to an octagon: ground-tile, hill-tile)', async () => {
    // The square's corners and edge midpoints make neighbouring edges run on collinearly, and
    // makeFace starts its face boundary at another vertex; lofting the faces twisted the solid
    // (113.4e6 mm^3). The sections now loft through their outlines as drawn, as OCCT's do.
    const square = [[1000, 0], [1000, 1000], [0, 1000], [-1000, 1000], [-1000, 0], [-1000, -1000], [0, -1000], [1000, -1000]];
    const octagon = square.map((_, i) => [550 * Math.cos(0.1 + (i * Math.PI) / 4), 550 * Math.sin(0.1 + (i * Math.PI) / 4)]);
    const area = (p: number[][]) => p.reduce((sum, a, i) => sum + (a[0] * p[(i + 1) % p.length][1] - p[(i + 1) % p.length][0] * a[1]) / 2, 0);
    const at = (s: number) => square.map((a, i) => [(1 - s) * a[0] + s * octagon[i][0], (1 - s) * a[1] + s * octagon[i][1]]);
    const exact = (100 * (area(at(0)) + 4 * area(at(0.5)) + area(at(1)))) / 6;
    const path = (p: number[][]) => `path().moveTo(${p[0]})${p.slice(1).map(q => `.lineTo(${q})`).join('')}.close()`;
    const lofted = await native(`return ${path(square)}.loft([${path(octagon)}], { planes: [{ plane: 'XY', origin: [0, 0, 0] }, { plane: 'XY', origin: [0, 0, 100] }], ruled: true })`);
    expect(rel(lofted.volume(), exact)).toBeLessThan(1e-12);
  });

  it('tells crossing from touching', () => {
    expect(outlineCrossing([[0, 0], [10, 0], [10, 10], [5, 0], [0, 10]])).toBeNull(); // vertex on an edge
    expect(outlineCrossing([[0, 0], [10, 0], [10, 10], [5, -1e-12], [0, 10]])).toBeNull();
    expect(outlineCrossing([[0, 0], [10, 0], [10, 10], [5, 0], [5, -5], [-5, -5], [-5, 10]])).toEqual({ edges: [0, 2], at: [5, 0] }); // through a vertex
    expect(outlineCrossing([[-180, 110], [180, 110], [180, 1500], [60, 1500], [-140, 1240], [-140, 110]])).toBeNull(); // back-running edge
    expect(outlineCrossing([[0, 0], [1, 0], [1, 1], [0, 1]])).toBeNull();
  });

  it('checks outlines with the same code as @crispcad/exact-kernel outline.ts', () => {
    const MARKER = '// ---- shared with src/modeling/backends/smlib/profileCrossing.ts below this line ----';
    const shared = (path: string) => { const text = readFileSync(fileURLToPath(new URL(`../../../../${path}`, import.meta.url)), 'utf8'); return text.slice(text.indexOf(MARKER)); };
    const lab = shared('src/modeling/backends/smlib/profileCrossing.ts');
    expect(lab.startsWith(MARKER)).toBe(true);
    expect(lab).toBe(shared('packages/exact-kernel/src/outline.ts'));
  });

  it('splits outlines into simple loops, largest first', () => {
    const square = [[0, 0], [1, 0], [1, 1], [0, 1]] as [number, number][];
    expect(polygonLoops(square)[0]).toBe(square);
    const ring = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0], [2, 2], [2, 8], [8, 8], [8, 2], [2, 2]] as [number, number][];
    expect(polygonLoops(ring).map(l => l.length)).toEqual([4, 4]);
  });
});
