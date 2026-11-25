// SPDX-License-Identifier: MIT
// Copyright (c) 2026 CrispCAD contributors
//
// Input checks shared by the SMLib adapter: every malformed request is an
// ExactKernelError('invalid-input') before the kernel sees it.
import { ExactKernelError, type Vec3 } from './exact-kernel.ts';

export const invalid = (message: string): never => { throw new ExactKernelError('invalid-input', message); };

export function finite(what: string, ...values: number[]): void {
  for (const v of values) if (typeof v !== 'number' || !Number.isFinite(v)) invalid(`${what} must be finite numbers (got ${String(v)}).`);
}

export function positive(what: string, ...values: number[]): void {
  finite(what, ...values);
  for (const v of values) if (!(v > 0)) invalid(`${what} must be positive (got ${v}).`);
}

export function unitVector(what: string, n: Vec3): [number, number, number] {
  if (!Array.isArray(n) || n.length !== 3) return invalid(`${what} must be a 3-vector.`);
  finite(what, ...n);
  const len = Math.hypot(n[0], n[1], n[2]);
  if (!(len > 1e-12)) invalid(`${what} must be a non-zero vector.`);
  return [n[0] / len, n[1] / len, n[2] / len];
}

/** Symmetric 3x3 eigen-decomposition (cyclic Jacobi): values and unit column vectors.
 * From the lab's SmlibBackend (src/kernel/backends/smlib/smlibBackend.ts). */
export function symmetricEigen(a: readonly (readonly number[])[]): { values: [number, number, number]; vectors: [Vec3, Vec3, Vec3] } {
  const m = a.map(row => [...row]);
  const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 64; sweep++) {
    const off = Math.abs(m[0][1]) + Math.abs(m[0][2]) + Math.abs(m[1][2]);
    if (off < 1e-30) break;
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]] as const) {
      if (Math.abs(m[p][q]) < 1e-300) continue;
      const theta = (m[q][q] - m[p][p]) / (2 * m[p][q]);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < 3; k++) { const mkp = m[k][p], mkq = m[k][q]; m[k][p] = c * mkp - s * mkq; m[k][q] = s * mkp + c * mkq; }
      for (let k = 0; k < 3; k++) { const mpk = m[p][k], mqk = m[q][k]; m[p][k] = c * mpk - s * mqk; m[q][k] = s * mpk + c * mqk; }
      for (let k = 0; k < 3; k++) { const vkp = v[k][p], vkq = v[k][q]; v[k][p] = c * vkp - s * vkq; v[k][q] = s * vkp + c * vkq; }
    }
  }
  return { values: [m[0][0], m[1][1], m[2][2]], vectors: [0, 1, 2].map(i => [v[0][i], v[1][i], v[2][i]] as Vec3) as [Vec3, Vec3, Vec3] };
}

/** Area-weighted per-vertex normals of a triangle mesh. */
export function vertexNormals(positions: Float64Array, indices: Uint32Array): Float64Array {
  const normals = new Float64Array(positions.length);
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] * 3, b = indices[i + 1] * 3, c = indices[i + 2] * 3;
    const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1], vz = positions[c + 2] - positions[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const idx of [a, b, c]) { normals[idx] += nx; normals[idx + 1] += ny; normals[idx + 2] += nz; }
  }
  for (let i = 0; i < normals.length; i += 3) {
    const len = Math.hypot(normals[i], normals[i + 1], normals[i + 2]);
    if (len > 0) { normals[i] /= len; normals[i + 1] /= len; normals[i + 2] /= len; }
  }
  return normals;
}
