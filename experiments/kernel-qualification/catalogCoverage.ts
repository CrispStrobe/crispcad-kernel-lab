// Native catalog coverage: build every catalog model on `smlib-native` with
// OpenCASCADE blocked from loading, and classify the ones that fail.
//
//   node --import tsx experiments/kernel-qualification/catalogCoverage.ts \
//     [--jobs 4] [--json out.json] [--filter substring] [--rerun previous.json]
//     [--log results.jsonl] [--volumes native-volumes.json]
//
// --rerun builds only the models listed as failures in an earlier --json output.
// --log appends one JSON line per model as it finishes and, when the file exists, skips the
// models it already holds: an interrupted run resumes where it stopped.
// --volumes writes each model's summed part volume (and area, bbox) in the input format of
// CrispCAD's catalog cross-check `--native` column (experiments/catalog-crosscheck/README.md):
//   { kernel, labCommit, models: { "<kit>/<model>.kcad.ts": { status: "ok", volumeMm3, ... }
//                                  | { status: "error", error } } }
//
// The parent shards the model list over child processes (each child loads the
// OCCT block hook); a child that crashes is restarted after the model it was on,
// which is then counted as a crash.
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(HERE, '../..');
const HOOK = join(HERE, 'blockOcct.mjs');
const SELF = fileURLToPath(import.meta.url);

interface Result {
  file: string;
  ok: boolean;
  ms: number;
  codes?: string[];
  message?: string;
  crash?: boolean;
  /** Sum over the model's parts (an assembly's parts, else the returned solid), mm^3 / mm^2. */
  volumeMm3?: number;
  areaMm2?: number;
  /** World-frame box around all parts (exact, SmlibBackend.boundingBox). */
  bbox?: { min: number[]; max: number[] };
  parts?: number;
}

type Measured = Pick<Result, 'volumeMm3' | 'areaMm2' | 'bbox' | 'parts'>;

/** Volume, area and box of a built model: assembly parts placed by their world transforms. */
async function measure(root: unknown): Promise<Measured | undefined> {
  const { isSceneBackend } = await import('../../src/kernel/backends/sceneBackend');
  type Solid = { volume(): number; surfaceArea(): number; boundingBox(): { min: readonly number[]; max: readonly number[] }; rotate(a: readonly number[], d: number): Solid; translate(x: number, y: number, z: number): Solid };
  if (!root) return undefined;
  const solids: Solid[] = [];
  if (isSceneBackend(root as never)) {
    for (const part of (root as { parts: { shape: unknown; worldTransform: { decomposeToTranslateAndRotate(): { translate: number[]; rotateAxis: number[]; rotateDeg: number } } }[] }).parts) {
      let shape = part.shape as Solid;
      const { translate, rotateAxis, rotateDeg } = part.worldTransform.decomposeToTranslateAndRotate();
      if (rotateDeg !== 0) shape = shape.rotate(rotateAxis, rotateDeg);
      if (translate.some(v => v !== 0)) shape = shape.translate(translate[0], translate[1], translate[2]);
      solids.push(shape);
    }
  } else solids.push(root as Solid);
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  let volumeMm3 = 0, areaMm2 = 0;
  for (const s of solids) {
    volumeMm3 += s.volume(); areaMm2 += s.surfaceArea();
    const b = s.boundingBox();
    for (let i = 0; i < 3; i++) { min[i] = Math.min(min[i], b.min[i]); max[i] = Math.max(max[i], b.max[i]); }
  }
  return { volumeMm3, areaMm2, bbox: { min, max }, parts: solids.length };
}

function catalogModels(filter?: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (e.endsWith('.kcad.ts')) out.push(relative(ROOT, p));
    }
  };
  walk(join(ROOT, 'catalog'));
  out.sort();
  return filter ? out.filter(f => f.includes(filter)) : out;
}

async function child(files: string[]): Promise<void> {
  const { buildModelFromFile } = await import('../../src/modeling/buildModel');
  for (const file of files) {
    process.stdout.write(`START ${file}\n`);
    const t0 = performance.now();
    let r: Result;
    try {
      const m = await buildModelFromFile({ file: join(ROOT, file), kernel: 'smlib-native' });
      const errs = m.diagnostics.filter(d => d.severity === 'error');
      r = { file, ok: errs.length === 0, ms: performance.now() - t0 };
      if (errs.length) {
        r.codes = [...new Set(errs.map(d => d.code))];
        r.message = String(errs[0]!.message).slice(0, 300);
      } else {
        try { Object.assign(r, await measure(m.rootShape)); } catch (e) { r.message = `measure failed: ${String((e as Error)?.message ?? e).slice(0, 200)}`; }
      }
    } catch (e) {
      r = { file, ok: false, ms: performance.now() - t0, codes: ['throw'], message: String((e as Error)?.message ?? e).slice(0, 300) };
    }
    process.stdout.write(`RESULT ${JSON.stringify(r)}\n`);
  }
}

