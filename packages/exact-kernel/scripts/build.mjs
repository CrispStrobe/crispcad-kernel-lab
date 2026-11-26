// SPDX-License-Identifier: MIT
// Copyright (c) 2026 CrispCAD contributors
//
// Prebundles this package with smlibwasm 0.6.2 into dist/, so the published tarball has no
// runtime dependencies:
// - dist/index.js (+ shared chunks): this package and smlibwasm's JavaScript (MIT);
// - dist/_defeature_supervisor.js, dist/_defeature_worker.js: smlibwasm's probe workers, which
//   it starts from files next to its own module;
// - dist/smlibwasm.wasm: SMLib / USD BRep (Apache-2.0) with AWV's bindings (MIT), loaded from next
//   to the bundle;
// - dist/*.d.ts: this package's types;
// - dist/bundle-inputs.json: every source file inside the bundle, with its licence, and where the
//   smlibwasm build came from.
// smlibwasm's dist/_fonts.js (the Lato font, OFL-1.1) is replaced by an empty module: modeling
// and STEP do not use it, and Text() without a font then fails cleanly.
//
// smlibwasm is taken from the nearest node_modules/@classcad/smlibwasm: for a release, the tree
// scripts/build-smlibwasm.sh builds from source, which scripts/release.sh puts in this package's
// node_modules (it carries a `.source-build.json`); otherwise the lab's npm install. Either way
// every smlibwasm file the bundle uses must have the sha256 pinned in BUILD-PROVENANCE.json, so
// both give the same bytes.
import esbuild from 'esbuild';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertPinned, provenance } from './smlibwasm-provenance.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const require = createRequire(join(root, 'package.json'));
// The installed tree as seen from here (not its real path), so bundle paths stay relative.
const smlibDir = (() => {
  for (let dir = root; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules/@classcad/smlibwasm');
    if (existsSync(join(candidate, 'package.json'))) return candidate;
    if (dirname(dir) === dir) throw new Error('No smlibwasm tree found: run scripts/build-smlibwasm.sh (or npm install in the lab).');
  }
})();
const smlib = JSON.parse(readFileSync(join(smlibDir, 'package.json'), 'utf8'));
if (smlib.version !== provenance.version) throw new Error(`smlibwasm ${smlib.version} is at ${smlibDir}; this package pins ${provenance.version}.`);
// Everything the bundle reads: the JavaScript (not the font), the loader and the module.
assertPinned(smlibDir, smlibDir, f => f.startsWith('wasm/') || (f.startsWith('dist/') && f.endsWith('.js') && f !== 'dist/_fonts.js'));
// The memory ceiling (src/smlib-kernel.ts, RESIZE_HEAP_IMPORT) wraps the loader's heap-resize
// import by its keys in the module's import table, not by the function's name, which minifiers
// rename. Those keys are fixed by the pinned build; refuse a loader that hands it over elsewhere.
{
  const loader = readFileSync(join(smlibDir, 'wasm/smlibwasm.mjs'), 'utf8');
  const table = /var wasmImports=\{([^}]*)\}/.exec(loader)?.[1] ?? '';
  if (!/\{a:wasmImports\}/.test(loader) || !/(^|,)D:_emscripten_resize_heap(,|$)/.test(table)) {
    throw new Error('smlibwasm\'s loader does not pass _emscripten_resize_heap as import a.D: update RESIZE_HEAP_IMPORT in src/smlib-kernel.ts.');
  }
}
const sourceBuild = existsSync(join(smlibDir, '.source-build.json')) ? JSON.parse(readFileSync(join(smlibDir, '.source-build.json'), 'utf8')) : undefined;

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

const noFont = {
  name: 'no-font',
  setup(build) {
    build.onResolve({ filter: /(^|\/)_fonts(\.js)?$/ }, args => (args.importer.includes('@classcad/smlibwasm') ? { path: 'smlibwasm-no-font', namespace: 'no-font' } : undefined));
    build.onLoad({ filter: /.*/, namespace: 'no-font' }, () => ({ contents: 'export const LATO_REGULAR = "";\n', loader: 'js' }));
  },
};

