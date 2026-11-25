// SPDX-License-Identifier: MIT
// Copyright (c) 2026 CrispCAD contributors
// SmlibBackend.boundingBox() is exact for rotated spheres and tori, and exactBbox.ts stays a
// copy of the exact-kernel package's bbox.ts.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadSmlib } from '../../../modeling/backends/smlib/runtime';
import { SmlibBackend } from './smlibBackend';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const MARKER = '// ---- shared with src/kernel/backends/smlib/exactBbox.ts below this line ----';
const shared = (path: string) => { const text = readFileSync(`${root}${path}`, 'utf8'); return text.slice(text.indexOf(MARKER)); };

describe('SmlibBackend.boundingBox', () => {
  it('is the same code as @crispcad/exact-kernel bbox.ts', () => {
    const lab = shared('src/kernel/backends/smlib/exactBbox.ts');
    expect(lab.startsWith(MARKER)).toBe(true);
    expect(lab).toBe(shared('packages/exact-kernel/src/bbox.ts'));
  });
  it('reaches a rotated sphere\'s extremes (SMLib bbox(): min z -60.861 for r 62 at 11 deg about X)', async () => {
    const sm = await loadSmlib();
    const box = new SmlibBackend(sm, sm.Sphere(62)).rotate([1, 0, 0], 11).boundingBox();
    for (let i = 0; i < 3; i++) { expect(box.min[i]).toBeCloseTo(-62, 9); expect(box.max[i]).toBeCloseTo(62, 9); }
  });
  it('matches the closed form of a rotated, translated torus', async () => {
    const sm = await loadSmlib();
    const t = (30 * Math.PI) / 180, a = [0, -Math.sin(t), Math.cos(t)]; // Z turned 30 deg about X
    const box = new SmlibBackend(sm, sm.Torus(40, 10)).rotate([1, 0, 0], 30).translate(5, 6, 7).boundingBox();
    const half = a.map(ai => 40 * Math.sqrt(1 - ai * ai) + 10), c = [5, 6, 7];
    for (let i = 0; i < 3; i++) { expect(box.min[i]).toBeCloseTo(c[i] - half[i], 9); expect(box.max[i]).toBeCloseTo(c[i] + half[i], 9); }
  });
});
