// Per-part volumes of catalog models on both kernels, for checking the native lowering
// against OpenCASCADE part by part.
//
//   node --import tsx experiments/kernel-qualification/partVolumes.ts \
//     catalog/kits/nature/lily-pads.kcad.ts [more models] [--json out.json]
//
// Prints, per part, the OCCT volume, the native volume and their relative difference,
// and the largest relative difference per model.
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

type Solid = { volume(): number };
type Part = { name: string; shape: unknown };

async function partVolumes(file: string, kernel: 'occt' | 'smlib-native'): Promise<Map<string, number>> {
  const { buildModelFromFile } = await import('../../src/modeling/buildModel');
  const { isSceneBackend } = await import('../../src/kernel/backends/sceneBackend');
  const m = await buildModelFromFile({ file: resolve(file), kernel });
  const errs = m.diagnostics.filter(d => d.severity === 'error');
  if (errs.length) throw new Error(`${kernel}: ${errs[0]!.message}`);
  const out = new Map<string, number>();
  const root = m.rootShape as unknown;
  if (isSceneBackend(root as never)) for (const p of (root as { parts: Part[] }).parts) out.set(p.name, (p.shape as Solid).volume());
  else out.set('(model)', (root as Solid).volume());
  return out;
}

const args = process.argv.slice(2);
const jsonAt = args.indexOf('--json');
const json = jsonAt >= 0 ? args.splice(jsonAt, 2)[1] : undefined;
const report: Record<string, { parts: Record<string, { occt: number; native: number; rel: number }>; maxRel: number }> = {};
for (const file of args) {
  const occt = await partVolumes(file, 'occt');
  const native = await partVolumes(file, 'smlib-native');
  const parts: Record<string, { occt: number; native: number; rel: number }> = {};
  let maxRel = 0;
  for (const [name, vo] of occt) {
    const vn = native.get(name) ?? NaN;
    const rel = (vn - vo) / Math.abs(vo);
    parts[name] = { occt: vo, native: vn, rel };
    if (!(Math.abs(rel) <= Math.abs(maxRel))) maxRel = rel;
  }
  report[file] = { parts, maxRel };
  console.log(`${file}  max rel ${maxRel.toExponential(2)}`);
  for (const [name, r] of Object.entries(parts)) if (Math.abs(r.rel) > 1e-9) console.log(`  ${name.padEnd(28)} occt ${r.occt.toPrecision(12)}  native ${r.native.toPrecision(12)}  ${r.rel.toExponential(2)}`);
}
if (json) writeFileSync(json, JSON.stringify(report, null, 1) + '\n');
