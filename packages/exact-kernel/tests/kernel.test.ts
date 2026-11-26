// SPDX-License-Identifier: MIT
// Copyright (c) 2026 CrispCAD contributors
//
// The ExactKernel interface of the built bundle: fillet/chamfer/shell and the lab-derived
// operations against closed forms, and clean rejection of malformed input.
import { beforeAll, describe, expect, it } from 'vitest';
import { convexHull, createSmlibKernel, ExactKernelError, type ExactKernel, type ExactSolid } from '../dist/index.js';

let k: ExactKernel;
beforeAll(async () => { k = await createSmlibKernel(); });
const rel = (a: number, b: number) => Math.abs(a - b) / Math.abs(b);
const measured = (s: ExactSolid) => { try { return { volume: k.volume(s), area: k.area(s), valid: k.isValid(s) }; } finally { s.dispose(); } };
const rejects = (fn: () => unknown, code: ExactKernelError['code'], pattern?: RegExp) => {
  let error: unknown;
  try { const r = fn() as { dispose?: () => void } | undefined; r?.dispose?.(); } catch (e) { error = e; }
  expect(error, 'expected an ExactKernelError').toBeInstanceOf(ExactKernelError);
  expect((error as ExactKernelError).code).toBe(code);
  if (pattern) expect((error as Error).message).toMatch(pattern);
};

describe('fillet, chamfer, shell (closed forms from the kernelCAD scorecard)', () => {
  it('fillets every edge of a 40x30x20 box at r = 3', () => {
    const m = measured(k.scope(() => k.fillet(k.box([40, 30, 20]), 3)));
    expect(m.valid).toBe(true);
    expect(rel(m.volume, 23340.84937505542)).toBeLessThanOrEqual(1e-8);
    expect(rel(m.area, 4726.265361880022)).toBeLessThanOrEqual(1e-8);
  });
  it('chamfers the top edges by 2', () => {
    const m = measured(k.scope(() => k.chamfer(k.box([40, 30, 20]), 2, { faceNormal: [0, 0, 1] })));
    expect(rel(m.volume, 23730.666666666664)).toBeLessThanOrEqual(1e-8);
    expect(rel(m.area, 5029.352380466496)).toBeLessThanOrEqual(1e-8);
  });
  it('shells a 50x40x30 box to 3 mm with the top open', () => {
    const m = measured(k.scope(() => k.shell(k.box([50, 40, 30]), 3, [0, 0, 1])));
    expect(rel(m.volume, 19608)).toBeLessThanOrEqual(1e-8);
    expect(rel(m.area, 13612)).toBeLessThanOrEqual(1e-8);
  });
  it('shells with two open faces', () => {
    const m = measured(k.scope(() => k.shell(k.box([50, 40, 30]), 3, [[0, 0, 1], [0, 0, -1]])));
    expect(rel(m.volume, 50 * 40 * 30 - 44 * 34 * 30)).toBeLessThanOrEqual(1e-8);
  });
  it('fillets a cylinder rim exactly (torus quarter)', () => {
    const rf = 2, R = 10, cross = rf * rf * (1 - Math.PI / 4), xbar = R - rf * (10 - 3 * Math.PI) / (12 - 3 * Math.PI);
    const m = measured(k.scope(() => k.fillet(k.cylinder(R, 20), rf, { faceNormal: [0, 0, 1] })));
    expect(rel(m.volume, Math.PI * R * R * 20 - 2 * Math.PI * xbar * cross)).toBeLessThanOrEqual(1e-8);
  });
  it('builds a filleted, shelled box (the qualification stress case)', () => {
    const m = measured(k.scope(() => k.shell(k.fillet(k.box([60, 40, 30]), 4), 2, [0, 0, 1])));
    expect(m.valid).toBe(true);
    expect(m.volume).toBeCloseTo(14950.678, 2);
  });
  it('picks the outermost of several parallel faces on request', () => {
    rejects(() => k.scope(() => k.chamfer(k.union(k.box([20, 20, 10]), k.translate(k.box([10, 10, 10]), [0, 0, 10])), 1, { faceNormal: [0, 0, 1] })), 'invalid-input', /found 2/);
    const m = measured(k.scope(() => k.chamfer(k.union(k.box([20, 20, 10]), k.translate(k.box([10, 10, 10]), [0, 0, 10])), 1, { faceNormal: [0, 0, 1], outermost: true })));
    // Top edges of the 10 mm tower chamfered by 1: (d^2 / 2) * perimeter - (4 / 3) d^3 removed.
    expect(rel(m.volume, 4000 + 1000 - (0.5 * 40 - 4 / 3))).toBeLessThanOrEqual(1e-8);
  });
});

