// SPDX-License-Identifier: MIT
// Copyright (c) 2026 CrispCAD contributors
//
// ExactKernel on SMLib through @classcad/smlibwasm 0.6.2 (MIT wrapper by AWV Informatik AG;
// SMLib / USD BRep core Apache-2.0 by NVIDIA). The package's default font module is replaced by
// an empty module when this package is bundled, so `Text()` has no default font.
//
// Moved from CrispCAD's experiments/exact-kernel/src/smlib-kernel.ts (BSD-3-Clause there, same
// author) and relicensed MIT. Its API usage was learned from this repository's native SMLib
// backend (src/kernel/backends/smlib/smlibBackend.ts, src/modeling/backends/smlib/
// nativeLowerer.ts, experiments/kernel-qualification/smlibwasm.mjs; Copyright (c) 2026 CrispCAD
// contributors, Andrii Shylenko and kernelCAD contributors, MIT), from which mass properties,
// path profiles, loft, sweep and STL were added.
//
// smlibwasm instantiates its WebAssembly at import time (top-level await), so it is imported
// lazily in createSmlibKernel and never at module load.
import {
  ExactKernelError,
  type BoundingBox, type ExactKernel, type FaceSelector, type KernelMemory, type MassProperties, type TriangleMesh, type Vec3,
} from './exact-kernel.ts';
import { call, createContext, partOf, sketchOf, solidOf, vec, type Ctx, type Part } from './smlib-context.ts';
import { createProfileOps } from './smlib-profile.ts';
import { finite, invalid, positive, symmetricEigen, unitVector, vertexNormals } from './validate.ts';

/** Default display tessellation: 0.01 mm chord, 10 degrees. */
export const SMLIB_MESH_TOLERANCE = 0.01;
export const SMLIB_MESH_ANGLE = 10;
/** SPDX licence of everything this package runs: the bundle has no font file. */
export const EXACT_KERNEL_LICENCE = 'MIT AND Apache-2.0';

/** How the SMLib WebAssembly is loaded (see `@classcad/smlibwasm/init`). Options only count
 * on the first call in a process or worker; a later call with other options is an error. */
export interface SmlibLoadOptions {
  /** A compiled module, e.g. compiled once and passed to a restarted worker. */
  wasmModule?: WebAssembly.Module;
  wasmBinary?: ArrayBuffer | Uint8Array;
  /** Where to fetch `smlibwasm.wasm` from (default: next to the bundle). */
  locateFile?: (path: string, scriptDirectory: string) => string;
}

