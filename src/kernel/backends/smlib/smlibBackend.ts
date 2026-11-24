// SPDX-License-Identifier: MIT
// Copyright (c) 2026 CrispCAD contributors
//
// Native exact-geometry backend on SMLib (@classcad/smlibwasm; SMLib is
// NVIDIA's Apache-2.0 B-rep kernel). No OpenCASCADE is loaded on this path.
// The module is passed in rather than imported, because smlibwasm initialises
// its WASM at import time (see modeling/backends/smlib/runtime.ts).
import type { ShapeBackend } from '../backend';
import type { BackendTarget } from '../../../shared/types/backendTarget';
import type { Vec3 } from '../../../shared/intent/types';
import type { RuntimeMesh } from '../runtimeMesh';
import type { GyrationAxis, MassProperties } from '../../properties/massProperties';

type Smlib = typeof import('@classcad/smlibwasm');
type Part = InstanceType<Smlib['Part']>;

/** Mesh deflection (mm) and angle (deg) for display meshes and STL. */
export const SMLIB_MESH_TOLERANCE = 0.01;
export const SMLIB_MESH_ANGLE = 10;

/** Symmetric 3x3 eigen-decomposition (cyclic Jacobi); returns values and column vectors. */
export function symmetricEigen(a: number[][]): { values: [number, number, number]; vectors: [Vec3, Vec3, Vec3] } {
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

export class SmlibBackend implements ShapeBackend {
  readonly target: BackendTarget = 'export-smlib';

  readonly sm: Smlib;
  readonly part: Part;

  constructor(sm: Smlib, part: Part) {
    this.sm = sm;
    this.part = part;
  }

  private wrap(part: Part): SmlibBackend { return new SmlibBackend(this.sm, part); }
  private static native(other: ShapeBackend): Part {
    if (!(other instanceof SmlibBackend)) {
      throw new Error(`The native SMLib kernel cannot combine with ${other.target} geometry; build every operand with kernel 'smlib-native'.`);
    }
    return other.part;
  }

  translate(x: number, y: number, z: number): ShapeBackend { return this.wrap(this.part.translate([x, y, z])); }

  rotate(axis: Vec3, degrees: number, pivot: Vec3 = [0, 0, 0]): ShapeBackend {
    return this.wrap(this.part.rotate(new this.sm.Axis(pivot, axis), degrees));
  }

  scale(s: number | Vec3): ShapeBackend { return this.wrap(this.part.scale(s, [0, 0, 0])); }

  /** Reflect through the plane with this normal through `origin` (no union). */
  reflect(normal: Vec3, origin: Vec3 = [0, 0, 0]): SmlibBackend {
    return this.wrap(this.part.mirror(new this.sm.Plane(origin, undefined, normal)));
  }

  union(other: ShapeBackend): ShapeBackend { return this.wrap(this.part.fuse(SmlibBackend.native(other))); }
  subtract(other: ShapeBackend): ShapeBackend { return this.wrap(this.part.cut(SmlibBackend.native(other))); }
  intersect(other: ShapeBackend): ShapeBackend { return this.wrap(this.part.intersect(SmlibBackend.native(other))); }

  splitByPlane(normal: Vec3, offset: number): [ShapeBackend, ShapeBackend] {
    // Intersect with two half-space boxes larger than the part.
    const box = this.part.bbox(), size = 4 * (box.diagonal + 1);
    const len = Math.hypot(normal[0], normal[1], normal[2]), n = normal.map(c => c / len) as Vec3;
    const centre = n.map(c => c * offset) as Vec3;
    const halfSpace = (sign: number) => {
      const slab = this.sm.Box(size, size, size).translate([0, 0, sign * size / 2]);
      const z: Vec3 = [0, 0, 1], axis = [z[1] * n[2] - z[2] * n[1], z[2] * n[0] - z[0] * n[2], z[0] * n[1] - z[1] * n[0]] as Vec3;
      const sin = Math.hypot(...axis), angle = Math.atan2(sin, n[2]) * 180 / Math.PI;
      const oriented = sin < 1e-12 ? (n[2] > 0 ? slab : slab.rotate(this.sm.Axis.X, 180)) : slab.rotate(new this.sm.Axis([0, 0, 0], axis), angle);
      return oriented.translate(centre);
    };
    return [this.wrap(this.part.intersect(halfSpace(1))), this.wrap(this.part.intersect(halfSpace(-1)))];
  }

  boundingBox(): { min: Vec3; max: Vec3 } {
    const b = this.part.bbox();
    return { min: [b.min.x, b.min.y, b.min.z], max: [b.max.x, b.max.y, b.max.z] };
  }

  volume(): number { return this.part.volume; }
  surfaceArea(): number { return this.part.area; }

  massProperties(density = 1000, gyrationAxis?: GyrationAxis): MassProperties {
    const p = this.part.massProperties(1);
    const k = density * 1e-15; // (kg/m^3) * mm^5 -> kg*m^2
    const I = p.inertia.map(row => row.map(v => v * k));
    const sym = (i: number, j: number) => (I[i][j] + I[j][i]) / 2;
    const matrix: [Vec3, Vec3, Vec3] = [[I[0][0], sym(0, 1), sym(0, 2)], [sym(0, 1), I[1][1], sym(1, 2)], [sym(0, 2), sym(1, 2), I[2][2]]];
    const { values, vectors } = symmetricEigen(matrix);
    const result: MassProperties = {
      mass: p.volume * 1e-9 * density,
      com: [p.center.x, p.center.y, p.center.z],
      inertia6: [matrix[0][0], matrix[0][1], matrix[0][2], matrix[1][1], matrix[1][2], matrix[2][2]],
      inertiaMatrix: matrix,
      principalMoments: values,
      principalAxes: vectors,
      hasSymmetryAxis: Math.abs(values[0] - values[1]) < 1e-9 * Math.max(...values.map(Math.abs), 1e-300) || Math.abs(values[1] - values[2]) < 1e-9 * Math.max(...values.map(Math.abs), 1e-300),
      hasSymmetryPoint: Math.abs(values[0] - values[1]) < 1e-9 * Math.max(...values.map(Math.abs), 1e-300) && Math.abs(values[1] - values[2]) < 1e-9 * Math.max(...values.map(Math.abs), 1e-300),
    };
    if (gyrationAxis) {
      // Parallel-axis theorem about the caller's axis, from the centroidal tensor (mm units).
      const len = Math.hypot(...gyrationAxis.direction), d = gyrationAxis.direction.map(c => c / len);
      const Icm = p.inertia.map(row => [...row]);
      const about = d.reduce((s, di, i) => s + di * d.reduce((t, dj, j) => t + Icm[i][j] * dj, 0), 0);
      const r = result.com.map((c, i) => c - gyrationAxis.origin[i]);
      const along = r.reduce((s, ri, i) => s + ri * d[i], 0), dist2 = r.reduce((s, ri) => s + ri * ri, 0) - along * along;
      result.radiusOfGyration = Math.sqrt((about + p.volume * dist2) / p.volume);
    }
    return result;
  }

  isEmpty(): boolean { return !(this.part.volume > 0); }

  solidComponents(): readonly ShapeBackend[] { return [...this.part.solids()].map(solid => this.wrap(solid)); }

  getMesh(): RuntimeMesh {
    const mesh = this.part.mesh(SMLIB_MESH_TOLERANCE, SMLIB_MESH_ANGLE);
    const positions = Float32Array.from(mesh.vertices);
    const normals = mesh.normals ? Float32Array.from(mesh.normals) : new Float32Array(positions.length);
    if (!mesh.normals) {
      const t = mesh.triangles;
      for (let i = 0; i < t.length; i += 3) {
        const [a, b, c] = [t[i] * 3, t[i + 1] * 3, t[i + 2] * 3];
        const u = [0, 1, 2].map(k => positions[b + k] - positions[a + k]), v = [0, 1, 2].map(k => positions[c + k] - positions[a + k]);
        const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
        for (const idx of [a, b, c]) for (let k = 0; k < 3; k++) normals[idx + k] += n[k];
      }
    }
    return { positions, normals, indices: Uint32Array.from(mesh.triangles) };
  }

  exportSTL(): Uint8Array { return this.sm.toStl(this.part, { tolerance: SMLIB_MESH_TOLERANCE, angle: SMLIB_MESH_ANGLE }); }
  exportSTEP(): Uint8Array { return new TextEncoder().encode(this.sm.toStep(this.part)); }
  dispose(): void { this.part.dispose(); }
}
