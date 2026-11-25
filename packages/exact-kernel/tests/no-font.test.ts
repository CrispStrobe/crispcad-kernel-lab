// SPDX-License-Identifier: MIT
// Copyright (c) 2026 CrispCAD contributors
//
// The bundle replaces smlibwasm's font module with an empty one. Modeling and STEP do not use
// it; Text() without a font fails cleanly with an `unsupported` error.
import { readdirSync, readFileSync } from 'node:fs';
import { beforeAll, expect, it } from 'vitest';
import { createSmlibKernel, ExactKernelError, type ExactKernel } from '../dist/index.js';

let k: ExactKernel;
beforeAll(async () => { k = await createSmlibKernel(); });
const dist = new URL('../dist/', import.meta.url);

it('bundles an empty font module', () => {
  const js = readdirSync(dist).filter(f => f.endsWith('.js')).map(f => readFileSync(new URL(f, dist), 'utf8')).join('\n');
  expect(js).toContain('var LATO_REGULAR = "";');
  expect(js.match(/var LATO_REGULAR = /g)).toHaveLength(1);
});

it('reports Text() as unsupported, cleanly', () => {
  let error: unknown;
  try { k.profile.text('A', 10).dispose(); } catch (e) { error = e; }
  expect(error).toBeInstanceOf(ExactKernelError);
  expect((error as ExactKernelError).code).toBe('unsupported');
  expect((error as Error).message).toMatch(/font/);
});

it('models, shells and round-trips STEP without the font', () => {
  k.scope(() => {
    const part = k.shell(k.fillet(k.box([40, 30, 20]), 3), 2, [0, 0, 1]);
    const step = k.exportStep(part), back = k.importStep(step);
    expect(k.isValid(part)).toBe(true);
    expect(step.startsWith('ISO-10303-21;')).toBe(true);
    expect(Math.abs(k.volume(back) - k.volume(part)) / k.volume(part)).toBeLessThan(1e-9);
    return 0;
  });
});

it('licence of the running kernel is MIT AND Apache-2.0', () => {
  expect(k.licence).toBe('MIT AND Apache-2.0');
  expect(k.version).toBe('0.6.2');
});
