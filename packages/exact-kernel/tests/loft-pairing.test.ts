// SPDX-License-Identifier: MIT
// Copyright (c) 2026 CrispCAD contributors
//
// loft pairing: 'authored' (the default) joins vertex i of each section to vertex i of the next,
// as drawn, for equal vertex counts; 'closest' re-starts the sections as OpenCASCADE does. CrispCAD
// lowers CAD Script lofts, whose sides are defined by the authored correspondence, and refuses a
// solid whose volume is not that of its own surface; 0.1.5 re-started equal sections always.
import { beforeAll, describe, expect, it } from 'vitest';
import { createSmlibKernel, ExactKernelError, type ExactKernel, type LoftPairing, type PathSegment } from '../dist/index.js';

let k: ExactKernel;
beforeAll(async () => { k = await createSmlibKernel(); });

type P3 = [number, number, number];
const rel = (a: number, b: number) => Math.abs(a - b) / Math.abs(b);
const ngon = (r: number, n: number, z: number, turn = 0, dx = 0, dy = 0): P3[] => Array.from({ length: n }, (_, i) => { const a = turn + (2 * Math.PI * i) / n; return [dx + r * Math.cos(a), dy + r * Math.sin(a), z]; });
const shoelace = (ring: readonly P3[]) => ring.reduce((s, p, i) => { const q = ring[(i + 1) % ring.length]!; return s + (p[0] * q[1] - q[0] * p[1]) / 2; }, 0);
/** Ruled sides through vertex i -> i: the cross-section area is quadratic in z (prismoidal rule). */
const ruledVolume = (sections: readonly P3[][]) => {
  let v = 0;
  for (let s = 0; s + 1 < sections.length; s++) {
    const a = sections[s]!, b = sections[s + 1]!, mid = a.map((p, i) => p.map((x, j) => (x + b[i]![j]!) / 2) as P3);
    v += ((b[0]![2] - a[0]![2]) / 6) * (shoelace(a) + 4 * shoelace(mid) + shoelace(b));
  }
  return Math.abs(v);
};
const loft = (sections: readonly P3[][], kind: 'polygon' | 'path', ruled: boolean, pairing?: LoftPairing) => k.scope(() => {
  const profile = (r: readonly P3[]) => {
    const pts = r.map(p => [p[0], p[1]] as [number, number]);
    return kind === 'polygon' ? k.profile.polygon([pts]) : k.profile.path(pts[0]!, [...pts.slice(1), pts[0]!].map(to => ({ kind: 'line' as const, to })));
  };
  return k.volume(k.loft(sections.map(r => ({ profile: profile(r), at: [0, 0, r[0]![2]] as P3 })), { ruled, ...(pairing ? { pairing } : {}) }));
});

// CrispCAD's fire-station/bay-warning-beacon lower lamp: a 10-gon twisted by half a step.
const beacon = [ngon(82, 10, 0), ngon(77.9, 10, 150, Math.PI / 10)];
// CrispCAD's smooth-loft cases: a twisted, off-centre 8-gon vase and the wind-turbine blade.
const vase = [ngon(20, 8, 0), ngon(28, 8, 15, 0.2, 3, 1), ngon(14, 8, 40, 0.35, -2, 4), ngon(22, 8, 55, 0.5, 1, -3)];
const AIRFOIL = [[0.7, 0.01], [0.45, 0.3], [0.15, 0.5], [-0.1, 0.48], [-0.25, 0.3], [-0.3, 0], [-0.25, -0.25], [-0.1, -0.35], [0.15, -0.32], [0.45, -0.15]];
const bladeSection = ([z, chord, thick, twist, round]: number[]): P3[] => {
  const a = (twist! * Math.PI) / 180;
  return (round ? AIRFOIL.map((_, i) => [round * Math.cos((2 * Math.PI * i) / 10), round * Math.sin((2 * Math.PI * i) / 10)]) : AIRFOIL.map(([u, v]) => [u! * chord!, (v! * thick!) / 0.5]))
    .map(([x, y]) => [x! * Math.cos(a) - y! * Math.sin(a), x! * Math.sin(a) + y! * Math.cos(a), z!] as P3);
};
const blade = [[300, 0, 0, 0, 88], [408, 0, 0, 0, 88], [660, 360, 130, 14, 0], [1056, 270, 72, 8, 0], [1560, 180, 42, 3, 0], [1920, 128, 28, 1, 0]].map(bladeSection);

