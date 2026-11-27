// SPDX-License-Identifier: MIT
// Copyright (c) 2026 CrispCAD contributors
//
// exportStep with named bodies (since 0.1.10) on the built bundle: a host's body names and colours
// are written on each solid and read back by importStepBodies, in order; the single-solid form is
// unchanged.
import { beforeAll, describe, expect, it } from 'vitest';
import { createSmlibKernel, ExactKernelError, type ExactKernel } from '../dist/index.js';

let k: ExactKernel;
beforeAll(async () => { k = await createSmlibKernel(); });
const rejects = (fn: () => unknown, pattern: RegExp) => {
  let error: unknown;
  try { fn(); } catch (e) { error = e; }
  expect(error, 'expected an ExactKernelError').toBeInstanceOf(ExactKernelError);
  expect((error as ExactKernelError).code).toBe('invalid-input');
  expect((error as Error).message).toMatch(pattern);
};
const products = (step: string) => [...step.matchAll(/=PRODUCT\('((?:[^']|'')*)'/g)].map(m => m[1]);
const solids = (step: string) => [...step.matchAll(/=MANIFOLD_SOLID_BREP\('((?:[^']|'')*)'/g)].map(m => m[1]);

describe('exportStep with body names', () => {
  it('writes one single solid as before', () => k.scope(() => {
    const box = k.fillet(k.box([40, 30, 20]), 3), step = k.exportStep(box);
    expect(products(step)).toEqual(['part']);
    expect(solids(step)).toEqual(['part']);
    expect(k.importStepBodies(step).bodies[0].name).toBe('part');
    expect(products(k.exportStep(box, { product: 'Bracket' }))).toEqual(['Bracket']);
  }));
  it('writes each body under its own name and colour, read back in order', () => k.scope(() => {
    const bracket = k.fillet(k.box([40, 30, 20]), 3);
    const housing = k.translate(k.subtract(k.cylinder(12, 30), k.cylinder(8, 40)), [60, 0, 0]);
    const pin = k.translate(k.sphere(4), [0, 60, 0]);
    const before = k.memory().handles;
    const step = k.exportStep([
      { solid: bracket, name: 'Bracket', color: [1, 0, 0] },
      { solid: housing, name: 'Gehäuse \'oben\'', color: [0.2, 0.4, 0.6] },
      { solid: pin },
    ], { product: 'Assembly 1' });
    // Nothing the export made is left behind, and the solids are untouched.
    expect(k.memory().handles).toBe(before);
    expect(k.volume(bracket)).toBeGreaterThan(0);
    expect(products(step)).toEqual(['Assembly 1']);
    // A body without a name gets the product's, numbered by its place in the list.
    expect(solids(step)).toEqual(['Bracket', "Geh\\X2\\00E4\\X0\\use ''oben''", 'Assembly 1_3']);
    const read = k.importStepBodies(step);
    expect(read.bodies.map(b => b.name)).toEqual(['Bracket', 'Gehäuse \'oben\'', 'Assembly 1_3']);
    expect(read.bodies[0].color).toEqual([1, 0, 0]);
    read.bodies[1].color!.forEach((c, i) => expect(c).toBeCloseTo([0.2, 0.4, 0.6][i], 6));
    expect(read.bodies[2].color).toBeNull();
    [bracket, housing, pin].forEach((solid, i) => expect(k.volume(read.bodies[i].solid) / k.volume(solid)).toBeCloseTo(1, 9));
  }));
  it('names the product after a single named body', () => k.scope(() => {
    const step = k.exportStep([{ solid: k.box([1, 2, 3]), name: 'Lid' }]);
    expect(products(step)).toEqual(['Lid']);
    expect(k.importStepBodies(step).bodies[0].name).toBe('Lid');
  }));
  it('refuses bad names, colours and lists', () => k.scope(() => {
    const box = k.box([1, 1, 1]);
    rejects(() => k.exportStep([]), /at least one body/);
    rejects(() => k.exportStep([{ solid: box, name: '' }]), /name of STEP body 1/);
    rejects(() => k.exportStep([{ solid: box, name: 'a\nb' }]), /control characters/);
    rejects(() => k.exportStep([{ solid: box, name: 'x'.repeat(1001) }]), /at most 1000/);
    rejects(() => k.exportStep([{ solid: box, color: [0, 0, 2] }]), /colour of STEP body 1/);
    rejects(() => k.exportStep(box, { product: 42 as never }), /product name/);
    rejects(() => k.exportStep([{ solid: {} as never }]), /Not a solid/);
  }));
});