const result = await esbuild.build({
  absWorkingDir: root,
  entryPoints: {
    index: 'src/index.ts',
    _defeature_supervisor: join(smlibDir, 'dist/_defeature_supervisor.js'),
    _defeature_worker: join(smlibDir, 'dist/_defeature_worker.js'),
  },
  outdir: dist,
  bundle: true,
  splitting: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  mainFields: ['module', 'main'],
  external: ['node:*'],
  chunkNames: 'chunk-[hash]',
  legalComments: 'inline',
  metafile: true,
  preserveSymlinks: true,
  plugins: [noFont],
  logLevel: 'warning',
});

copyFileSync(join(smlibDir, 'wasm/smlibwasm.wasm'), join(dist, 'smlibwasm.wasm'));

const licenceOf = input => {
  if (input.startsWith('no-font:')) return { file: input, licence: 'MIT', note: 'empty stand-in for smlibwasm dist/_fonts.js' };
  const abs = resolve(root, input);
  if (abs.startsWith(join(root, 'src') + '/')) return { file: relative(root, abs), licence: 'MIT', note: 'this package' };
  if (abs.startsWith(smlibDir + '/')) {
    const file = `@classcad/smlibwasm@${smlib.version}/${relative(smlibDir, abs)}`;
    if (file.endsWith('/dist/_fonts.js') || file.includes('/fonts/')) throw new Error(`The font reached the bundle: ${file}`);
    return { file, licence: 'MIT', note: file.includes('/wasm/') ? 'Emscripten loader of the SMLib module (AWV Informatik AG; Emscripten runtime, MIT)' : file.includes('_brotli_dictionary') ? 'Brotli static dictionary (Brotli authors, MIT)' : 'AWV Informatik AG' };
  }
  throw new Error(`Unexpected bundle input ${input}`);
};
const inputs = Object.keys(result.metafile.inputs).sort().map(licenceOf);
inputs.push({ file: `@classcad/smlibwasm@${smlib.version}/wasm/smlibwasm.wasm`, licence: 'Apache-2.0 AND MIT', note: 'SMLib / USD BRep (NVIDIA, Apache-2.0) with AWV bindings (MIT); copied as dist/smlibwasm.wasm' });
const built = sourceBuild
  ? { from: 'source', smlibpy: provenance.sources.smlibpy.commit, 'usd-brep': provenance.sources['usd-brep'].commit, emsdk: provenance.sources.emsdk.version, builtAt: sourceBuild.builtAt, host: sourceBuild.host }
  : { from: 'npm', note: 'the lab\'s npm install of @classcad/smlibwasm, byte-identical to the source build (BUILD-PROVENANCE.json)' };
writeFileSync(join(dist, 'bundle-inputs.json'), JSON.stringify({ smlibwasm: smlib.version, build: built, wasmSha256: provenance.files['wasm/smlibwasm.wasm'], fontReplaced: 'dist/_fonts.js', inputs }, null, 2) + '\n');

// Types: only the public modules (the adapter internals reference smlibwasm's own types).
const typesDir = join(root, '.types');
rmSync(typesDir, { recursive: true, force: true });
execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', join(root, 'tsconfig.build.json')], { stdio: 'inherit' });
for (const name of ['index', 'exact-kernel', 'smlib-kernel', 'polytope', 'validate']) {
  const text = readFileSync(join(typesDir, `${name}.d.ts`), 'utf8').replace(/from '(\.\/[^']+)\.ts'/g, "from '$1.js'");
  if (/from '@classcad|import\(|smlib-context|smlib-profile/.test(text)) throw new Error(`${name}.d.ts exposes adapter internals`);
  writeFileSync(join(dist, `${name}.d.ts`), text);
}
rmSync(typesDir, { recursive: true, force: true });

const files = readdirSync(dist).sort();
console.log(`dist/: ${files.length} files, ${(files.reduce((s, f) => s + readFileSync(join(dist, f)).length, 0) / 2 ** 20).toFixed(1)} MiB; ${inputs.length} bundle inputs`);
