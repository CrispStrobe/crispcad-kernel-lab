// SPDX-License-Identifier: MIT
// Copyright (c) 2026 CrispCAD contributors
//
// Capture-time lowering on the native SMLib kernel, for queries that need only
// geometry (bounding box). Topology queries still need OpenCASCADE.
import type { ShapeBackend } from '../../kernel/backends/backend';
import type { FeatureRecord } from '../../shared/intent/featureRecord';
import type { CaptureSession } from './captureSession';

/** Throw when `kernel` cannot answer OCCT topology queries (faces, edges, selectors). */
export function assertTopologyKernel(kernel: string | undefined, id: string): void {
  if (kernel !== 'smlib-native') return;
  throw new Error(`Shape '${id}': this capture-time query needs OpenCASCADE topology (faces, edges, selectors), which the native SMLib kernel does not provide yet. Use geometry-level queries such as boundingBox(), or build with kernel 'occt'.`);
}

export async function lowerOnNativeKernel(session: CaptureSession, id: string): Promise<ShapeBackend> {
  const { RecomputeEngine } = await import('../compute/recomputeEngine');
  const { createLowerer } = await import('../backends/kernelRegistry');
  const engine = new RecomputeEngine(createLowerer('smlib-native', session));
  const r = await engine.run(session.getRecords() as readonly FeatureRecord[], {
    paramTable: session.paramTable,
    warningPhase: 'build',
    gatedFeatureNames: session.gatedFeatureNames,
  });
  for (const [shapeId, shape] of r.shapes) session.cachedShapes.set(shapeId, shape);
  const shape = r.shapes.get(id);
  if (!shape) throw new Error(`Shape '${id}' could not be built on the native SMLib kernel: ${r.diagnostics.find(d => d.severity === 'error')?.message ?? 'no shape'}`);
  return shape;
}
