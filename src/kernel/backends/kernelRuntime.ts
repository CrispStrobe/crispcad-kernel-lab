// SPDX-License-Identifier: MIT
// Copyright (c) 2026 CrispCAD contributors
//
// Initialise the runtime of the kernel a script will build on. OpenCASCADE is
// loaded only when the selected kernel needs it, so `CRISPCAD_KERNEL=smlib-native`
// runs never load replicad-opencascadejs (LGPL-2.1 with exception).
import { kernelFromEnv, type KernelId } from '../../shared/types/backendTarget';

/** Kernels that build without OpenCASCADE. */
const OCCT_FREE_KERNELS: ReadonlySet<string> = new Set<KernelId>(['smlib-native']);

/** True when `kernel` (default: CRISPCAD_KERNEL) needs the OpenCASCADE runtime. */
export function kernelNeedsOcct(kernel: string | undefined = kernelFromEnv()): boolean {
  return kernel === undefined || !OCCT_FREE_KERNELS.has(kernel);
}

/** Initialise OpenCASCADE unless the selected kernel builds without it. Memoized. */
export async function initKernelRuntime(kernel?: string): Promise<void> {
  if (!kernelNeedsOcct(kernel ?? kernelFromEnv())) return;
  const { initOcct } = await import('./occt/backendInit');
  await initOcct();
}
