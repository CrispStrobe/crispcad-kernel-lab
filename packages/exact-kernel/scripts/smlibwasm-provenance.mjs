// SPDX-License-Identifier: MIT
// Copyright (c) 2026 CrispCAD contributors
//
// Checks an smlibwasm package tree (a source build from build-smlibwasm.sh, or the npm package)
// against BUILD-PROVENANCE.json: every file listed there must exist with that sha256.
//
//   node scripts/smlibwasm-provenance.mjs <dir> [<dir> ...]   # exit 1 and list what differs
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const provenance = JSON.parse(readFileSync(join(root, 'BUILD-PROVENANCE.json'), 'utf8'));

export const sha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex');

/** The files of `dir` that are missing or differ from the pinned hashes (`only`: those paths). */
export function mismatches(dir, only) {
  const out = [];
  for (const [file, want] of Object.entries(provenance.files)) {
    if (only && !only(file)) continue;
    const path = join(dir, file);
    if (!existsSync(path)) out.push(`${file}: missing`);
    else if (sha256(path) !== want) out.push(`${file}: sha256 ${sha256(path)}, pinned ${want}`);
  }
  return out;
}

/** Throw, listing every difference, unless `dir` matches the pins. */
export function assertPinned(dir, what = dir, only) {
  const bad = mismatches(dir, only);
  if (bad.length) throw new Error(`${what} is not the pinned smlibwasm ${provenance.version} build (BUILD-PROVENANCE.json):\n  ${bad.join('\n  ')}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dirs = process.argv.slice(2);
  if (!dirs.length) { console.error('usage: node scripts/smlibwasm-provenance.mjs <dir> [<dir> ...]'); process.exit(2); }
  let failed = false;
  for (const dir of dirs) {
    const bad = mismatches(dir);
    if (bad.length) { failed = true; console.error(`${dir}: ${bad.length} of ${Object.keys(provenance.files).length} files differ from BUILD-PROVENANCE.json\n  ${bad.join('\n  ')}`); }
    else console.log(`${dir}: all ${Object.keys(provenance.files).length} files match BUILD-PROVENANCE.json (smlibwasm.wasm ${provenance.files['wasm/smlibwasm.wasm']})`);
  }
  process.exit(failed ? 1 : 0);
}
