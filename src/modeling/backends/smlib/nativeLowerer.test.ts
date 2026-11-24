// SPDX-License-Identifier: MIT
// Copyright (c) 2026 CrispCAD contributors
// The 27 reference-part scripts through buildModel on the native SMLib kernel.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildModel } from '../../buildModel';
import { SmlibBackend } from '../../../kernel/backends/smlib/smlibBackend';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const scorecard = JSON.parse(readFileSync(`${root}assets/reference-parts/scorecard.json`, 'utf8')) as {
  parts: { id: string; source: string; expected: { volumeMm3: number; surfaceAreaMm2: number; bbox: { min: number[]; max: number[] } }; tolerance: { volumeRelative: number; surfaceAreaRelative: number; bboxAbsoluteMm: number } }[];
};

describe('native SMLib kernel (no OpenCASCADE)', () => {
  for (const part of scorecard.parts) {
    it(`builds ${part.id} to the analytic scorecard`, async () => {
      const file = `${root}${part.source}`;
      const model = await buildModel({ code: readFileSync(file, 'utf8'), fileName: file, kernel: 'smlib-native' });
      expect(model.diagnostics.filter(d => d.severity === 'error')).toEqual([]);
      const shape = model.rootShape;
      expect(shape).toBeInstanceOf(SmlibBackend);
      const { expected, tolerance } = part;
      expect(Math.abs(shape!.volume() - expected.volumeMm3) / expected.volumeMm3).toBeLessThanOrEqual(tolerance.volumeRelative);
      expect(Math.abs(shape!.surfaceArea() - expected.surfaceAreaMm2) / expected.surfaceAreaMm2).toBeLessThanOrEqual(tolerance.surfaceAreaRelative);
      const box = shape!.boundingBox();
      for (let i = 0; i < 3; i++) {
        expect(Math.abs(box.min[i] - expected.bbox.min[i])).toBeLessThanOrEqual(tolerance.bboxAbsoluteMm);
        expect(Math.abs(box.max[i] - expected.bbox.max[i])).toBeLessThanOrEqual(tolerance.bboxAbsoluteMm);
      }
    }, 60000);
  }

  it('exports STEP and STL natively', async () => {
    const model = await buildModel({ code: "return box(10, 10, 10).subtract(cylinder(20, 3).translate(5, 5, -5));", fileName: '/tmp/native.kcad.ts', kernel: 'smlib-native' });
    const shape = model.rootShape!;
    const step = new TextDecoder().decode(shape.exportSTEP());
    expect(step).toMatch(/^ISO-10303-21;/);
    expect(step).toContain('CYLINDRICAL_SURFACE');
    const stl = shape.exportSTL();
    const triangles = new DataView(stl.buffer, stl.byteOffset).getUint32(80, true);
    expect(stl.length).toBe(84 + 50 * triangles);
    const mesh = shape.getMesh();
    expect(mesh.indices.length / 3).toBeGreaterThan(20);
    const mass = shape.massProperties(1000);
    expect(mass.mass).toBeCloseTo((1000 - Math.PI * 9 * 10) * 1e-9 * 1000, 12);
    expect(mass.com[2]).toBeCloseTo(5, 9);
  }, 60000);

  it('spans a negative box dimension like OCCT', async () => {
    const model = await buildModel({ code: 'return box(-10, 20, 5);', fileName: '/tmp/native.kcad.ts', kernel: 'smlib-native' });
    expect(model.rootShape!.boundingBox()).toEqual({ min: [-10, 0, 0], max: [0, 20, 5] });
  }, 60000);

  it('reports an unsupported feature instead of falling back', async () => {
    const model = await buildModel({ code: "return box(40, 30, 10).draft(3, { face: 'front', pullDir: [0, 0, 1] });", fileName: '/tmp/native.kcad.ts', kernel: 'smlib-native' });
    const errors = model.diagnostics.filter(d => d.severity === 'error');
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some(d => d.code === 'recompute.kernel.unsupported-feature')).toBe(true);
  }, 60000);
});
