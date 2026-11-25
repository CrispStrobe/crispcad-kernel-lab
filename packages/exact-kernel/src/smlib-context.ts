// SPDX-License-Identifier: MIT
// Copyright (c) 2026 CrispCAD contributors
//
// Handles and error mapping shared by the SMLib adapter modules.
import { ExactKernelError, type ExactProfile, type ExactSolid, type FaceSelector, type Vec3 } from './exact-kernel.ts';
import { unitVector, invalid } from './validate.ts';

export type Smlib = typeof import('@classcad/smlibwasm');
export type Part = InstanceType<Smlib['Part']>;
export type Sketch = InstanceType<Smlib['Sketch']>;
export type Face = InstanceType<Smlib['Face']>;

// Plain objects (not class instances) so smlibwasm's `scope` sees the kernel object inside a
// returned handle and keeps it.
interface SolidHandle { part: Part; dispose(): void }
interface ProfileHandle { sketch: Sketch; dispose(): void }
export const solidOf = (part: Part): ExactSolid => ({ part, dispose: () => part.dispose() }) as SolidHandle as unknown as ExactSolid;
export const profileOf = (sketch: Sketch): ExactProfile => ({ sketch, dispose: () => sketch.dispose() }) as ProfileHandle as unknown as ExactProfile;
export const partOf = (s: ExactSolid): Part => (s as unknown as Partial<SolidHandle> | undefined)?.part ?? invalid('Not a solid of this kernel.');
export const sketchOf = (p: ExactProfile): Sketch => (p as unknown as Partial<ProfileHandle> | undefined)?.sketch ?? invalid('Not a profile of this kernel.');
export const vec = (v: Vec3): [number, number, number] => [v[0], v[1], v[2]];

/** Run a kernel operation; kernel exceptions become ExactKernelError('kernel-failure'). */
export function call<T>(operation: string, fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof ExactKernelError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new ExactKernelError('kernel-failure', `SMLib ${operation} failed: ${message}`, { cause: error });
  }
}

export interface Ctx {
  sm: Smlib;
  /** A result that is not a solid is a failure, never a silent pass. */
  solid(operation: string, part: unknown): ExactSolid;
  face(part: Part, selector: Vec3 | FaceSelector): Face;
}

export function createContext(sm: Smlib): Ctx {
  const solid = (operation: string, part: unknown): ExactSolid => {
    if (!(part instanceof sm.Part)) throw new ExactKernelError('kernel-failure', `SMLib ${operation} did not produce a solid (got ${(part as object | null)?.constructor?.name ?? typeof part}).`);
    return solidOf(part);
  };
  const face = (part: Part, selector: Vec3 | FaceSelector): Face => {
    const { faceNormal, outermost } = Array.isArray(selector) ? { faceNormal: selector as Vec3, outermost: false } : selector as FaceSelector;
    const n = unitVector('Face normal', faceNormal);
    const along = (f: Face) => { const c = f.center(); return c.x * n[0] + c.y * n[1] + c.z * n[2]; };
    const matches = [...part.faces()].filter(f => {
      if (!f.isPlanar) return false;
      const m = f.normalAt();
      return m.x * n[0] + m.y * n[1] + m.z * n[2] > 1 - 1e-9;
    });
    if (outermost && matches.length) return matches.sort((a, b) => along(b) - along(a))[0];
    if (matches.length !== 1) invalid(`Expected exactly one planar face with outward normal [${n.join(', ')}], found ${matches.length}.`);
    return matches[0];
  };
  return { sm, solid, face };
}
