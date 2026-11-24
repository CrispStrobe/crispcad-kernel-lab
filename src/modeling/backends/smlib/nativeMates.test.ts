// SPDX-License-Identifier: MIT
// Copyright (c) 2026 CrispCAD contributors
// Mated assemblies on the native SMLib kernel: the mate solver is pure data, so
// each part's world transform must match the OpenCASCADE build exactly.
import { describe, expect, it } from 'vitest';
import { buildModel } from '../../buildModel';
import { isSceneBackend, type SceneBackend } from '../../../kernel/backends/sceneBackend';
import { SmlibBackend } from '../../../kernel/backends/smlib/smlibBackend';
import type { Transform } from '../../../shared/runtime/se3';

const MATED = `
const a = assembly('arm');
const base = a.part('base', box(20, 20, 10));
const link = a.part('link', box(40, 6, 6).translate(0, -3, 0));
const tip = a.part('tip', cylinder(3, 10));
base.connector('shoulder', { type: 'axis', origin: { kind: 'vec3', value: [10, 10, 10] }, axis: [0, 0, 1] });
link.connector('shoulder', { type: 'axis', origin: { kind: 'vec3', value: [0, 0, 0] }, axis: [0, 0, 1] });
link.connector('end', { type: 'frame', origin: { kind: 'vec3', value: [40, 0, 6] } });
tip.connector('end', { type: 'frame', origin: { kind: 'vec3', value: [0, 0, 0] } });
a.mate('shoulder', 'base.shoulder', 'link.shoulder', 'revolute', { pose: 30, limitsDeg: [-90, 90] });
a.mate('end', 'link.end', 'tip.end', 'fastened');
return a.model();
`;

function matrix(t: Transform): Float64Array {
  const m = new Float64Array(16);
  t.writeTo(m);
  return m;
}

async function scene(kernel: 'occt' | 'smlib-native'): Promise<SceneBackend> {
  const model = await buildModel({ code: MATED, fileName: '/tmp/mated.kcad.ts', kernel });
  expect(model.diagnostics.filter(d => d.severity === 'error')).toEqual([]);
  const root = model.rootShape as unknown;
  if (!isSceneBackend(root)) throw new Error('expected a scene');
  return root;
}

describe('native SMLib kernel: assemblies with mates', () => {
  it('places mated parts exactly where the OCCT build does', async () => {
    const [native, occt] = [await scene('smlib-native'), await scene('occt')];
    expect(native.parts.map(p => p.name)).toEqual(occt.parts.map(p => p.name));
    for (let i = 0; i < native.parts.length; i++) {
      expect(native.parts[i].shape).toBeInstanceOf(SmlibBackend);
      const n = matrix(native.parts[i].worldTransform);
      const o = matrix(occt.parts[i].worldTransform);
      for (let k = 0; k < 16; k++) expect(n[k]).toBeCloseTo(o[k], 9);
    }
    const link = matrix(native.parts.find(p => p.name === 'link')!.worldTransform);
    expect(link.some((v, k) => Math.abs(v - [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1][k]) > 1e-6)).toBe(true);
    expect(native.rig).toBeDefined();
  }, 120000);

  it('reports topology-placed connectors as unsupported, not as a wrong placement', async () => {
    const code = MATED.replace("{ type: 'axis', origin: { kind: 'vec3', value: [10, 10, 10] }, axis: [0, 0, 1] }", "{ type: 'axis', origin: '@kc[base/face/top#normal]', axis: [0, 0, 1] }");
    const model = await buildModel({ code, fileName: '/tmp/mated.kcad.ts', kernel: 'smlib-native' });
    const errors = model.diagnostics.filter(d => d.severity === 'error');
    expect(errors.map(d => d.code)).toContain('recompute.kernel.unsupported-feature');
  }, 120000);
});
