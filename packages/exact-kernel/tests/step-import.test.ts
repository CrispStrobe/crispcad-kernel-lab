// SPDX-License-Identifier: MIT
// Copyright (c) 2026 CrispCAD contributors
//
// Strict STEP import (importStepBodies, since 0.1.8) on the built bundle: round trips of solids
// this kernel writes, files other writers wrote (OpenCASCADE 7.6 seed parts, an AP242 file from
// the SO-100 arm, Apache-2.0), units, several bodies, and refusal of everything it cannot read
// whole.
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { createSmlibKernel, ExactKernelError, type ExactKernel, type ExactSolid } from '../dist/index.js';

let k: ExactKernel;
beforeAll(async () => { k = await createSmlibKernel(); });
const asset = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url));
const rel = (a: number, b: number) => Math.abs(a - b) / Math.abs(b);
const rejects = (fn: () => unknown, code: ExactKernelError['code'], pattern: RegExp) => {
  let error: unknown;
  try { fn(); } catch (e) { error = e; }
  expect(error, 'expected an ExactKernelError').toBeInstanceOf(ExactKernelError);
  expect((error as ExactKernelError).code).toBe(code);
  expect((error as Error).message).toMatch(pattern);
};
const same = (a: ExactSolid, b: ExactSolid, tolerance = 1e-9) => {
  expect(rel(k.volume(b), k.volume(a))).toBeLessThanOrEqual(tolerance);
  expect(rel(k.area(b), k.area(a))).toBeLessThanOrEqual(tolerance);
  const p = k.bbox(a), q = k.bbox(b);
  for (let i = 0; i < 3; i++) {
    expect(Math.abs(p.min[i] - q.min[i])).toBeLessThanOrEqual(1e-6);
    expect(Math.abs(p.max[i] - q.max[i])).toBeLessThanOrEqual(1e-6);
  }
};

describe('importStepBodies: round trips', () => {
  it('reads back what exportStep writes, exactly', () => k.scope(() => {
    const parts = [
      k.fillet(k.box([40, 30, 20]), 3),
      k.shell(k.chamfer(k.cylinder(12, 30), 1.5), 2, [0, 0, 1]),
      k.subtract(k.box([50, 50, 10]), k.translate(k.cylinder(5, 20), [10, 10, 0])),
      k.revolve(k.profile.path([4, 0], [{ kind: 'line', to: [10, 0] }, { kind: 'arc', via: [13, 5], to: [10, 10] }, { kind: 'line', to: [4, 10] }]), 360),
      k.rotate(k.translate(k.sphere(7), [3, -2, 9]), [1, 1, 0], 33),
    ];
    for (const part of parts) {
      const read = k.importStepBodies(k.exportStep(part));
      expect(read.bodies).toHaveLength(1);
      expect(read.notes).toEqual([]);
      expect(k.isValid(read.bodies[0].solid)).toBe(true);
      same(part, read.bodies[0].solid);
      // The kernel's own STEP of an imported body reads back the same again.
      same(part, k.importStepBodies(k.exportStep(read.bodies[0].solid)).bodies[0].solid);
    }
  }));
  it('keeps several bodies apart, in file order, without joining them', () => k.scope(() => {
    const touching = k.union(k.box([10, 10, 10]), k.translate(k.box([10, 10, 10]), [30, 0, 0]));
    const step = k.exportStep(touching);
    const read = k.importStepBodies(step);
    expect(read.bodies.map(b => k.volume(b.solid))).toEqual([expect.closeTo(1000, 9), expect.closeTo(1000, 9)]);
    expect(read.bodies.map(b => k.bbox(b.solid).min[0])).toEqual([expect.closeTo(-5, 9), expect.closeTo(25, 9)]);
    // The lenient importStep joins them into one solid.
    expect(k.solidCount(k.importStep(step))).toBe(2);
  }));
  it('accepts the file as bytes (Latin-1, as on disk)', () => k.scope(() => {
    const read = k.importStepBodies(new TextEncoder().encode(k.exportStep(k.box([1, 2, 3]))));
    expect(k.volume(read.bodies[0].solid)).toBeCloseTo(6, 12);
  }));
  it('converts inch files to millimetres', () => k.scope(() => {
    const step = k.exportStep(k.box([1, 2, 3]));
    const mm = /#(\d+)=\(LENGTH_UNIT\(\) NAMED_UNIT\(\*\) SI_UNIT\(\.MILLI\.,\.METRE\.\)\);/.exec(step);
    expect(mm, 'the exporter writes a millimetre length unit').not.toBeNull();
    const inch = step.replace(mm![0], `#${mm![1]}=(CONVERSION_BASED_UNIT('INCH',#9001) LENGTH_UNIT() NAMED_UNIT(#9002));\n#9001=LENGTH_MEASURE_WITH_UNIT(LENGTH_MEASURE(25.4),#9003);\n#9002=DIMENSIONAL_EXPONENTS(1.,0.,0.,0.,0.,0.,0.);\n#9003=(LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.));`);
    const solid = k.importStepBodies(inch).bodies[0].solid;
    expect(rel(k.volume(solid), 6 * 25.4 ** 3)).toBeLessThanOrEqual(1e-12);
    expect(k.bbox(solid).max[2]).toBeCloseTo(1.5 * 25.4, 9);
  }));
});