describe('operations from the lab native backend', () => {
  it('measures mass properties of a box', () => {
    const s = k.box([2, 4, 6]), m = k.massProperties(s); s.dispose();
    expect(m.volume).toBeCloseTo(48, 12);
    for (const c of m.centroid) expect(Math.abs(c)).toBeLessThan(1e-12);
    // I_xx = V (b^2 + c^2) / 12 at unit density.
    expect(m.inertia[0][0]).toBeCloseTo(48 * (16 + 36) / 12, 9);
    expect([...m.principalMoments].sort((a, b) => a - b).map(v => +v.toFixed(9))).toEqual([80, 160, 208]);
  });
  it('builds profiles from paths with radius and sagitta arcs, splines and rounded rectangles', () => {
    const slot = k.profile.path([0, -5], [{ kind: 'line', to: [20, -5] }, { kind: 'radiusArc', to: [20, 5], radius: -5 }, { kind: 'line', to: [0, 5] }, { kind: 'sagittaArc', to: [0, -5], sagitta: -5 }]);
    // Positive radius / sagitta bulge to the left of the direction of travel: negative here bulges outward.
    expect(k.profile.area(slot)).toBeCloseTo(200 + 25 * Math.PI, 9);
    const rr = k.profile.roundedRectangle(20, 10, 2);
    expect(k.profile.area(rr)).toBeCloseTo(200 - (4 - Math.PI) * 4, 9);
    const spline = k.profile.path([0, 0], [{ kind: 'line', to: [10, 0] }, { kind: 'spline', through: [[8, 4], [0, 6]] }]);
    expect(k.profile.area(spline)).toBeGreaterThan(30);
    [slot, rr, spline].forEach(p => p.dispose());
  });
  it('lofts ruled and smooth sections and sweeps along a polyline', () => {
    const ruled = measured(k.scope(() => k.loft([{ profile: k.profile.rectangle(10, 10, true), at: [0, 0, 0] }, { profile: k.profile.rectangle(10, 10, true), at: [0, 0, 5] }, { profile: k.profile.rectangle(4, 4, true), at: [0, 0, 8] }], { ruled: true })));
    expect(rel(ruled.volume, 500 + 3 / 3 * (100 + 16 + 40))).toBeLessThan(1e-9);
    const swept = measured(k.scope(() => k.sweep(k.profile.circle(1), [[0, 0, 0], [0, 0, 10], [10, 0, 10]])));
    expect(swept.valid).toBe(true);
    expect(swept.volume).toBeGreaterThan(Math.PI * 15);
  });
  it('splits by a plane and lists components', () => {
    k.scope(() => {
      const [above, below] = k.splitByPlane(k.box([10, 10, 10]), [0, 0, 1], 2);
      expect(k.volume(above)).toBeCloseTo(300, 9);
      expect(k.volume(below)).toBeCloseTo(700, 9);
      const parts = k.components(k.union(k.box([1, 1, 1]), k.translate(k.box([1, 1, 1]), [5, 0, 0])));
      expect(parts).toHaveLength(2);
      expect(parts.map(p => k.volume(p))).toEqual([1, 1].map(v => expect.closeTo(v, 12)));
      return 0;
    });
  });
  it('mirrors about an offset plane', () => {
    k.scope(() => {
      const b = k.bbox(k.mirror(k.translate(k.box([2, 2, 2]), [1, 0, 0]), [1, 0, 0], [5, 0, 0]));
      expect(b.min[0]).toBeCloseTo(8, 12); expect(b.max[0]).toBeCloseTo(10, 12);
      return 0;
    });
  });
  it('tessellates with vertex normals and writes binary STL', () => {
    k.scope(() => {
      const s = k.sphere(5), mesh = k.tessellate(s, { tolerance: 0.05 });
      expect(mesh.normals.length).toBe(mesh.positions.length);
      for (let i = 0; i < mesh.positions.length; i += 300) {
        const p = [mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2]], n = [mesh.normals[i], mesh.normals[i + 1], mesh.normals[i + 2]];
        expect(p.reduce((acc, v, j) => acc + v * n[j], 0) / 5).toBeGreaterThan(0.99);
      }
      const stl = k.exportStl(s), triangles = new DataView(stl.buffer, stl.byteOffset).getUint32(80, true);
      expect(stl.length).toBe(84 + 50 * triangles);
      return 0;
    });
  });
  it('exports the exact convex hull helper', () => {
    const hull = convexHull([[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], [0.1, 0.1, 0.1]]);
    expect(hull.points).toHaveLength(4);
    expect(hull.faces).toHaveLength(4);
  });
});

