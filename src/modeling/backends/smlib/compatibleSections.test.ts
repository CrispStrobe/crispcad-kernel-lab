// SPDX-License-Identifier: MIT
// Copyright (c) 2026 CrispCAD contributors
//
// Loft sections paired as OCCT's ThruSections pairs them (compatibleSections.ts): the rule on
// its own, and native ruled lofts against OCCT for the section shapes the catalog uses.
import { describe, expect, it } from 'vitest';
import { buildModel } from '../../buildModel';
import { compatibleSections, computeOrigin, type P3 } from './compatibleSections';

const ngon = (r: number, n: number, rot = 0, z = 0): P3[] => Array.from({ length: n }, (_, k) => [r * Math.cos(rot + (2 * Math.PI * k) / n), r * Math.sin(rot + (2 * Math.PI * k) / n), z]);
const close = (a: readonly number[], b: readonly number[]) => a.every((v, i) => Math.abs(v - b[i]!) < 1e-9);

describe('compatibleSections: the rule', () => {
  it('splits an octagon at the rays through a 16-point star and pairs them as drawn', () => {
    const star: P3[] = Array.from({ length: 16 }, (_, k) => { const r = k % 2 ? 45 : 100, a = (Math.PI * k) / 8; return [r * Math.cos(a), r * Math.sin(a), 50]; });
    const [a, b] = compatibleSections([ngon(30, 8), star])!;
    expect(a).toHaveLength(16);
    expect(b).toEqual(star);
    // Even star vertices lie on the octagon's vertex rays (the vertices are reused), odd ones on
    // its edge midpoints (new vertices).
    for (let k = 0; k < 16; k += 2) expect(close(a![k]!, ngon(30, 8)[k / 2]!)).toBe(true);
    const mid = (k: number) => ngon(30, 8)[k]!.map((v, i) => (v + ngon(30, 8)[(k + 1) % 8]![i]!) / 2);
    for (let k = 1; k < 16; k += 2) expect(close(a![k]!, mid((k - 1) / 2))).toBe(true);
  });

  it('carries every vertex both ways and snaps hits within 10 % of an edge end', () => {
    // Hexagon to diamond (cave-entrance boulders): the diamond's vertices at 0 and 180 degrees
    // fall on hexagon vertices; those at 90 and 270 on the middle of the top and bottom edges.
    // The hexagon's vertices at 60, 120, 240, 300 degrees fall inside diamond edges.
    const [a, b] = compatibleSections([ngon(100, 6), ngon(45, 4, 0, 90)])!;
    expect(a).toHaveLength(8);
    expect(b).toHaveLength(8);
    const angle = (p: P3) => Math.round((Math.atan2(p[1], p[0]) * 180) / Math.PI);
    expect(a!.map(angle)).toEqual([0, 60, 90, 120, 180, -120, -90, -60]);
    expect(b!.map(angle)).toEqual([0, 60, 90, 120, 180, -120, -90, -60]);
  });

  it('snaps to an edge end unless that end is already an image', () => {
    // A square lofted to a pentagon: equal counts, and the first section starts as drawn.
    const square: P3[] = [[100, -100, 0], [100, 100, 0], [-100, 100, 0], [-100, -100, 0]];
    const [a, b] = compatibleSections([square, ngon(60, 5, (3 * Math.PI) / 180, 40)])!;
    expect(a!.length).toBe(b!.length);
    expect(a![0]).toEqual(square[0]);
    // Snap: a ray 1 degree off a corner lands inside the 10 % of the edge next to the corner, so
    // the corner is reused instead of a new vertex next to it.
    const nearCorner = compatibleSections([square, ngon(60, 5, ((45 + 1) * Math.PI) / 180, 40)])!;
    expect(nearCorner[0]!.some(p => close(p, [100, 100, 0]))).toBe(true);
    expect(nearCorner[0]!.filter(p => Math.abs(p[0] - 100) < 1e-9 && p[1] > 80 && p[1] < 100)).toHaveLength(0);
  });

  it('re-starts equal sections where they lie closest (ComputeOrigin)', () => {
    const square: P3[] = [[1, 0, 0], [0, 1, 0], [-1, 0, 0], [0, -1, 0]];
    const turned: P3[] = [[0, -2, 5], [2, 0, 5], [0, 2, 5], [-2, 0, 5]]; // drawn from another corner
    expect(computeOrigin([square, turned])[1]).toEqual([turned[1], turned[2], turned[3], turned[0]]);
    const reversed: P3[] = [[2, 0, 5], [0, -2, 5], [-2, 0, 5], [0, 2, 5]]; // and clockwise
    expect(computeOrigin([square, reversed])[1]).toEqual([reversed[0], reversed[3], reversed[2], reversed[1]]);
  });
});

