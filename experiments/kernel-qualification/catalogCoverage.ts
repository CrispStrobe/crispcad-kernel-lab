// Native catalog coverage: build every catalog model on `smlib-native` with
// OpenCASCADE blocked from loading, and classify the ones that fail.
//
//   node --import tsx experiments/kernel-qualification/catalogCoverage.ts \
//     [--jobs 4] [--json out.json] [--filter substring]
//
// The parent shards the model list over child processes (each child loads the
// OCCT block hook); a child that crashes is restarted after the model it was on,
// which is then counted as a crash.
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
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
      }
    } catch (e) {
      r = { file, ok: false, ms: performance.now() - t0, codes: ['throw'], message: String((e as Error)?.message ?? e).slice(0, 300) };
    }
    process.stdout.write(`RESULT ${JSON.stringify(r)}\n`);
  }
}

function runShard(files: string[], results: Map<string, Result>): Promise<void> {
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
          current = undefined;
          if (results.size % 100 === 0) process.stderr.write(`${results.size} done\n`);
        }
      }
    });
    p.on('exit', code => {
      if (current && !results.has(current)) {
        results.set(current, { file: current, ok: false, ms: 0, crash: true, codes: ['crash'], message: `child exited ${code}` });
      }
      void runShard(files, results).then(done);
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
  const files = catalogModels(opt('--filter'));
  const results = new Map<string, Result>();
  const t0 = Date.now();
  const shards = Array.from({ length: jobs }, (_, j) => files.filter((_, i) => i % jobs === j));
  await Promise.all(shards.map(s => runShard(s, results)));
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
}

if (process.argv.includes('--child')) {
  const files = JSON.parse(readFileSync(0, 'utf8')) as string[];
  await child(files);
  process.exit(0);
} else {
  await parent();
}
