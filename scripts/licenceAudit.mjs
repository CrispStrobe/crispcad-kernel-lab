#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// CrispCAD licence audit: every package in the RUNTIME dependency closure
// (package-lock.json, dev-only packages excluded, optional platform binaries
// included) must carry a permissive licence. Package metadata is not trusted
// blindly: BUNDLED lists packages whose own licence field understates what they
// ship (for example an MIT wrapper around an LGPL WebAssembly build).
//
//   node scripts/licenceAudit.mjs [--json] [--root <dir>]
//
// Exit 1 when a finding is not recorded in scripts/lib/licenceBaseline.json.
// The baseline may only shrink: an entry that no longer matches is reported so
// it can be deleted.
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** SPDX identifiers accepted without review (MIT/Apache/BSD-like and public-domain style). */
export const PERMISSIVE = new Set([
  'MIT', 'MIT-0', 'ISC', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', '0BSD', 'BlueOak-1.0.0',
  'CC0-1.0', 'Unlicense', 'Zlib', 'Python-2.0', 'BSL-1.0', 'OFL-1.1', 'CC-BY-4.0', 'W3C', 'WTFPL',
]);

/** Packages whose shipped contents carry a stronger licence than their package.json says. */
export const BUNDLED = {
  'replicad-opencascadejs': 'LGPL-2.1-only WITH OCCT-exception-1.0',
};

/** Packages without a licence field whose licence was verified from their LICENSE file.
 *  The audit re-reads the file and requires the marker text, so a changed file is caught. */
export const VERIFIED = {
  'webgl-constants': { license: 'MIT', file: 'node_modules/webgl-constants/LICENSE', marker: 'MIT License' },
  'vendor/verb-nurbs': { license: 'MIT', file: 'vendor/verb-nurbs/LICENSE', marker: 'The MIT License' },
};

const COPYLEFT = /^(A?GPL|LGPL|MPL|EPL|CDDL|SSPL|EUPL|OSL|CPAL)/i;

/** Evaluate an SPDX expression: an OR alternative passes when all of its AND terms
 *  are permissive; `X WITH exception` is judged by X. */
export function classify(expression) {
  if (!expression || typeof expression !== 'string') return { status: 'unknown', reason: 'no licence declared' };
  const alternatives = expression.replace(/[()]/g, ' ').split(/\s+OR\s+/).map(alt => alt.split(/\s+AND\s+/).map(term => term.trim().split(/\s+WITH\s+/)[0]));
  if (alternatives.some(terms => terms.every(id => PERMISSIVE.has(id)))) return { status: 'permissive' };
  if (alternatives.flat().some(id => COPYLEFT.test(id))) return { status: 'copyleft', reason: expression };
  return { status: 'unknown', reason: expression };
}

export function audit(root) {
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
  const findings = [];
  for (const [path, entry] of Object.entries(lock.packages ?? {})) {
    if (!path || entry.dev || entry.link) continue;
    const name = path.replace(/^.*node_modules\//, '');
    let license = entry.license;
    if (license && typeof license === 'object') license = license.type;
    if (!license) {
      const manifest = join(root, path, 'package.json');
      if (existsSync(manifest)) { const m = JSON.parse(readFileSync(manifest, 'utf8')); license = typeof m.license === 'object' ? m.license?.type : m.license; }
    }
    const declared = license ?? null;
    const verified = VERIFIED[name];
    if (!license && verified && existsSync(join(root, verified.file)) && readFileSync(join(root, verified.file), 'utf8').includes(verified.marker)) license = verified.license;
    if (BUNDLED[name]) license = BUNDLED[name];
    const verdict = classify(license);
    if (verdict.status !== 'permissive') findings.push({ package: name, path, version: entry.version ?? null, declared, effective: license ?? null, status: verdict.status, optional: !!entry.optional });
  }
  return findings.sort((a, b) => a.path.localeCompare(b.path));
}

function main() {
  const args = process.argv.slice(2), at = args.indexOf('--root');
  const root = resolve(at >= 0 ? args[at + 1] : fileURLToPath(new URL('..', import.meta.url)));
  const baselinePath = join(root, 'scripts/lib/licenceBaseline.json');
  const baseline = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, 'utf8')) : { packages: {} };
  const findings = audit(root);
  const fresh = findings.filter(f => !baseline.packages[f.package]);
  const stale = Object.keys(baseline.packages).filter(name => !findings.some(f => f.package === name));
  if (args.includes('--json')) { process.stdout.write(JSON.stringify({ findings, fresh, stale }, null, 2) + '\n'); }
  else {
    const byPackage = new Map();
    for (const f of findings) byPackage.set(f.package, f);
    process.stdout.write(`Runtime closure findings: ${findings.length} package paths, ${byPackage.size} packages\n`);
    for (const f of byPackage.values()) process.stdout.write(`  ${baseline.packages[f.package] ? 'known' : 'NEW  '} ${f.status.padEnd(10)} ${f.package}@${f.version ?? '?'}  ${f.effective ?? '(none)'}${f.declared !== f.effective ? `  [declares ${f.declared ?? 'nothing'}]` : ''}${baseline.packages[f.package] ? `  — ${baseline.packages[f.package]}` : ''}\n`);
    for (const name of stale) process.stdout.write(`  resolved: ${name} no longer appears; delete it from scripts/lib/licenceBaseline.json\n`);
  }
  if (fresh.length) { process.stderr.write(`${fresh.length} new licence finding(s); CrispCAD accepts only MIT/Apache/BSD-like runtime dependencies.\n`); process.exitCode = 1; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