describe('malformed input is rejected cleanly and the kernel stays usable', () => {
  it('rejects invalid dimensions before calling the kernel', () => {
    rejects(() => k.box([10, -1, 10]), 'invalid-input');
    rejects(() => k.sphere(Number.NaN), 'invalid-input');
    rejects(() => k.cylinder(Infinity, 1), 'invalid-input');
    rejects(() => k.torus(5, 5), 'invalid-input');
    rejects(() => k.profile.polygon([[[0, 0], [1, 1]]]), 'invalid-input');
    rejects(() => k.profile.path([0, 0], []), 'invalid-input');
    rejects(() => k.profile.path([0, 0], [{ kind: 'line', to: [Number.NaN, 1] }]), 'invalid-input');
    rejects(() => k.profile.roundedRectangle(10, 4, 2), 'invalid-input');
    rejects(() => k.polyhedron([[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]], [[0, 1, 2], [0, 1, 9], [0, 2, 3], [1, 2, 3]]), 'invalid-input');
    rejects(() => k.revolve(k.profile.circle(1), 400), 'invalid-input');
    rejects(() => k.scope(() => k.loft([{ profile: k.profile.circle(1), at: [0, 0, 0] }])), 'invalid-input');
    rejects(() => k.scope(() => k.sweep(k.profile.circle(1), [[0, 0, 0]])), 'invalid-input');
    rejects(() => k.scope(() => k.splitByPlane(k.box([1, 1, 1]), [0, 0, 0], 0)), 'invalid-input');
    rejects(() => k.tessellate(k.box([1, 1, 1]), { tolerance: -1 }), 'invalid-input');
  });
  it('refuses outlines that cross themselves instead of building a solid of signed area', () => {
    // CrispCAD catalog alpine-helmet chin strap: a bow tie with lobes of 493 and 89 mm^2. SMLib
    // built it as a face of area 404 and an extrusion of volume -5656 (or 5656 mirrored).
    const bowTie: [number, number][] = [[112, 66], [96, 62], [18, 0], [4, 6]];
    rejects(() => k.profile.polygon([bowTie]), 'invalid-input', /crosses itself at \(75\.5714, 45\.7619\)/);
    rejects(() => k.profile.polygon([bowTie.map(([x, y]) => [-x, y] as [number, number])]), 'invalid-input', /crosses itself/);
    rejects(() => k.profile.path(bowTie[0], bowTie.slice(1).map(to => ({ kind: 'line' as const, to }))), 'invalid-input', /path outline crosses itself/);
    rejects(() => k.profile.polygon([[[0, 100], [59, -81], [-95, 31], [95, 31], [-59, -81]]]), 'invalid-input', /crosses itself/);
    // An arc that bulges across the closing line.
    rejects(() => k.profile.path([0, 0], [{ kind: 'line', to: [10, 0] }, { kind: 'sagittaArc', to: [10, 10], sagitta: 12 }]), 'invalid-input', /crosses itself/);
    // Touching is not crossing: a vertex on another edge, and contours that overlap each other.
    const touch = k.profile.polygon([[[0, 0], [10, 0], [10, 10], [5, 0], [0, 10]]]);
    const overlap = k.profile.polygon([[[0, 0], [10, 0], [10, 10], [0, 10]], [[5, 5], [15, 5], [15, 15], [5, 15]]]);
    expect(k.profile.area(overlap)).toBeCloseTo(150, 9);
    [touch, overlap].forEach(p => p.dispose());
  });
  it('turns kernel failures into errors', () => {
    rejects(() => k.scope(() => k.fillet(k.box([10, 10, 10]), 6)), 'kernel-failure');
    rejects(() => k.scope(() => k.shell(k.box([10, 10, 10]), 6, [0, 0, 1])), 'kernel-failure');
    rejects(() => k.importStep('ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\n#1=FOO(;\nENDSEC;\nEND-ISO-10303-21;'), 'kernel-failure');
    rejects(() => k.importStep('not a step file'), 'kernel-failure');
    rejects(() => k.importStep(''), 'invalid-input');
    rejects(() => k.volume({} as never), 'invalid-input');
  });
  it('still computes correctly after the failures, with no kernel crash', () => {
    const m = measured(k.scope(() => k.subtract(k.box([10, 10, 10]), k.cylinder(2, 12))));
    expect(rel(m.volume, 1000 - Math.PI * 4 * 10)).toBeLessThanOrEqual(1e-12);
  });
  it('rejects other load options once SMLib is loaded', async () => {
    await expect(createSmlibKernel({ wasmBinary: new Uint8Array(8) })).rejects.toMatchObject({ code: 'invalid-input' });
  });
});
