// SPDX-License-Identifier: MIT
// Copyright (c) 2026 CrispCAD contributors
//
// topology(), nameFaces() and fillet/chamfer of chosen edges (0.1.8): face names survive Booleans,
// transforms and fillets, edge adjacency is reported, and edge indices select exactly those edges.
import { beforeAll, describe, expect, it } from 'vitest';
import { createSmlibKernel, ExactKernelError, type ExactKernel, type ExactSolid } from '../dist/index.js';

let k: ExactKernel;
beforeAll(async () => { k = await createSmlibKernel(); });
const rel = (a: number, b: number) => Math.abs(a - b) / Math.abs(b);
const named = (s: ExactSolid, prefix: string) => k.nameFaces(s, k.topology(s).faces.map(f => `${prefix}${f.index}`));

describe('topology', () => {
  it('lists the 6 faces and 12 edges of a box with their adjacency', () => k.scope(() => {
    const t = k.topology(k.box([20, 30, 10]));
    expect(t.faces).toHaveLength(6);
    expect(t.edges).toHaveLength(12);
    for (const f of t.faces) { expect(f.surface).toBe('plane'); expect(f.name).toBeNull(); expect(Math.hypot(...f.normal)).toBeCloseTo(1, 12); }
    for (const e of t.edges) {
      expect(e.curve).toBe('line');
      expect(e.faces).toHaveLength(2);
      expect(e.points).toHaveLength(2);
      expect(Math.hypot(e.points[1][0] - e.points[0][0], e.points[1][1] - e.points[0][1], e.points[1][2] - e.points[0][2])).toBeCloseTo(e.length, 9);
    }
    expect(t.edges.map(e => e.length).sort((a, b) => a - b)).toEqual([10, 10, 10, 10, 20, 20, 20, 20, 30, 30, 30, 30]);
  }));
  it('reports circles with radius, centre and axis, and samples them', () => k.scope(() => {
    const t = k.topology(k.cylinder(5, 12));
    const circles = t.edges.filter(e => e.curve === 'circle');
    expect(circles).toHaveLength(2);
    for (const c of circles) {
      expect(c.radius).toBeCloseTo(5, 12);
      expect(c.points.length).toBeGreaterThan(8);
      for (const p of c.points) expect(Math.hypot(p[0] - c.center![0], p[1] - c.center![1])).toBeCloseTo(5, 9);
    }
    expect(t.faces.find(f => f.surface === 'cylinder')?.radius).toBeCloseTo(5, 12);
  }));
});

describe('nameFaces', () => {
  it('keeps names through a cut, a move and a fillet; new faces have none', () => k.scope(() => {
    const plate = named(k.box([20, 30, 10]), 'p'), tool = named(k.cylinder(3, 40), 'c');
    const cut = k.subtract(plate, k.translate(tool, [0, 0, -5]));
    const moved = k.rotate(k.translate(cut, [5, 0, 0]), [0, 0, 1], 30);
    const names = k.topology(moved).faces.map(f => f.name);
    expect(names.filter(n => n?.startsWith('p')).sort()).toEqual(['p0', 'p1', 'p2', 'p3', 'p4', 'p5']);
    expect(names).toContain('c0');
    const t = k.topology(moved);
    const rim = t.edges.findIndex(e => e.curve === 'circle');
    const rounded = k.fillet(moved, 1, { edgeIndices: [rim] });
    const after = k.topology(rounded).faces;
    expect(after.filter(f => f.name === null)).toHaveLength(1);
    expect(after.filter(f => f.name !== null)).toHaveLength(t.faces.length);
  }));
  it('refuses a name list of the wrong length', () => k.scope(() => {
    expect(() => k.nameFaces(k.box([1, 1, 1]), ['a'])).toThrow(ExactKernelError);
  }));
});

describe('fillet and chamfer of chosen edges', () => {
  it('rounds one edge of a box (closed form)', () => k.scope(() => {
    const box = k.box([20, 30, 10]), t = k.topology(box);
    const edge = t.edges.find(e => e.length === 30)!;
    const s = k.fillet(box, 2, { edgeIndices: [edge.index] });
    expect(k.isValid(s)).toBe(true);
    expect(rel(k.volume(s), 6000 - (4 - Math.PI) * 30)).toBeLessThan(1e-9);
  }));
  it('chamfers two edges (closed form)', () => k.scope(() => {
    const box = k.box([20, 30, 10]), t = k.topology(box);
    const edges = t.edges.filter(e => e.length === 20).slice(0, 2).map(e => e.index);
    const s = k.chamfer(box, 1, { edgeIndices: edges });
    expect(rel(k.volume(s), 6000 - 2 * 0.5 * 20)).toBeLessThan(1e-9);
  }));
  it('refuses bad indices cleanly', () => k.scope(() => {
    const box = k.box([20, 30, 10]);
    for (const edgeIndices of [[12], [-1], [0.5], [1, 1], []]) {
      let error: unknown;
      try { k.fillet(box, 1, { edgeIndices }); } catch (e) { error = e; }
      expect(error).toBeInstanceOf(ExactKernelError);
      expect((error as ExactKernelError).code).toBe('invalid-input');
    }
  }));
});
