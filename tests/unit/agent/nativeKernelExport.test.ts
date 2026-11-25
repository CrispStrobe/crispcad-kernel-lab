// SPDX-License-Identifier: MIT
// Copyright (c) 2026 CrispCAD contributors
// CRISPCAD_KERNEL=smlib-native routes the script runtime and export through SMLib.
import { afterEach, describe, expect, it } from 'vitest';
import { runAndExport } from '../../../src/agent/script-runtime/export';
import { kernelNeedsOcct } from '../../../src/kernel/backends/kernelRuntime';
import { defaultKernel, KernelUnavailableError } from '../../../src/modeling/backends/kernelRegistry';

const code = "return box(60, 40, 10).hole('top', { u: 0, v: 0, diameter: 10, depth: 'through' });";
const previous = process.env.CRISPCAD_KERNEL, previousLab = process.env.CRISPCAD_LAB_KERNEL;
delete process.env.CRISPCAD_LAB_KERNEL;
afterEach(() => {
  if (previous === undefined) delete process.env.CRISPCAD_KERNEL;
  else process.env.CRISPCAD_KERNEL = previous;
  if (previousLab === undefined) delete process.env.CRISPCAD_LAB_KERNEL;
  else process.env.CRISPCAD_LAB_KERNEL = previousLab;
});

describe('kernel selection from CRISPCAD_KERNEL', () => {
  it('defaults to occt and honours a valid id', () => {
    delete process.env.CRISPCAD_KERNEL;
    expect(defaultKernel()).toBe('occt');
    expect(kernelNeedsOcct()).toBe(true);
    process.env.CRISPCAD_KERNEL = 'smlib-native';
    expect(defaultKernel()).toBe('smlib-native');
    expect(kernelNeedsOcct()).toBe(false);
  });

  it('prefers CRISPCAD_LAB_KERNEL over CRISPCAD_KERNEL', () => {
    process.env.CRISPCAD_KERNEL = 'occt';
    process.env.CRISPCAD_LAB_KERNEL = 'smlib-native';
    expect(defaultKernel()).toBe('smlib-native');
    process.env.CRISPCAD_LAB_KERNEL = '';
    expect(defaultKernel()).toBe('occt');
  });

  it('rejects an unknown id instead of falling back', () => {
    process.env.CRISPCAD_KERNEL = 'parasolid';
    expect(() => defaultKernel()).toThrow(KernelUnavailableError);
  });

  it('exports STEP and STL natively and refuses other formats', async () => {
    process.env.CRISPCAD_KERNEL = 'smlib-native';
    const step = await runAndExport({ code, fileName: '/tmp/native.kcad.ts', format: 'step' });
    expect(step.diagnostics.filter(d => d.severity === 'error')).toEqual([]);
    expect(new TextDecoder().decode(step.bytes)).toMatch(/^ISO-10303-21;[\s\S]*CYLINDRICAL_SURFACE/);
    const stl = await runAndExport({ code, fileName: '/tmp/native.kcad.ts', format: 'stl' });
    expect(stl.bytes.length).toBe(84 + 50 * new DataView(stl.bytes.buffer, stl.bytes.byteOffset).getUint32(80, true));
    const glb = await runAndExport({ code, fileName: '/tmp/native.kcad.ts', format: 'glb' });
    expect(glb.bytes.length).toBe(0);
    expect(glb.diagnostics.map(d => d.code)).toContain('export.kernel.unsupported-format');
  }, 120000);
});
