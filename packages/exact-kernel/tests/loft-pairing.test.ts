// SPDX-License-Identifier: MIT
// Copyright (c) 2026 CrispCAD contributors
//
// loft pairing: 'authored' (the default) joins vertex i of each section to vertex i of the next,
// as drawn, for equal vertex counts; 'closest' re-starts the sections as OpenCASCADE does. CrispCAD
// lowers CAD Script lofts, whose sides are defined by the authored correspondence, and refuses a
// solid whose volume is not that of its own surface; 0.1.5 re-started equal sections always.
import { beforeAll, describe, expect, it } from 'vitest';
import { createSmlibKernel, type ExactKernel, type LoftPairing } from '../dist/index.js';

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
