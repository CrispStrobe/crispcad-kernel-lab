// SPDX-License-Identifier: MIT
// Copyright (c) 2026 CrispCAD contributors
//
// createSmlibKernel's limits: a memory ceiling held at instantiation (the module's bytes are the
// pinned build, unchanged) and smlibwasm's shell / defeaturing guard. The ceiling holds for the
// process, so this file loads its own kernel (vitest runs each test file in its own worker).
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { createSmlibKernel, ExactKernelError, type SmlibKernel } from '../dist/index.js';

const MiB = 2 ** 20;
const CAP = 80 * MiB + 1234; // rounded down to whole 64 KiB pages: 80 MiB
let k: SmlibKernel;
beforeAll(async () => { k = await createSmlibKernel({ maxMemoryBytes: CAP, guardSeconds: 5 }); });

describe('createSmlibKernel limits', () => {
  it('reports the ceiling and the guard it was given, and sets the guard', () => {
    expect(k.maxMemoryBytes).toBe(80 * MiB);
    expect(k.guardSeconds()).toBe(5);
    expect(k.setGuardSeconds(7.5)).toBe(5);
    expect(k.guardSeconds()).toBe(7.5);
    expect(k.setGuardSeconds(20)).toBe(7.5);
    expect(() => k.setGuardSeconds(-1)).toThrow(ExactKernelError);
  });

  it('builds within the ceiling, and fails cleanly past it without growing beyond it', () => {
    const solid = k.scope(() => k.volume(k.subtract(k.box([100, 100, 10]), k.cylinder(10, 30))));
    expect(solid).toBeGreaterThan(0);
    // A sphere tessellated at 1 degree: 261,124 triangles, 888 MiB of heap without a ceiling.
    let failure: unknown;
    try {
      k.scope(() => k.tessellate(k.sphere(50), { tolerance: 0.1, angleDeg: 1 }));
    } catch (e) {
      failure = e;
    }
    expect(failure).toBeInstanceOf(ExactKernelError);
    expect(String((failure as Error).message)).toMatch(/out of memory/i);
    expect(k.memory().heap).toBeLessThanOrEqual(80 * MiB);
    // (SMLib reports the failure cleanly; a host should still replace a kernel that hit the ceiling.)
    expect(k.scope(() => k.volume(k.box([1, 2, 3])))).toBeCloseTo(6, 12);
  });

  it('loads the kernel once: the same ceiling again is the same kernel, another one is an error', async () => {
    await expect(createSmlibKernel({ maxMemoryBytes: 80 * MiB })).resolves.toBeDefined();
    await expect(createSmlibKernel({ maxMemoryBytes: 200 * MiB })).rejects.toThrow(/loads once/);
  });

  it('leaves the shipped module byte-identical to the pinned build', () => {
    const wasm = readFileSync(new URL('../dist/smlibwasm.wasm', import.meta.url));
    const pinned = JSON.parse(readFileSync(new URL('../BUILD-PROVENANCE.json', import.meta.url), 'utf8')).files['wasm/smlibwasm.wasm'];
    expect(createHash('sha256').update(wasm).digest('hex')).toBe(pinned);
  });
});