describe('importStepBodies: files from other writers', () => {
  // OpenCASCADE 7.6 (AP242), written by the lab's catalog tooling (MIT); volumes measured here
  // once and pinned, boxes from the parts' own catalog dimensions.
  const seeds: [string, number, [number, number, number], [number, number, number]][] = [
    ['assets/parts-seed/socket-head-cap-screw/iso-4762-m2x4.step', 35.249, [-1.9, -1.9, -4], [1.9, 1.9, 2]],
    ['assets/parts-seed/stepper-motor/nema-17.step', 70911.866, [-21.15, -21.15, 0], [21.15, 21.15, 64]],
    ['assets/parts-seed/heat-set-insert/heatset-m3-l5-7.step', 50.364, [-2.25, -2.25, 0], [2.25, 2.25, 5.7]],
  ];
  for (const [path, volume, min, max] of seeds) {
    it(`reads ${path.split('/').pop()} as one valid solid`, () => k.scope(() => {
      const read = k.importStepBodies(asset(path));
      expect(read.bodies).toHaveLength(1);
      const s = read.bodies[0].solid, box = k.bbox(s);
      expect(k.isValid(s)).toBe(true);
      expect(rel(k.volume(s), volume)).toBeLessThanOrEqual(2e-5);
      for (let i = 0; i < 3; i++) { expect(box.min[i]).toBeCloseTo(min[i], 2); expect(box.max[i]).toBeCloseTo(max[i], 2); }
      // Re-written by this kernel, the body reads back the same.
      same(s, k.importStepBodies(k.exportStep(s)).bodies[0].solid);
    }));
  }
  it('reads an AP242 file with names and colours (SO-100 passive horn, Apache-2.0)', () => k.scope(() => {
    const read = k.importStepBodies(asset('examples/robot-arm/so100/parts/Passive_Horn.step'));
    expect(read.bodies).toHaveLength(1);
    const [body] = read.bodies;
    expect(body.name).toBe('Body1');
    expect(body.color).toEqual([expect.closeTo(0.627, 3), expect.closeTo(0.627, 3), expect.closeTo(0.627, 3)]);
    expect(k.volume(body.solid)).toBeCloseTo(578.996, 2);
  }));
});

describe('importStepBodies: refusals (never a partial import)', () => {
  const box = () => k.scope(() => k.exportStep(k.box([10, 20, 30])));
  it('refuses input that is not STEP text', () => {
    rejects(() => k.importStepBodies(''), 'invalid-input', /empty/);
    rejects(() => k.importStepBodies('solid cube\nendsolid cube\n'), 'invalid-input', /not a STEP file/);
    rejects(() => k.importStepBodies(42 as never), 'invalid-input', /text or bytes/);
    rejects(() => k.importStepBodies('ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\n#1=FOO(;\nENDSEC;\nEND-ISO-10303-21;\n'), 'invalid-input', /malformed/);
    const step = box();
    rejects(() => k.importStepBodies(step.slice(0, step.length >> 1)), 'invalid-input', /incomplete/);
  });
  it('refuses a file without a solid', () => {
    rejects(() => k.importStepBodies('ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n'), 'unsupported', /holds no solid/);
  });
  it('refuses a body the reader cannot build, even when other bodies could be read', () => {
    const one = k.scope(() => k.exportStep(k.union(k.box([10, 10, 10]), k.translate(k.box([10, 10, 10]), [30, 0, 0]))));
    // The first plane of the file becomes an entity the reader does not know.
    const broken = one.replace(/=PLANE\(/, '=FOO_SURFACE(');
    rejects(() => k.importStepBodies(broken), 'unsupported', /cannot be read exactly: .*FOO_SURFACE/);
    // The lenient importStep leaves that body out instead.
    k.scope(() => expect(k.volume(k.importStep(broken))).toBeCloseTo(1000, 9));
  });
  it('refuses an open surface (sheet) and a solid with a missing face', () => {
    const step = box();
    const sheet = step.replace(/MANIFOLD_SOLID_BREP\('([^']*)',(#\d+)\)/, "SHELL_BASED_SURFACE_MODEL('$1',($2))").replace('CLOSED_SHELL', 'OPEN_SHELL').replace('ADVANCED_BREP_SHAPE_REPRESENTATION', 'MANIFOLD_SURFACE_SHAPE_REPRESENTATION');
    rejects(() => k.importStepBodies(sheet), 'unsupported', /open surface \(a sheet\), not a closed solid/);
    const holed = step.replace(/CLOSED_SHELL\('',\(#\d+,/, "CLOSED_SHELL('',(");
    rejects(() => k.importStepBodies(holed), 'unsupported', /not a valid closed solid/);
  });
  it('refuses more bodies than maxBodies', () => {
    const two = k.scope(() => k.exportStep(k.union(k.box([1, 1, 1]), k.translate(k.box([1, 1, 1]), [5, 0, 0]))));
    rejects(() => k.importStepBodies(two, { maxBodies: 1 }), 'unsupported', /holds 2 bodies; at most 1/);
    rejects(() => k.importStepBodies(two, { maxBodies: 0 }), 'invalid-input', /maxBodies/);
  });
  it('leaves no kernel objects behind after a refusal and keeps working', () => {
    const holed = box().replace(/CLOSED_SHELL\('',\(#\d+,/, "CLOSED_SHELL('',(");
    const sheetless = 'ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n';
    const before = k.memory().handles;
    for (const text of [holed, sheetless, holed]) {
      try { k.importStepBodies(text); } catch { /* refused */ }
    }
    expect(k.memory().handles).toBe(before);
    const read = k.importStepBodies(box());
    expect(k.volume(read.bodies[0].solid)).toBeCloseTo(6000, 9);
    read.bodies.forEach(b => b.solid.dispose());
  });
});