function runShard(files: string[], results: Map<string, Result>, log?: string): Promise<void> {
  return new Promise(done => {
    const pending = files.filter(f => !results.has(f));
    if (!pending.length) return done();
    const p = spawn(process.execPath, ['--import', 'tsx', '--import', HOOK, SELF, '--child'], {
      cwd: ROOT,
      stdio: ['pipe', 'pipe', 'ignore'],
      env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=4096' },
    });
    p.stdin.end(JSON.stringify(pending));
    let current: string | undefined;
    let buf = '';
    p.stdout.on('data', (d: Buffer) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.startsWith('START ')) current = line.slice(6);
        else if (line.startsWith('RESULT ')) {
          const r = JSON.parse(line.slice(7)) as Result;
          results.set(r.file, r);
          if (log) appendFileSync(log, JSON.stringify(r) + '\n');
          current = undefined;
          if (results.size % 100 === 0) process.stderr.write(`${results.size} done\n`);
        }
      }
    });
    p.on('exit', code => {
      if (current && !results.has(current)) {
        const r: Result = { file: current, ok: false, ms: 0, crash: true, codes: ['crash'], message: `child exited ${code}` };
        results.set(current, r);
        if (log) appendFileSync(log, JSON.stringify(r) + '\n');
      }
      void runShard(files, results, log).then(done);
    });
  });
}

function category(r: Result): string {
  const m = r.message ?? '';
  if (r.crash) return 'crash';
  if (/mates/i.test(m)) return 'mates';
  if (/OpenCASCADE blocked/.test(m)) return 'needs OCCT (blocked import)';
  if (r.codes?.includes('recompute.kernel.unsupported-feature')) return `unsupported: ${m.replace(/\d+(\.\d+)?/g, 'N').slice(0, 90)}`;
  return `${r.codes?.join(',')}: ${m.replace(/\d+(\.\d+)?/g, 'N').slice(0, 90)}`;
}

async function parent(): Promise<void> {
  const args = process.argv.slice(2);
  const opt = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  const jobs = Number(opt('--jobs') ?? 4);
  const rerun = opt('--rerun');
  const previous = rerun ? new Set((JSON.parse(readFileSync(rerun, 'utf8')) as { failures: Result[] }).failures.map(f => f.file)) : undefined;
  const files = catalogModels(opt('--filter')).filter(f => !previous || previous.has(f));
  const results = new Map<string, Result>();
  const log = opt('--log');
  if (log && existsSync(log)) {
    for (const line of readFileSync(log, 'utf8').split('\n')) if (line.trim()) { const r = JSON.parse(line) as Result; if (files.includes(r.file)) results.set(r.file, r); }
    process.stderr.write(`resuming: ${results.size} models already in ${log}\n`);
  }
  const t0 = Date.now();
  const shards = Array.from({ length: jobs }, (_, j) => files.filter((_, i) => i % jobs === j));
  await Promise.all(shards.map(s => runShard(s, results, log)));
  const all = files.map(f => results.get(f)!);
  const failed = all.filter(r => !r.ok);
  const cats = new Map<string, string[]>();
  for (const r of failed) cats.set(category(r), [...(cats.get(category(r)) ?? []), r.file]);
  const summary = {
    total: all.length,
    ok: all.length - failed.length,
    failed: failed.length,
    wallSeconds: Math.round((Date.now() - t0) / 1000),
    categories: Object.fromEntries([...cats].sort((a, b) => b[1].length - a[1].length).map(([k, v]) => [k, v.length])),
  };
  console.log(JSON.stringify(summary, null, 2));
  const out = opt('--json');
  if (out) writeFileSync(out, JSON.stringify({ summary, failures: failed }, null, 2) + '\n');
  const volumes = opt('--volumes');
  if (volumes) {
    const labCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
    const models: Record<string, unknown> = {};
    for (const r of all) {
      const key = relative(join(ROOT, 'catalog/kits'), join(ROOT, r.file));
      models[key] = r.ok && r.volumeMm3 !== undefined
        ? { status: 'ok', volumeMm3: r.volumeMm3, areaMm2: r.areaMm2, bbox: r.bbox, parts: r.parts }
        : { status: 'error', error: r.ok ? (r.message ?? 'no solid to measure') : `${r.codes?.join(',') ?? 'error'}: ${r.message ?? ''}` };
    }
    writeFileSync(volumes, JSON.stringify({ kernel: 'smlib-native', labCommit, measuredAt: new Date().toISOString().slice(0, 10), models }) + '\n');
  }
}

if (process.argv.includes('--child')) {
  const files = JSON.parse(readFileSync(0, 'utf8')) as string[];
  await child(files);
  process.exit(0);
} else {
  await parent();
}
