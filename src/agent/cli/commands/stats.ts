// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Andrii Shylenko and kernelCAD contributors
// src/agent/cli/commands/stats.ts
//
// `kernelcad stats` — maintainer view of anonymous usage telemetry.
// Requires KERNELCAD_ADMIN_TOKEN (and optionally KERNELCAD_API_BASE).
import { Command } from 'commander';

// CrispCAD has no hosted telemetry service; pass --base or KERNELCAD_API_BASE_URL.
const DEFAULT_BASE = '';

export async function fetchStats(days: number): Promise<Record<string, unknown>> {
  const token = process.env.KERNELCAD_ADMIN_TOKEN;
  if (!token) throw new Error('KERNELCAD_ADMIN_TOKEN is not set');
  const base = process.env.KERNELCAD_API_BASE ?? DEFAULT_BASE;
  if (!base) throw new Error('No telemetry service configured. Set KERNELCAD_API_BASE.');
  const res = await fetch(`${base}/api/v1/admin/telemetry?days=${days}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`stats request failed: ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

function printTable(title: string, rows: unknown): void {
  console.log(`\n${title}`);
  if (!Array.isArray(rows) || rows.length === 0) { console.log('  (no data)'); return; }
  console.table(rows);
}

export function statsCommand(): Command {
  return new Command('stats')
    .description('Show anonymous usage telemetry (maintainer; needs KERNELCAD_ADMIN_TOKEN)')
    .option('-d, --days <n>', 'lookback window in days', '30')
    .action(async (opts: { days: string }) => {
      const days = Number(opts.days) || 30;
      let data: Record<string, unknown>;
      try {
        data = await fetchStats(days);
      } catch (err) {
        console.error(String(err instanceof Error ? err.message : err));
        process.exitCode = 1;
        return;
      }
      console.log(`kernelCAD usage — last ${days} days`);
      printTable('Reach (distinct installs by mode)', data.reach);
      printTable('Tool distribution', data.toolDistribution);
      printTable('Tool outcomes', data.toolOutcomes);
      printTable('Top failure diagnostics', data.topDiagnostics);
      printTable('Build outcomes', data.buildOutcomes);
      printTable('Build eval-ok rate', data.buildEvalRate);
      printTable('Complexity (feature-count histogram)', data.complexity);
    });
}