describe("loft pairing: 'authored' keeps vertex i -> i, 'closest' re-starts", () => {
  it('ruled: the twisted beacon lamp is the ruled solid of its authored correspondence (2,772,519.67 mm^3)', () => {
    const exact = ruledVolume(beacon);
    expect(exact).toBeCloseTo(2772519.67, 2);
    for (const kind of ['polygon', 'path'] as const) {
      expect(rel(loft(beacon, kind, true), exact), kind).toBeLessThan(1e-9);
      expect(rel(loft(beacon, kind, true, 'authored'), exact), kind).toBeLessThan(1e-9);
    }
    // A hexagon whose top is turned 0.8 of a step: OCCT re-starts the top at the nearer vertex.
    const six = [ngon(10, 6, 0), ngon(10, 6, 20, (0.8 * Math.PI) / 3)];
    const sixShifted = [six[0]!, [...six[1]!.slice(5), ...six[1]!.slice(0, 5)]];
    for (const kind of ['polygon', 'path'] as const) {
      expect(rel(loft(six, kind, true), ruledVolume(six)), kind).toBeLessThan(1e-9);
      expect(rel(loft(six, kind, true, 'closest'), ruledVolume(sixShifted)), kind).toBeLessThan(1e-9);
    }
    expect(rel(ruledVolume(six), ruledVolume(sixShifted))).toBeGreaterThan(0.1);
  });

  it('smooth: equal sections give the 0.1.4 surface (what CrispCAD checks against)', () => {
    // Volumes of @crispcad/exact-kernel 0.1.4, which joined vertex i -> i as drawn; the vase's
    // 72,931.33 is the volume of CrispCAD's own smooth-loft surface through these sections.
    expect(rel(loft(vase, 'polygon', false), 72931.333835215759)).toBeLessThan(1e-9);
    expect(rel(loft(blade, 'polygon', false), 37677619.477196932)).toBeLessThan(1e-9);
    // Path profiles loft through their outline wires, as in 0.1.4: SMLib's smooth loft through
    // wires of lines parametrises the sections otherwise than through polygon faces (the same
    // vertices, another smooth surface). 0.1.5 used such wires for polygons too: 72,922.22.
    expect(rel(loft(vase, 'path', false), 72922.218508754857)).toBeLessThan(1e-9);
  });

  it('unequal vertex counts are matched by the polar rule whatever the pairing', () => {
    const octagonToStar = [ngon(51, 8, 0), Array.from({ length: 16 }, (_, i) => { const r = i % 2 ? 76.5 : 170, a = (Math.PI * i) / 8; return [r * Math.cos(a), r * Math.sin(a), 90] as P3; })];
    const occt = 1962135.3745797933; // OpenCASCADE 8.0.1's ThruSections (ruled)
    expect(rel(loft(octagonToStar, 'polygon', true), occt)).toBeLessThan(1e-12);
    expect(rel(loft(octagonToStar, 'polygon', true, 'closest'), occt)).toBeLessThan(1e-12);
  });

  it('refuses an unknown pairing', () => {
    expect(() => loft(beacon, 'polygon', true, 'drawn' as LoftPairing)).toThrow(/pairing/);
  });
});

// 0.1.7: 'closest' with curved section edges. A 20 x 20 square whose right side is an arc bulging
// to x = 16 (four vertices, four corners), drawn counter-clockwise from vertex `start` (or clockwise).
type V2 = [number, number];
const archVertices = (scale: number, turn: number, z: number): P3[] => ([[-10, -10], [10, -10], [10, 10], [-10, 10]] as V2[])
  .map(([x, y]) => [scale * (x * Math.cos(turn) - y * Math.sin(turn)), scale * (x * Math.sin(turn) + y * Math.cos(turn)), z]);
const archVia = (scale: number, turn: number): V2 => [scale * 16 * Math.cos(turn), scale * 16 * Math.sin(turn)];
/** The arch's path from vertex `start`, counter-clockwise or clockwise; edge 1 -> 2 is the arc. */
const archPath = (v: readonly P3[], via: V2, start: number, ccw = true) => {
  const order = Array.from({ length: 4 }, (_, k) => (ccw ? start + k : start - k + 4) % 4);
  const segments: PathSegment[] = order.map((from, k) => {
    const to = order[(k + 1) % 4]!, end: V2 = [v[to]![0], v[to]![1]];
    return (from === 1 && to === 2) || (from === 2 && to === 1) ? { kind: 'arc', via, to: end } : { kind: 'line', to: end };
  });
  return { start: [v[order[0]!]![0], v[order[0]!]![1]] as V2, segments };
};
const loftPaths = (paths: { start: V2; segments: PathSegment[]; z: number }[], ruled: boolean, pairing?: LoftPairing) => k.scope(() =>
  k.volume(k.loft(paths.map(p => ({ profile: k.profile.path(p.start, p.segments), at: [0, 0, p.z] as P3 })), { ruled, ...(pairing ? { pairing } : {}) })));

