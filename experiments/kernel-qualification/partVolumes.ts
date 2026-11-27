// Per-part volumes of catalog models on both kernels, for checking the native lowering
// against OpenCASCADE part by part.
//
//   node --import tsx experiments/kernel-qualification/partVolumes.ts \
//     catalog/kits/nature/lily-pads.kcad.ts [more models] [--json out.json]
//
// Prints, per part, the OCCT volume, the native volume and their relative difference,
// and per model the largest relative volume and area differences and the largest box
// difference (mm). OCCT's own box of B-spline faces can be loose by up to ~6e-4 of the
// part, so box differences on curved parts are mostly OCCT's.
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

type Solid = { volume(): number; surfaceArea(): number; boundingBox(): { min: readonly number[]; max: readonly number[] } };
type Measures = { volume: number; area: number; min: readonly number[]; max: readonly number[] };
type Part = { name: string; shape: unknown };

async function partVolumes(file: string, kernel: 'occt' | 'smlib-native'): Promise<Map<string, Measures>> {
  const { buildModelFromFile } = await import('../../src/modeling/buildModel');
  const { isSceneBackend } = await import('../../src/kernel/backends/sceneBackend');
  const m = await buildModelFromFile({ file: resolve(file), kernel });
  const errs = m.diagnostics.filter(d => d.severity === 'error');
  if (errs.length) throw new Error(`${kernel}: ${errs[0]!.message}`);
  const out = new Map<string, Measures>();
  const measures = (s: Solid): Measures => { const b = s.boundingBox(); return { volume: s.volume(), area: s.surfaceArea(), min: b.min, max: b.max }; };
  const root = m.rootShape as unknown;
  if (isSceneBackend(root as never)) for (const p of (root as { parts: Part[] }).parts) out.set(p.name, measures(p.shape as Solid));
  else out.set('(model)', measures(root as Solid));
  return out;
}

const args = process.argv.slice(2);
const jsonAt = args.indexOf('--json');
const json = jsonAt >= 0 ? args.splice(jsonAt, 2)[1] : undefined;
const report: Record<string, { parts: Record<string, { occt: number; native: number; rel: number; relArea: number; dBox: number }>; maxRel: number; maxRelArea: number; maxDBox: number }> = {};
for (const file of args) {
  const occt = await partVolumes(file, 'occt');
  const native = await partVolumes(file, 'smlib-native');
  const parts: Record<string, { occt: number; native: number; rel: number; relArea: number; dBox: number }> = {};
  let maxRel = 0, maxRelArea = 0, maxDBox = 0;
  for (const [name, o] of occt) {
    const n = native.get(name);
    const vo = o.volume, vn = n?.volume ?? NaN;
    const rel = (vn - vo) / Math.abs(vo);
    const relArea = ((n?.area ?? NaN) - o.area) / Math.abs(o.area);
    let dBox = n ? 0 : NaN;
    if (n) for (let i = 0; i < 3; i++) dBox = Math.max(dBox, Math.abs(n.min[i]! - o.min[i]!), Math.abs(n.max[i]! - o.max[i]!));
    parts[name] = { occt: vo, native: vn, rel, relArea, dBox };
    if (!(Math.abs(rel) <= Math.abs(maxRel))) maxRel = rel;
    if (!(Math.abs(relArea) <= Math.abs(maxRelArea))) maxRelArea = relArea;
    if (!(dBox <= maxDBox)) maxDBox = dBox;
  }
  report[file] = { parts, maxRel, maxRelArea, maxDBox };
  console.log(`${file}  max rel ${maxRel.toExponential(2)}  area ${maxRelArea.toExponential(2)}  box ${maxDBox.toExponential(2)} mm`);
  for (const [name, r] of Object.entries(parts)) if (Math.abs(r.rel) > 1e-9) console.log(`  ${name.padEnd(28)} occt ${r.occt.toPrecision(12)}  native ${r.native.toPrecision(12)}  ${r.rel.toExponential(2)}`);
}
if (json) writeFileSync(json, JSON.stringify(report, null, 1) + '\n');
