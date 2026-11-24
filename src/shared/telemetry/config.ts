// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Andrii Shylenko and kernelCAD contributors
import { homedir } from 'node:os';
import { isSandboxEnabled } from '../sandbox/config';
import { join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

export interface TelemetryConfig {
  enabled: boolean;
  installId: string;
  notified: boolean;
  /** Set only by an explicit `telemetry enable`; upstream configs default-on do not count. */
  optedIn?: boolean;
}

/** Config home honours XDG; `KERNELCAD_CONFIG_HOME` overrides (test seam). */
function configHome(): string {
  return (
    process.env.KERNELCAD_CONFIG_HOME ??
    process.env.XDG_CONFIG_HOME ??
    join(homedir(), '.config')
  );
}

export function configPath(): string {
  return join(configHome(), 'kernelcad', 'telemetry.json');
}

export function loadConfig(): TelemetryConfig | null {
  try {
    if (!existsSync(configPath())) return null;
    const raw = JSON.parse(readFileSync(configPath(), 'utf8'));
    if (typeof raw?.installId !== 'string') return null;
    return { enabled: raw.enabled === true, installId: raw.installId, notified: raw.notified === true, optedIn: raw.optedIn === true };
  } catch {
    return null;
  }
}

export function saveConfig(cfg: TelemetryConfig): void {
  try {
    mkdirSync(join(configHome(), 'kernelcad'), { recursive: true });
    writeFileSync(configPath(), JSON.stringify(cfg, null, 2), 'utf8');
  } catch {
    // best-effort; never throw from telemetry
  }
}

export function ensureInstallId(): string {
  const existing = loadConfig();
  if (existing) return existing.installId;
  const cfg: TelemetryConfig = { enabled: false, installId: randomUUID(), notified: false };
  saveConfig(cfg);
  return cfg.installId;
}

function envTrue(v: string | undefined): boolean {
  return v === '1' || v === 'true';
}

/** CrispCAD: default OFF. Telemetry is opt-in (`crispcad telemetry enable`) and also needs
 *  CRISPCAD_TELEMETRY_URL; any single off-switch forces OFF. */
export function isTelemetryEnabled(): boolean {
  // Sandbox mode forces telemetry off regardless of config (docs/sandbox.md).
  if (isSandboxEnabled()) return false;
  if (process.env.KERNELCAD_TELEMETRY === '0') return false;
  if (envTrue(process.env.KERNELCAD_TELEMETRY_DISABLED)) return false;
  if (envTrue(process.env.DO_NOT_TRACK)) return false;
  if (envTrue(process.env.CI)) return false;
  const cfg = loadConfig();
  return cfg?.enabled === true && cfg.optedIn === true;
}

export function isDebug(): boolean {
  return process.env.KERNELCAD_TELEMETRY_DEBUG === '1';
}