async function loadSmlib(options: SmlibLoadOptions) {
  const { init } = await import('@classcad/smlibwasm/init');
  try {
    return await init(options);
  } catch (error) {
    throw new ExactKernelError('invalid-input', `Could not load SMLib: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

const tolerances = (options: { tolerance?: number; angleDeg?: number }) => {
  const tolerance = options.tolerance ?? SMLIB_MESH_TOLERANCE, angle = options.angleDeg ?? SMLIB_MESH_ANGLE;
  positive('Tessellation tolerance and angle', tolerance, angle);
  return { tolerance, angle };
};

function primitives({ sm, solid }: Ctx): Pick<ExactKernel, 'box' | 'cylinder' | 'cone' | 'sphere' | 'torus' | 'polyhedron'> {
  return {
    box(size) { positive('Box size', ...size); return call('Box', () => solid('Box', sm.Box(size[0], size[1], size[2]))); },
    cylinder(radius, height) { positive('Cylinder radius and height', radius, height); return call('Cylinder', () => solid('Cylinder', sm.Cylinder(radius, height))); },
    cone(bottom, top, height) {
      finite('Cone radii', bottom, top); positive('Cone height', height);
      if (bottom < 0 || top < 0 || !(bottom > 0 || top > 0)) invalid('Cone radii must be non-negative and not both zero.');
      // Centred by its bounding box, like the CAD Script frustum.
      return call('Cone', () => solid('Cone', bottom === top ? sm.Cylinder(bottom, height) : sm.Cone(bottom, top, height)));
    },
    sphere(radius) { positive('Sphere radius', radius); return call('Sphere', () => solid('Sphere', sm.Sphere(radius))); },
    torus(major, minor) {
      positive('Torus radii', major, minor);
      if (minor >= major) invalid('The tube radius must be smaller than the major radius.');
      return call('Torus', () => solid('Torus', sm.Torus(major, minor)));
    },
    polyhedron(points, faces) {
      if (!Array.isArray(points) || points.length < 4 || !Array.isArray(faces) || faces.length < 4) invalid('A polyhedron needs at least four points and four faces.');
      for (const p of points) finite('Polyhedron points', p[0], p[1], p[2]);
      for (const f of faces) if (!Array.isArray(f) || f.length < 3 || f.some(i => !Number.isInteger(i) || i < 0 || i >= points.length)) invalid('Polyhedron faces must index at least three existing points.');
      return call('stitch (polyhedron)', () => sm.scope(() => {
        const faceSketches = faces.map(f => {
          const loop = f.map((i: number) => vec(points[i]));
          return sm.makeFace(sm.Polyline(...loop, loop[0]));
        });
        const body = sm.stitch(...faceSketches);
        if (!(body instanceof sm.Part) || !body.isValid()) invalid('The polyhedron faces do not close around a valid solid.');
        return solidOf(body as Part);
      }));
    },
  };
}

function sweeps({ sm, solid }: Ctx): Pick<ExactKernel, 'extrude' | 'revolve' | 'loft' | 'sweep'> {
  return {
    extrude(p, height) { positive('Extrusion height', height); return call('extrude', () => solid('extrude', sm.extrude(sketchOf(p), height))); },
    revolve(p, degrees) {
      finite('Revolution angle', degrees);
      if (degrees === 0 || Math.abs(degrees) > 360) invalid('Revolution angle must be in (0, 360] degrees in magnitude.');
      return call('revolve', () => sm.scope(() => {
        // Sketch Y becomes world Z: rotate the XY sketch +90 degrees about X.
        const upright = sketchOf(p).rotate(sm.Axis.X, 90);
        const part = sm.revolve(upright, sm.Axis.Z, Math.abs(degrees));
        return solid('revolve', degrees < 0 ? part.mirror(new sm.Plane([0, 0, 0], undefined, [0, 1, 0])) : part);
      }));
    },
    loft(sections, options = {}) {
      if (!Array.isArray(sections) || sections.length < 2) invalid('A loft needs at least two sections.');
      for (const s of sections) finite('Loft section position', ...s.at);
      return call('loft', () => sm.scope(() => solid('loft', sm.loft(sections.map(s => sketchOf(s.profile).translate(vec(s.at))), { ruled: !!options.ruled }))));
    },
    sweep(p, rail) {
      if (!Array.isArray(rail) || rail.length < 2) invalid('A sweep rail needs at least two points.');
      for (const q of rail) finite('Sweep rail points', ...q);
      return call('sweep', () => sm.scope(() => {
        const points = rail.map(vec);
        const path = points.length === 2 ? sm.Line(points[0], points[1]) : sm.Polyline(points);
        return solid('sweep', sm.sweep(sketchOf(p), path));
      }));
    },
  };
}

function booleansAndTransforms({ sm, solid }: Ctx): Pick<ExactKernel, 'union' | 'subtract' | 'intersect' | 'splitByPlane' | 'translate' | 'rotate' | 'mirror' | 'scale'> {
  return {
    union: (first, ...rest) => call('fuse', () => solid('fuse', rest.length ? sm.fuse(partOf(first), ...rest.map(partOf)) : partOf(first))),
    subtract: (base, ...cutters) => call('cut', () => solid('cut', cutters.length ? sm.cut(partOf(base), ...cutters.map(partOf)) : partOf(base))),
    intersect: (first, ...rest) => call('intersect', () => solid('intersect', rest.length ? sm.intersect(partOf(first), ...rest.map(partOf)) : partOf(first))),
    splitByPlane: (s, normal, offset) => {
      const n = unitVector('Split normal', normal); finite('Split offset', offset);
      return call('split', () => {
        const [above, below] = sm.split(partOf(s), new sm.Plane([n[0] * offset, n[1] * offset, n[2] * offset], undefined, n), 'both');
        return [solid('split', above), solid('split', below)];
      });
    },
    translate: (s, v) => { finite('Translation', ...v); return call('translate', () => solidOf(partOf(s).translate(vec(v)))); },
    rotate: (s, axis, degrees, pivot = [0, 0, 0]) => {
      const n = unitVector('Rotation axis', axis); finite('Rotation angle and pivot', degrees, ...pivot);
      return call('rotate', () => solidOf(partOf(s).rotate(new sm.Axis(vec(pivot), n), degrees)));
    },
    mirror: (s, normal, origin = [0, 0, 0]) => {
      const n = unitVector('Mirror normal', normal); finite('Mirror origin', ...origin);
      return call('mirror', () => solidOf(partOf(s).mirror(new sm.Plane(vec(origin), undefined, n))));
    },
    scale: (s, f) => {
      finite('Scale factors', ...f);
      if (f.some(v => v === 0)) invalid('A zero scale factor flattens the solid.');
      return call('scale', () => solidOf(partOf(s).scale(vec(f), [0, 0, 0])));
    },
  };
}

function features(ctx: Ctx): Pick<ExactKernel, 'fillet' | 'chamfer' | 'shell'> {
  const { sm, solid, face } = ctx;
  const edgesOf = (part: Part, selector: 'all' | FaceSelector) => (selector === 'all' ? part.edges() : face(part, selector).edges());
  const isSelector = (v: unknown): v is Vec3 | FaceSelector => (Array.isArray(v) && typeof v[0] === 'number') || (!!v && typeof v === 'object' && 'faceNormal' in v);
  return {
    fillet: (s, radius, edges = 'all') => {
      positive('Fillet radius', radius);
      return call('fillet', () => solid('fillet', sm.fillet(edgesOf(partOf(s), edges), radius)));
    },
    chamfer: (s, distance, edges = 'all') => {
      positive('Chamfer distance', distance);
      return call('chamfer', () => solid('chamfer', sm.chamfer(edgesOf(partOf(s), edges), distance)));
    },
    shell: (s, thickness, openFaces) => {
      positive('Shell thickness', thickness);
      const selectors = openFaces === undefined ? [] : isSelector(openFaces) ? [openFaces] : [...openFaces as readonly (Vec3 | FaceSelector)[]];
      return call('shell', () => {
        const part = partOf(s);
        const open = selectors.map(sel => face(part, sel));
        return solid('shell', sm.shell(part, -thickness, open.length ? open : null));
      });
    },
  };
}

function measures({ sm }: Ctx): Pick<ExactKernel, 'volume' | 'area' | 'bbox' | 'massProperties' | 'isValid' | 'solidCount' | 'components'> {
  return {
    volume: s => call('volume', () => partOf(s).volume),
    area: s => call('area', () => partOf(s).area),
    bbox: (s): BoundingBox => call('bbox', () => {
      const b = partOf(s).bbox();
      return { min: [b.min.x, b.min.y, b.min.z], max: [b.max.x, b.max.y, b.max.z] };
    }),
    massProperties: (s): MassProperties => call('massProperties', () => {
      const p = partOf(s).massProperties(1);
      const I = p.inertia, sym = (i: number, j: number) => (I[i][j] + I[j][i]) / 2;
      const inertia: MassProperties['inertia'] = [[I[0][0], sym(0, 1), sym(0, 2)], [sym(0, 1), I[1][1], sym(1, 2)], [sym(0, 2), sym(1, 2), I[2][2]]];
      const { values, vectors } = symmetricEigen(inertia);
      return { volume: p.volume, centroid: [p.center.x, p.center.y, p.center.z], inertia, principalMoments: values, principalAxes: vectors };
    }),
    isValid: s => call('isValid', () => partOf(s).isValid()),
    solidCount: s => call('solids', () => sm.scope(() => partOf(s).solids().length)),
    components: s => call('solids', () => [...partOf(s).solids()].map(solidOf)),
  };
}

function exchange({ sm, solid }: Ctx): Pick<ExactKernel, 'tessellate' | 'exportStl' | 'exportStep' | 'importStep'> {
  return {
    tessellate: (s, options = {}): TriangleMesh => {
      const { tolerance, angle } = tolerances(options);
      return call('mesh', () => sm.scope(() => {
        const mesh = partOf(s).mesh(tolerance, angle);
        const positions = Float64Array.from(mesh.vertices), indices = Uint32Array.from(mesh.triangles);
        return { positions, normals: vertexNormals(positions, indices), indices };
      }));
    },
    exportStl: (s, options = {}) => {
      const { tolerance, angle } = tolerances(options);
      return call('toStl', () => sm.toStl(partOf(s), { tolerance, angle }));
    },
    exportStep: s => call('toStep', () => sm.toStep(partOf(s))),
    importStep: text => {
      if (typeof text !== 'string' || !text.length) invalid('STEP input must be non-empty text.');
      return call('fromStep', () => {
        const result: unknown = sm.fromStep(text);
        // A file of several bodies comes back as a list; join them into one (disjoint) part.
        if (Array.isArray(result) && result.length && result.every(r => r instanceof sm.Part)) {
          const parts = result as Part[];
          return solid('fromStep', parts.length === 1 ? parts[0] : sm.fuse(parts[0], ...parts.slice(1)));
        }
        return solid('fromStep', result);
      });
    },
  };
}

/** Load SMLib (once per process or worker) and return an ExactKernel on it. */
export async function createSmlibKernel(options: SmlibLoadOptions = {}): Promise<ExactKernel> {
  const sm = await loadSmlib(options);
  sm.setWarningHandler(() => { /* warnings are not failures; results are checked by measure */ });
  const ctx = createContext(sm);
  return {
    name: '@classcad/smlibwasm',
    version: sm.version,
    licence: EXACT_KERNEL_LICENCE,
    profile: createProfileOps(sm),
    ...primitives(ctx),
    ...sweeps(ctx),
    ...booleansAndTransforms(ctx),
    ...features(ctx),
    ...measures(ctx),
    ...exchange(ctx),
    memory: (): KernelMemory => { const m = sm.memoryUsage(); return { used: m.used, heap: m.heap, handles: m.handles }; },
    scope: fn => sm.scope(fn),
  };
}