async function volume(code: string, kernel: 'occt' | 'smlib-native'): Promise<number> {
  const m = await buildModel({ code, fileName: 'loft.kcad.ts', kernel });
  expect(m.diagnostics.filter(d => d.severity === 'error').map(d => d.message)).toEqual([]);
  return m.rootShape!.volume();
}
const path = (p: number[][]) => `path().moveTo(${p[0]})${p.slice(1).map(q => `.lineTo(${q})`).join('')}.close()`;
const poly = (r: (k: number) => number, n: number, rot = 0) => Array.from({ length: n }, (_, k) => [r(k) * Math.cos(rot + (2 * Math.PI * k) / n), r(k) * Math.sin(rot + (2 * Math.PI * k) / n)]);

describe('compatibleSections: native ruled lofts against OCCT', () => {
  const cases: [string, string][] = [
    ['an octagon to a 16-point star (lily-pads)', `return ${path(poly(() => 51, 8))}.loft(${path(poly(k => (k % 2 ? 76.5 : 170), 16))}, { spacing: 90, ruled: true })`],
    ['an irregular hexagon to a diamond (cave-entrance)', `return ${path(poly(k => 190 * (0.85 + 0.2 * Math.sin(k * 1.9)), 6))}.loft(${path(poly(() => 85.5, 4))}, { spacing: 171, ruled: true })`],
    ['an irregular hexagon to a rotated pentagon (cliff boulders)', `return ${path(poly(k => 120 * (0.8 + 0.25 * Math.sin(k * 2.1 + 0.7)), 6))}.loft(${path(poly(() => 54, 5, 0.7))}, { spacing: 96, ruled: true })`],
    ['three sections, 7, 5 and 9 vertices, off-centre', `return ${path(poly(k => 100 + 15 * Math.cos(3 * k), 7))}.loft([${path(poly(() => 70, 5, 0.3).map(([x, y]) => [x + 12, y - 7]))}, ${path(poly(k => 40 + 6 * (k % 2), 9, 1.1))}], { planes: [{ plane: 'XY', origin: [0, 0, 0] }, { plane: 'XY', origin: [5, 0, 60] }, { plane: 'XY', origin: [0, 3, 110] }], ruled: true })`],
    ['a hexagon to an octagon on XZ planes', `return ${path(poly(() => 18, 6))}.loft(${path(poly(() => 42, 8))}, { planes: [{ plane: 'XZ', origin: [0, 0, 0] }, { plane: 'XZ', origin: [0, 45, 0] }], ruled: true })`],
    ['equal counts drawn from another vertex (ComputeOrigin)', `return ${path(poly(() => 50, 5))}.loft(${path(poly(() => 30, 5, 2.6))}, { spacing: 40, ruled: true })`],
  ];
  for (const [name, code] of cases) {
    it(name, async () => {
      const [native, occt] = [await volume(code, 'smlib-native'), await volume(code, 'occt')];
      expect(Math.abs(native - occt) / occt).toBeLessThan(1e-9);
    });
  }
});