describe("loft pairing 'closest' with curved section edges (0.1.7)", () => {
  // The top is the arch scaled by 0.7 and turned by 80 degrees, so its vertex 3 lies nearest the
  // bottom's vertex 0: 'closest' re-starts it there, keeping the arc an arc.
  const bottom = archVertices(1, 0, 0), top = archVertices(0.7, (80 * Math.PI) / 180, 30), via0 = archVia(1, 0), via1 = archVia(0.7, (80 * Math.PI) / 180);
  const b = { ...archPath(bottom, via0, 0), z: 0 };
  for (const ruled of [true, false]) {
    it(`${ruled ? 'ruled' : 'smooth'}: re-starts a section with an arc at its closest vertex, forward and backward`, () => {
      const drawn = loftPaths([b, { ...archPath(top, via1, 0), z: 30 }], ruled);
      const restarted = loftPaths([b, { ...archPath(top, via1, 3), z: 30 }], ruled);
      expect(rel(drawn, restarted)).toBeGreaterThan(0.01);
      expect(rel(loftPaths([b, { ...archPath(top, via1, 0), z: 30 }], ruled, 'closest'), restarted)).toBeLessThan(1e-9);
      // Drawn clockwise: 'closest' runs it backward (the arc reversed), as the counter-clockwise top from vertex 3.
      expect(rel(loftPaths([b, { ...archPath(top, via1, 0, false), z: 30 }], ruled, 'closest'), restarted)).toBeLessThan(1e-9);
      // Already closest: unchanged.
      expect(rel(loftPaths([b, { ...archPath(top, via1, 3), z: 30 }], ruled, 'closest'), restarted)).toBeLessThan(1e-9);
    });
  }

  it('leaves sections without a corner as drawn', () => {
    const circles = (pairing?: LoftPairing) => k.scope(() => k.volume(k.loft([{ profile: k.profile.circle(10), at: [0, 0, 0] }, { profile: k.profile.circle(6), at: [2, 1, 20] }], { ruled: true, ...(pairing ? { pairing } : {}) })));
    expect(rel(circles('closest'), circles())).toBeLessThan(1e-12);
    const rounded = (pairing?: LoftPairing) => k.scope(() => k.volume(k.loft([{ profile: k.profile.roundedRectangle(20, 12, 3), at: [0, 0, 0] }, { profile: k.profile.rotate(k.profile.roundedRectangle(16, 10, 2), 30), at: [0, 0, 20] }], { ...(pairing ? { pairing } : {}) })));
    expect(rel(rounded('closest'), rounded())).toBeLessThan(1e-12);
  });

  it('takes straight-edged profiles that are not polygons (a rectangle) as polygons', () => {
    const square = ngon(10 * Math.SQRT2, 4, 0, Math.PI / 4), twisted = ngon(10 * Math.SQRT2, 4, 20, Math.PI / 4 + (0.8 * Math.PI) / 2);
    const expected = loft([square, twisted], 'polygon', true, 'closest');
    expect(rel(expected, loft([square, twisted], 'polygon', true))).toBeGreaterThan(0.01);
    const viaRectangle = k.scope(() => k.volume(k.loft([{ profile: k.profile.rectangle(20, 20, true), at: [0, 0, 0] }, { profile: k.profile.polygon([twisted.map(p => [p[0], p[1]] as V2)]), at: [0, 0, 20] }], { ruled: true, pairing: 'closest' })));
    expect(rel(viaRectangle, expected)).toBeLessThan(1e-9);
  });

  it('refuses what it cannot pair as OCCT does: curved sections with different edge counts, holes', () => {
    const hexagon = ngon(8, 6, 30);
    const sections = (pairing: LoftPairing) => k.scope(() => k.volume(k.loft([{ profile: k.profile.path(b.start, b.segments), at: [0, 0, 0] }, { profile: k.profile.polygon([hexagon.map(p => [p[0], p[1]] as V2)]), at: [0, 0, 30] }], { ruled: true, pairing })));
    expect(sections('authored')).toBeGreaterThan(0);
    let failure: unknown;
    try { sections('closest'); } catch (e) { failure = e; }
    expect(failure).toBeInstanceOf(ExactKernelError);
    expect((failure as ExactKernelError).code).toBe('unsupported');
    expect((failure as Error).message).toMatch(/different edge counts \(4, 6\).*curved/);
    const ring = k.profile.polygon([[[-10, -10], [10, -10], [10, 10], [-10, 10]], [[-4, -4], [4, -4], [4, 4], [-4, 4]]]);
    expect(() => k.scope(() => k.loft([{ profile: ring, at: [0, 0, 0] }, { profile: k.profile.circle(8), at: [0, 0, 10] }], { pairing: 'closest' }))).toThrow(/single-outline sections; section 1 has holes/);
    // A spline edge is re-started forward as the path drew it, but not run the other way.
    const splined = (ccw: boolean) => { const p = archPath(top, via1, 0, ccw); return { ...p, segments: p.segments.map(g => g.kind === 'arc' ? { kind: 'spline' as const, through: [g.via, g.to] } : g), z: 30 }; };
    expect(loftPaths([b, splined(true)], true, 'closest')).toBeGreaterThan(0);
    expect(() => loftPaths([b, splined(false)], true, 'closest')).toThrow(/section 2 the other way round, and it has a bspline edge/);
  });
});
