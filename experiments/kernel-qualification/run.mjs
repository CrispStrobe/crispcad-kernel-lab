#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Qualify an exact B-rep kernel on the 27 analytic reference parts without OpenCASCADE.
//   node experiments/kernel-qualification/run.mjs <smlibwasm|wasmlib> [--json out.json]
// Each part is built natively by the kernel; volume and area come from the kernel's
// own mass properties and are compared with assets/reference-parts/scorecard.json at
// the scorecard's own tolerances (1e-6 relative; 1e-8 for fillet/chamfer), bbox 0.05 mm.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const which = process.argv[2] ?? 'smlibwasm';
const root = fileURLToPath(new URL('../../', import.meta.url));
const scorecard = JSON.parse(readFileSync(`${root}assets/reference-parts/scorecard.json`, 'utf8'));
const t0 = performance.now();
const mod = await import(`./${which}.mjs`);
const loadMs = performance.now() - t0;
const rows = [];
for (const part of scorecard.parts) {
  const build = mod.builders[part.id];
  const row = { id: part.id, expected: { volume: part.expected.volumeMm3, area: part.expected.surfaceAreaMm2 }, tolerance: part.tolerance };
  if (!build) { rows.push({ ...row, status: 'missing' }); continue; }
  try {
    const start = performance.now(), shape = build(), m = mod.measure(shape);
    row.ms = Math.round((performance.now() - start) * 100) / 100;
    row.measured = m;
    row.volumeError = Math.abs(m.volume - part.expected.volumeMm3) / part.expected.volumeMm3;
    row.areaError = Math.abs(m.area - part.expected.surfaceAreaMm2) / part.expected.surfaceAreaMm2;
    row.bboxError = Math.max(...[0, 1, 2].flatMap(i => [Math.abs(m.min[i] - part.expected.bbox.min[i]), Math.abs(m.max[i] - part.expected.bbox.max[i])]));
    row.status = row.volumeError <= part.tolerance.volumeRelative && row.areaError <= part.tolerance.surfaceAreaRelative && row.bboxError <= part.tolerance.bboxAbsoluteMm ? 'pass' : 'fail';
  } catch (error) { row.status = 'error'; row.error = String(error?.message ?? error).slice(0, 300); }
  rows.push(row);
}
const stress = [];
for (const [id, build] of Object.entries(mod.stress ?? {})) {
  try { const start = performance.now(), m = mod.measure(build()); stress.push({ id, ms: Math.round(performance.now() - start), volume: m.volume }); }
  catch (error) { stress.push({ id, error: String(error?.message ?? error).slice(0, 200) }); }
}
const summary = { kernel: mod.kernel, node: process.version, loadMs: Math.round(loadMs), pass: rows.filter(r => r.status === 'pass').length, total: rows.length, totalBuildMs: Math.round(rows.reduce((s, r) => s + (r.ms ?? 0), 0)), stress };
const at = process.argv.indexOf('--json');
if (at >= 0) writeFileSync(process.argv[at + 1], JSON.stringify({ summary, rows }, null, 1) + '\n');
for (const r of rows) console.log(`${r.status.padEnd(7)} ${r.id.padEnd(24)} ${r.ms === undefined ? '' : `${String(r.ms).padStart(8)} ms`}  ${r.volumeError === undefined ? (r.error ?? '') : `vol ${r.volumeError.toExponential(1)} area ${r.areaError.toExponential(1)} bbox ${r.bboxError.toExponential(1)}`}`);
console.log(JSON.stringify(summary));
