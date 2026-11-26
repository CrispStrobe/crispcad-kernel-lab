// SPDX-License-Identifier: MIT
// Copyright (c) 2026 CrispCAD contributors
//
// Licence gate on the packed tarball: `npm pack` the package (built by `pretest`), unpack it,
// and fail on any file that is not MIT or Apache-2.0: unknown files, OFL or (L/A)GPL licence
// text, the upstream font's data, runtime dependencies, and replicad / OpenCASCADE references.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const ALLOWED = new Set(['MIT', 'Apache-2.0', 'MIT AND Apache-2.0', 'Apache-2.0 AND MIT']);
/** Every shipped path and its licence. A file matching no rule fails the test. */
const RULES: [RegExp, string][] = [
  [/^package\.json$/, 'MIT'],
  [/^README\.md$/, 'MIT'],
  [/^LICENSE$/, 'MIT'],
  [/^NOTICE$/, 'MIT AND Apache-2.0'],
  [/^BUILD-PROVENANCE\.json$/, 'MIT'],
  [/^licenses\/(smlibwasm|emscripten)-LICENSE$/, 'MIT'],
  [/^licenses\/usd-brep-LICENSE$/, 'Apache-2.0'],
  [/^dist\/(index|exact-kernel|smlib-kernel|polytope|validate)\.d\.ts$/, 'MIT'],
  [/^dist\/(index|chunk-[A-Z0-9]+|_defeature_supervisor|_defeature_worker)\.js$/, 'MIT'],
  [/^dist\/smlibwasm\.wasm$/, 'Apache-2.0 AND MIT'],
  [/^dist\/bundle-inputs\.json$/, 'MIT'],
];
const LICENCE_TEXT: [string, RegExp][] = [
  ['OFL', /Open Font License|SIL OFL|OFL-1\.[01]|Reserved Font Name/i],
  ['GPL', /\b[LA]?GPL(-[0-9])?\b|GNU (Lesser |Library |Affero )?General Public License/],
];
/** The only places "OpenCASCADE" may appear: smlibwasm's .brep file-format reader/writer
 * (version banners, messages about the file format, and that module's file name dist/occt.js,
 * also as a key of BUILD-PROVENANCE.json's file hashes),
 * not OpenCASCADE code. */
const BREP_FORMAT = [/Open CASCADE Topology/g, /CASCADE Topology/g, /\(c\) Open Cascade/g, /an OpenCASCADE \.brep file/g, /as OpenCASCADE reads (such files|them)/g, /for OCCT export/g, /smlibwasm(@[0-9.]+)?\/dist\/occt\.js/g, /"dist\/occt\.(d\.ts|js)"/g];

let dir: string, files: string[];
const walk = (d: string): string[] => readdirSync(d).flatMap(n => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'exact-kernel-pack-'));
  const [packed] = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', dir], { cwd: root, encoding: 'utf8' }));
  execFileSync('tar', ['-xzf', join(dir, packed.filename), '-C', dir]);
  files = walk(join(dir, 'package')).map(f => relative(join(dir, 'package'), f)).sort();
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const read = (f: string) => readFileSync(join(dir, 'package', f));

describe('packed tarball licence closure: MIT and Apache-2.0 only', () => {
  it('ships only files with a known MIT or Apache-2.0 licence', () => {
    const unknown = files.filter(f => !RULES.some(([re]) => re.test(f)));
    expect(unknown).toEqual([]);
    for (const f of files) expect(ALLOWED.has(RULES.find(([re]) => re.test(f))![1]), f).toBe(true);
    expect(files).toContain('dist/smlibwasm.wasm');
    expect(files).toContain('licenses/usd-brep-LICENSE');
    expect(files).toContain('NOTICE');
  });
  it('has no runtime dependencies and declares MIT AND Apache-2.0', () => {
    const pkg = JSON.parse(read('package.json').toString('utf8'));
    expect(pkg.license).toBe('MIT AND Apache-2.0');
    for (const key of ['dependencies', 'optionalDependencies', 'peerDependencies', 'bundleDependencies', 'bundledDependencies']) expect(pkg[key], key).toBeUndefined();
  });
  it('records an MIT or Apache-2.0 licence for every bundle input, and no font', () => {
    const { inputs } = JSON.parse(read('dist/bundle-inputs.json').toString('utf8')) as { inputs: { file: string; licence: string }[] };
    expect(inputs.length).toBeGreaterThan(50);
    for (const i of inputs) expect(ALLOWED.has(i.licence), i.file).toBe(true);
    expect(inputs.filter(i => /_fonts|\/fonts\//.test(i.file))).toEqual([]);
    expect(inputs.filter(i => /replicad|opencascade/i.test(i.file))).toEqual([]);
  });
  it('ships the provenance of its smlibwasm build, and the module it pins', () => {
    const prov = JSON.parse(read('BUILD-PROVENANCE.json').toString('utf8'));
    expect(prov.sources.smlibpy.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(prov.sources['usd-brep'].commit).toMatch(/^[0-9a-f]{40}$/);
    expect(prov.sources.emsdk.version).toBe('6.0.12');
    expect(createHash('sha256').update(read('dist/smlibwasm.wasm')).digest('hex')).toBe(prov.files['wasm/smlibwasm.wasm']);
    const { smlibwasm, wasmSha256 } = JSON.parse(read('dist/bundle-inputs.json').toString('utf8'));
    expect([smlibwasm, wasmSha256]).toEqual([prov.version, prov.files['wasm/smlibwasm.wasm']]);
    expect(read('NOTICE').toString('utf8')).toContain('BUILD-PROVENANCE.json');
  });
  it('contains no OFL or GPL licence text', () => {
    for (const f of files) {
      const text = read(f).toString('latin1');
      for (const [name, re] of LICENCE_TEXT) expect(re.test(text), `${name} text in ${f}`).toBe(false);
    }
  });
  it('contains none of the upstream font data', () => {
    const fontFile = join(root, 'node_modules/@classcad/smlibwasm/dist/_fonts.js');
    const upstream = existsSync(fontFile) ? fontFile : fileURLToPath(new URL('../../../node_modules/@classcad/smlibwasm/dist/_fonts.js', import.meta.url));
    const samples = readFileSync(upstream, 'utf8').split('\n').filter(l => /^[A-Za-z0-9+/=]{80,}$/.test(l));
    expect(samples.length).toBeGreaterThan(1000);
    const picked = samples.filter((_, i) => i % 25 === 0);
    for (const f of files) {
      const text = read(f).toString('latin1');
      expect(picked.filter(line => text.includes(line)), f).toEqual([]);
      expect(/d09GMg|d09GRg/.test(text), `WOFF data in ${f}`).toBe(false);
    }
  });
  it('references neither replicad nor OpenCASCADE', () => {
    for (const f of files) {
      let text = read(f).toString('latin1');
      expect(/replicad/i.test(text), `replicad in ${f}`).toBe(false);
      if (f === 'NOTICE' || f === 'README.md') continue; // they explain the .brep banners below
      for (const re of BREP_FORMAT) text = text.replace(re, '');
      expect(/open ?cascade|opencascade\.js|occt-import|\bOCCT\b/i.test(text), `OpenCASCADE reference in ${f}`).toBe(false);
    }
  });
});
