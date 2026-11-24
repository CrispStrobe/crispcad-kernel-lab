// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Andrii Shylenko and kernelCAD contributors
// src/agent/mcp/tools/surfaceQualityOverlay.test.ts
//
// Characterisation test for `buildSurfaceQualityOverlay`: pins the generated
// overlay script bytes and every band STL (sha256 + size) for zebra /
// curvature / continuity on representative shapes, plus the load-failure
// envelope. Added before the function's phase split so the split can be
// verified as behaviour-preserving.

import { beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { initOcct } from '../../../kernel/backends/occt/occtBackend';
import { buildSurfaceQualityOverlay, type SurfaceQualityOverlay } from './surfaceQualityOverlay';

const sha256 = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');

interface ExpectedFile {
  size: number;
  sha: string;
}

interface Expected {
  scriptSha: string;
  files: Record<string, ExpectedFile>;
}

// overlay.kcad.ts pins changed only by the generated header comment naming CrispCAD.
const CASES: Array<{ name: string; overlay: SurfaceQualityOverlay; code: string; expected: Expected }> = [
  {
    name: 'zebra on a box',
    overlay: 'zebra',
    code: 'return box(20, 20, 20);',
    expected: {
      scriptSha: '12f4826fac4b94ad34009c33732601ea3a468bf968ef009961c2d7084d11ab1c',
      files: {
        'overlay.kcad.ts': { size: 410, sha: '12f4826fac4b94ad34009c33732601ea3a468bf968ef009961c2d7084d11ab1c' },
        'zebra-2.stl': { size: 284, sha: '7fc3b1f9af252e87f905032fb4bc56f1f037ddbc235efb01501162ff9efafff7' },
        'zebra-4.stl': { size: 284, sha: 'a92115cfee61fd85abcf369b68426a7b8f7fbf1f73c3e42667cc2a572d899a1d' },
        'zebra-5.stl': { size: 284, sha: '166dbc68c68d3edfd8e4505e27db2da21aeb3b9f30f210eac39f8d0661db2dd8' },
      },
    },
  },
  {
    name: 'zebra on a sphere',
    overlay: 'zebra',
    code: 'return sphere(10);',
    expected: {
      scriptSha: 'dfb2b15c93893516133d5e54148136ac6026348e7a1f7273a38f36bdfd235b6a',
      files: {
        'overlay.kcad.ts': { size: 895, sha: 'dfb2b15c93893516133d5e54148136ac6026348e7a1f7273a38f36bdfd235b6a' },
        'zebra-0.stl': { size: 11484, sha: '519a16763ce63724e7fd6a6f6075313cd983133888dec3261638a81fb054023e' },
        'zebra-1.stl': { size: 4184, sha: 'b09eb14d009189cceae8d604f1de69502ddc9e25d7ea7dfb3871f49485c1b017' },
        'zebra-2.stl': { size: 5334, sha: '765f4bf17fd4cd1f010da317aaf3314e9b944acaa8a926bff72ba7aca52a1dab' },
        'zebra-3.stl': { size: 3184, sha: '4bd9f6463c689fdd2fd503a86e9ca5552ed95aa44af6cff41bf50f10d8e89f5e' },
        'zebra-4.stl': { size: 4834, sha: '79c3f747bf2809ad2af0b97f3becf8807746c2756de1a8daf973ad3fe228bd88' },
        'zebra-5.stl': { size: 5284, sha: 'fbf3d0f4b39e3b7fed0adf49f01f787a1f0f8c6e5fec6c11e3ef288c854cad01' },
        'zebra-6.stl': { size: 3834, sha: 'fbffafb4c3a8a28643ab82eae2f0b96791c18ce1316dbaf7f6050fd438d36d2b' },
        'zebra-7.stl': { size: 11934, sha: '2de57456b92b5cb0d506fa7aca753f0cadfea28ad54a0e7600eb8c11181546c8' },
      },
    },
  },
  {
    name: 'curvature on a sphere',
    overlay: 'curvature',
    code: 'return sphere(10);',
    expected: {
      scriptSha: '00530fd149d26f958154f1a4eb5c924cc60c261c6a64785b55910b1a04a0a336',
      files: {
        'overlay.kcad.ts': { size: 214, sha: '00530fd149d26f958154f1a4eb5c924cc60c261c6a64785b55910b1a04a0a336' },
        'curv-7.stl': { size: 49484, sha: 'edb9409a9957bc9ab107c1c415ec11df2b1b3d118aa3d1b878fcf51068e82360' },
      },
    },
  },
  {
    name: 'continuity on a filleted box',
    overlay: 'continuity',
    code: 'return box(20, 20, 20).fillet(3);',
    expected: {
      scriptSha: '62634ab9370352d1956645bd37f6a2f128c12337bf9889805ea25f1d1023a929',
      files: {
        'overlay.kcad.ts': { size: 299, sha: '62634ab9370352d1956645bd37f6a2f128c12337bf9889805ea25f1d1023a929' },
        'g1.stl': { size: 153684, sha: 'a07b6f2f70cc49983f766fac93a0587f22fd9ce9d81fa265e698e33b0d4016f0' },
        'ghost.stl': { size: 69084, sha: '7cfca56de49b17a89789c70c1d6ef7bc24bddd866cc868500870f609502380b5' },
      },
    },
  },
];

beforeAll(async () => {
  await initOcct();
}, 60_000);

describe('buildSurfaceQualityOverlay — characterisation', () => {
  for (const c of CASES) {
    it(`pins the overlay bytes for ${c.name}`, async () => {
      const outDir = await mkdtemp(join(tmpdir(), 'sqo-char-'));
      const r = await buildSurfaceQualityOverlay({ code: c.code, overlay: c.overlay, outDir });
      expect(r.ok, r.ok ? '' : r.error).toBe(true);
      if (!r.ok) return;

      const script = await readFile(r.scriptPath, 'utf8');
      expect(sha256(script)).toBe(c.expected.scriptSha);

      const overlayDir = join(outDir, 'overlay');
      const names = (await readdir(overlayDir)).sort();
      expect(names).toEqual(Object.keys(c.expected.files).sort());
      for (const name of names) {
        const bytes = await readFile(join(overlayDir, name));
        expect(bytes.length, name).toBe(c.expected.files[name].size);
        expect(sha256(bytes), name).toBe(c.expected.files[name].sha);
      }
    }, 120_000);
  }

  it('propagates a script load failure in the result envelope', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'sqo-char-'));
    const r = await buildSurfaceQualityOverlay({ code: 'return nope();', overlay: 'zebra', outDir });
    expect(r).toEqual({ ok: false, error: 'ReferenceError: nope is not defined', errorCode: 'cli.script-exception' });
  }, 60_000);
});
