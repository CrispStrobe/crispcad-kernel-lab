// SPDX-License-Identifier: MIT
// Copyright (c) 2026 CrispCAD contributors
//
// The memory ceiling in a minified bundle. An app that bundles this package minifies it, and the
// minifier renames functions: 0.1.6 found the loader's heap-resize import by its function name and
// refused to load with a ceiling in CrispCAD's production build. Here every dist/*.js file is
// minified by esbuild (as Vite does; no keepNames), the loader's function names are checked to be
// gone, and the minified kernel must hold the ceiling as the plain one does (tests/limits.test.ts).
// Its own file: the ceiling holds for the process, and vitest runs each test file in its own fork.
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { transform } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SmlibKernel } from '../dist/index.js';

const MiB = 2 ** 20;
const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const out = mkdtempSync(join(tmpdir(), 'exact-kernel-minified-'));
let minified = '';
let k: SmlibKernel;

beforeAll(async () => {
  for (const name of readdirSync(dist)) {
    if (name.endsWith('.js')) {
      const { code } = await transform(readFileSync(join(dist, name), 'utf8'), { loader: 'js', format: 'esm', target: 'es2022', minify: true, legalComments: 'none' });
      writeFileSync(join(out, name), code);
      minified += code;
    } else if (name === 'smlibwasm.wasm') {
      copyFileSync(join(dist, name), join(out, name));
    }
  }
  const { createSmlibKernel } = await import(pathToFileURL(join(out, 'index.js')).href) as typeof import('../dist/index.js');
  k = await createSmlibKernel({ maxMemoryBytes: 80 * MiB });
});
afterAll(() => rmSync(out, { recursive: true, force: true }));

describe('the memory ceiling in a minified bundle', () => {
  it('runs on a bundle whose loader functions were renamed', () => {
    const plain = readdirSync(dist).filter(n => n.endsWith('.js')).map(n => readFileSync(join(dist, n), 'utf8')).join('');
    expect(plain).toMatch(/function _emscripten_resize_heap\(/);
    // The minifier renamed the function; only the import table's keys stay.
    expect(minified).not.toMatch(/_emscripten_resize_heap/);
    expect(k.maxMemoryBytes).toBe(80 * MiB);
  });

  it('builds within the ceiling, and fails cleanly past it without growing beyond it', () => {
    expect(k.scope(() => k.volume(k.subtract(k.box([100, 100, 10]), k.cylinder(10, 30))))).toBeGreaterThan(0);
    // The sphere of tests/limits.test.ts: 261,124 triangles, 888 MiB of heap without a ceiling.
    let failure: unknown;
    try {
      k.scope(() => k.tessellate(k.sphere(50), { tolerance: 0.1, angleDeg: 1 }));
    } catch (e) {
      failure = e;
    }
    expect((failure as Error)?.name).toBe('ExactKernelError');
    expect(String((failure as Error).message)).toMatch(/out of memory/i);
    expect(k.memory().heap).toBeLessThanOrEqual(80 * MiB);
    expect(k.memory().heap).toBeGreaterThan(64 * MiB); // it did grow, up to the ceiling
    expect(k.scope(() => k.volume(k.box([1, 2, 3])))).toBeCloseTo(6, 12);
  });
});
