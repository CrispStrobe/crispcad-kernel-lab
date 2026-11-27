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
  type BoundingBox, type ExactKernel, type FaceSelector, type KernelMemory, type LoftSection, type MassProperties, type StepImport, type StepImportBody, type TriangleMesh, type Vec3,
} from './exact-kernel.ts';
import { call, createContext, outlineOf, partOf, polygonOf, sketchOf, solidOf, vec, type Ctx, type Part, type Smlib } from './smlib-context.ts';
import { compatibleSections, originOrders, type LoftPairing, type P3 } from './compatible-sections.ts';
import { exactBoundingBox } from './bbox.ts';
import { planarFaces } from './polytope.ts';
import { createProfileOps } from './smlib-profile.ts';
import { finite, invalid, positive, symmetricEigen, unitVector, vertexNormals } from './validate.ts';

/** Default display tessellation: 0.01 mm chord, 10 degrees. */
export const SMLIB_MESH_TOLERANCE = 0.01;
export const SMLIB_MESH_ANGLE = 10;
/** SPDX licence of everything this package runs: the bundle has no font file. */
export const EXACT_KERNEL_LICENCE = 'MIT AND Apache-2.0';

/** How the SMLib WebAssembly is loaded (see `@classcad/smlibwasm/init`), and its limits. Load
 * options only count on the first call in a process or worker; a later call with other options is
 * an error. */
export interface SmlibLoadOptions {
  /** A compiled module, e.g. compiled once and passed to a restarted worker. */
  wasmModule?: WebAssembly.Module;
  wasmBinary?: ArrayBuffer | Uint8Array;
  /** Where to fetch `smlibwasm.wasm` from (default: next to the bundle). */
  locateFile?: (path: string, scriptDirectory: string) => string;
  /**
   * Ceiling for the kernel's WebAssembly memory, in bytes (rounded down to 64 KiB pages; at least
   * the initial 64 MiB). The module itself may grow to 4 GiB; with a ceiling, growth past it fails
   * as an allocation failure does (SMLib reports it as an error, e.g. "ran out of memory", and the
   * kernel should then be discarded). It is enforced at instantiation, on the loaded instance's
   * memory and the loader's heap-resize import: the module's bytes are not changed, so
   * `dist/smlibwasm.wasm` stays the pinned build. Only on the first call; it does not cover the
   * probe worker that runs shell and defeaturing steps in Node and cross-origin-isolated workers
   * (a kernel of its own).
   */
  maxMemoryBytes?: number;
  /** Seconds a guarded step may take (smlibwasm's GUARD_SECONDS, default 20); see
   * `SmlibKernel.setGuardSeconds`. */
  guardSeconds?: number;
}

/** The SMLib kernel: the ExactKernel interface plus SMLib's own limits. */
export interface SmlibKernel extends ExactKernel {
  /**
   * Sets smlibwasm's guard (GUARD_SECONDS, 20 s by default; 0: no limit) and returns the old
   * value. It holds for the process or worker, not this kernel object. Guarded are the steps that
   * can crash or loop: shell, offset, thicken, removeFaces / removeFillets and fillets and
   * chamfers of imported parts (not fillet or chamfer of parts built here). Where a probe worker
   * can run (Node, Web Workers of a cross-origin-isolated page) the step runs there and is ended
   * after this many seconds of wall-clock time. Elsewhere (a browser's main thread, an ordinary
   * Web Worker) it runs in this kernel under SMLib's deadline, which only the long loops of its
   * surface and topology intersections check: a step that spends its time elsewhere is not
   * stopped, so a host needs its own budget too.
   */
  setGuardSeconds(seconds: number): number;
  /** The current guard (seconds; 0: none). */
  guardSeconds(): number;
  /** The memory ceiling the kernel was loaded with (bytes), if any. */
  readonly maxMemoryBytes?: number;
}

const WASM_PAGE = 65536;
let loadedCap: number | undefined;
let capping: { bytes: number; loaded: Promise<typeof import('@classcad/smlibwasm')> } | undefined;

/** Where the default `smlibwasm.wasm` is: next to this bundle (dist/). */
const defaultWasmUrl = () => new URL('./smlibwasm.wasm', import.meta.url);

async function wasmSource(options: SmlibLoadOptions): Promise<WebAssembly.Module | Uint8Array | ArrayBuffer> {
  if (options.wasmModule) return options.wasmModule;
  if (options.wasmBinary) return options.wasmBinary;
  const base = defaultWasmUrl();
  const url = options.locateFile ? options.locateFile('smlibwasm.wasm', new URL('.', base).href) : base.href;
  const node = !!(globalThis as { process?: { versions?: { node?: string } } }).process?.versions?.node;
  if (url.startsWith('file:') || (node && !/^[a-z]+:/i.test(url))) {
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    return readFile(url.startsWith('file:') ? fileURLToPath(url) : url);
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`fetching ${url}: ${response.status} ${response.statusText}`);
  return new Uint8Array(await response.arrayBuffer());
}

/**
 * Where the pinned loader hands the module its heap-resize function (Emscripten's
 * `_emscripten_resize_heap`): the import `a`.`D`. Emscripten minifies import names when it links,
 * so the module and its loader agree on these keys, and both are pinned by sha256
 * (BUILD-PROVENANCE.json: `wasm/smlibwasm.wasm`, `wasm/smlibwasm.mjs`); scripts/build.mjs checks
 * the loader's import table for this pair before it bundles it. The import is found by these keys,
 * never by the function's `name`: a minifier that bundles this package renames functions, but it
 * keeps property keys (the WebAssembly module looks its imports up by them).
 */
const RESIZE_HEAP_IMPORT = { module: 'a', name: 'D' } as const;

/**
 * smlibwasm's `instantiateWasm` hook, with the instance's memory held to `maxBytes`. Emscripten
 * grows the heap only through its heap-resize import (RESIZE_HEAP_IMPORT), which calls
 * `memory.grow` (up to four times, asking for 20, 10, 6.7 and 5 % over the old size, never less
 * than the size needed): the import records the size asked for while it runs, and the instance's
 * `grow` refuses a size past the ceiling (a RangeError, which Emscripten takes as a failed
 * allocation) and otherwise grows at most to the ceiling. A `grow` outside that import is refused,
 * so a loader whose import table were not the pinned one fails as out of memory, never past the
 * ceiling.
 */
function cappedInstantiation(options: SmlibLoadOptions, maxBytes: number, fail: (e: Error) => void) {
  const capPages = Math.floor(maxBytes / WASM_PAGE);
  return (imports: WebAssembly.Imports, receive: (instance: WebAssembly.Instance) => void) => {
    let requested: number | undefined;
    const mod = imports[RESIZE_HEAP_IMPORT.module] as Record<string, unknown> | undefined;
    const resize = mod?.[RESIZE_HEAP_IMPORT.name];
    if (mod && typeof resize === 'function') {
      mod[RESIZE_HEAP_IMPORT.name] = (size: number) => {
        requested = size >>> 0;
        try { return (resize as (size: number) => number)(size); } finally { requested = undefined; }
      };
    }
    (async () => {
      if (!mod || typeof resize !== 'function') throw new Error(`the loader has no heap-resize import ${RESIZE_HEAP_IMPORT.module}.${RESIZE_HEAP_IMPORT.name} to hold the memory ceiling with`);
      const source = await wasmSource(options);
      const module = source instanceof WebAssembly.Module ? source : await WebAssembly.compile(source as BufferSource);
      if (!WebAssembly.Module.imports(module).some(i => i.module === RESIZE_HEAP_IMPORT.module && i.name === RESIZE_HEAP_IMPORT.name && i.kind === 'function')) {
        throw new Error(`the module imports no function ${RESIZE_HEAP_IMPORT.module}.${RESIZE_HEAP_IMPORT.name}: it is not the pinned smlibwasm build`);
      }
      const instance = await WebAssembly.instantiate(module, imports);
      const memory = Object.values(instance.exports).find((e): e is WebAssembly.Memory => e instanceof WebAssembly.Memory);
      if (!memory) throw new Error('the module exports no memory');
      if (memory.buffer.byteLength > capPages * WASM_PAGE) throw new Error(`the memory ceiling ${maxBytes} bytes is below the module's initial ${memory.buffer.byteLength} bytes`);
      const grow = memory.grow.bind(memory);
      Object.defineProperty(memory, 'grow', {
        configurable: true,
        value: (pages: number) => {
          const current = memory.buffer.byteLength / WASM_PAGE;
          if (requested === undefined || Math.ceil(requested / WASM_PAGE) > capPages || current >= capPages) throw new RangeError(`WebAssembly memory ceiling of ${capPages * WASM_PAGE} bytes reached`);
          return grow(Math.min(pages, capPages - current));
        },
      });
      receive(instance);
    })().catch(e => fail(e instanceof Error ? e : new Error(String(e))));
    return {};
  };
}

async function loadSmlib(options: SmlibLoadOptions) {
  const { init } = await import('@classcad/smlibwasm/init');
  const { maxMemoryBytes, ...rest } = options;
  const load: SmlibLoadOptions = { ...rest };
  delete load.guardSeconds; // (set after loading, in createSmlibKernel)
  try {
    if (maxMemoryBytes === undefined) return await init(load);
    if (!(maxMemoryBytes > 0) || !Number.isFinite(maxMemoryBytes)) invalid('maxMemoryBytes must be a positive number of bytes.');
    const pages = Math.floor(maxMemoryBytes / WASM_PAGE) * WASM_PAGE;
    if (capping) {
      // Loaded (or loading) with a ceiling already: the same one is the same kernel.
      if (pages !== capping.bytes) invalid(`The kernel was loaded with a memory ceiling of ${capping.bytes} bytes; it loads once per process or worker.`);
      return await capping.loaded;
    }
    let fail: (e: Error) => void = () => {};
    const failed = new Promise<never>((_, reject) => { fail = reject; });
    const loaded = Promise.race([init({ instantiateWasm: cappedInstantiation(load, maxMemoryBytes, fail) } as never), failed]);
    capping = { bytes: pages, loaded };
    try {
      const sm = await loaded;
      loadedCap = pages;
      return sm;
    } catch (e) {
      capping = undefined;
      throw e;
    }
  } catch (error) {
    if (error instanceof ExactKernelError) throw error;
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
        // A face SMLib cannot make planar is split into triangles first (same surface, same edges).
        const faceSketches = planarFaces(points, faces).map(f => {
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

/** Sections of straight edges, matched by compatibleSections, as wires of lines. */
function lineWiresOf(sm: Smlib, sections: readonly (readonly P3[])[], pairing: LoftPairing) {
  const matched = compatibleSections(sections, pairing) ?? invalid('The loft sections cannot be matched vertex to vertex.');
  return matched.map(pts => new sm.Wire(pts.map((p, k) => sm.Line(vec(p), vec(pts[(k + 1) % pts.length]!)))));
}

/** Angle (radians) below which two edges meeting at a vertex count as tangent: the vertex is no corner. */
const SMOOTH_ANGLE = 1e-6;

type Edge = InstanceType<Smlib['Edge']>;
const xyz = (v: { x: number; y: number; z: number }): P3 => [v.x, v.y, v.z];

/**
 * pairing 'closest' for sections that are not all straight-edged polygon or path profiles: each
 * section must be a single outline (a path profile's outline as drawn, or the boundary of a
 * profile that is one region without holes: circle, rectangle, rounded rectangle, ...). Then:
 *
 * - all edges straight: as polygons (compatibleSections; different counts by the polar rule);
 * - some edge curved, every section without a corner (a vertex where the edges meet at an angle,
 *   more than SMOOTH_ANGLE): undefined, the loft takes the sections as drawn (OCCT re-starts
 *   only sections with a corner; a circle has no vertex to re-start at);
 * - some edge curved, equal edge counts: each section re-started as straight-edged sections are
 *   (computeOrigin: the vertex and direction where its vertices lie closest to those of the section
 *   before, centred on the centroid of its outline as a curve), keeping every edge's curve (an
 *   edge run backward is the same curve reversed);
 * - some edge curved, different edge counts: refused ('unsupported'). OCCT would split curved
 *   edges by its polar rule; this kernel does that only for straight edges.
 */
function closestCurvedSectionsOf(sm: Smlib, sections: readonly LoftSection[]) {
  const loops = sections.map((s, i) => edgeLoop(s, i));
  if (loops.every(l => l.every(e => e.geomType === 'line'))) {
    return lineWiresOf(sm, loops.map(l => l.map(e => xyz(e.start))), 'closest');
  }
  if (loops.some(l => l.length !== loops[0]!.length)) {
    throw new ExactKernelError('unsupported', `Loft pairing 'closest' matches sections with different edge counts (${loops.map(l => l.length).join(', ')}) only when every edge is straight; these have curved edges. Use pairing 'authored', or give the sections equal edge counts.`);
  }
  const corner = (l: readonly Edge[]) => l.some((e, k) => {
    const before = l[(k + l.length - 1) % l.length]!.tangentAt(1), after = e.tangentAt(0);
    return Math.acos(Math.max(-1, Math.min(1, before.x * after.x + before.y * after.y + before.z * after.z))) > SMOOTH_ANGLE;
  });
  if (!loops.some(corner)) return undefined;
  const frames = loops.map(l => ({ pos: curveCentroid(l), axis: [0, 0, 1] as P3 }));
  const orders = originOrders(loops.map(l => l.map(e => xyz(e.start))), frames);
  const native = sections.map(s => !!outlineOf(s.profile)); // edges as the path drew them
  return loops.map((l, i) => {
    const { start, forward } = orders[i]!, m = l.length;
    // Forward from vertex j: edges j, j + 1, ...; backward: edges j - 1, j - 2, ..., each run the
    // other way. SMLib's loft follows each edge's curve parameter, not its orientation in the wire
    // (an `Edge.reversed()` arc lofts as the arc forward), so lines and circular arcs are made anew
    // from their ends and midpoint in the direction they are run in.
    const edges = Array.from({ length: m }, (_, k) => forward ? l[(start + k) % m]! : l[(((start - 1 - k) % m) + m) % m]!);
    return new sm.Wire(edges.map(e => {
      const [a, b] = forward ? [e.start, e.end] : [e.end, e.start];
      if (e.geomType === 'line') return sm.Line(xyz(a), xyz(b));
      if (e.geomType === 'circle') return sm.ThreePointArc(xyz(a), xyz(e.pointAt(0.5)), xyz(b));
      if (forward && native[i]) return e;
      throw new ExactKernelError('unsupported', `Loft pairing 'closest' would run section ${i + 1} ${forward ? 'from another vertex' : 'the other way round'}, and it has a ${e.geomType} edge, which this kernel re-starts only as drawn in a path profile; it re-starts lines and circular arcs. Use pairing 'authored', or draw the section from the vertex and in the direction it pairs with.`);
    }));
  });
}

/** A section's outline as a closed chain of edges (edge k ends where edge k + 1 starts), placed at `at`. */
function edgeLoop(section: LoftSection, index: number): Edge[] {
  const unsupported = (why: string): never => { throw new ExactKernelError('unsupported', `Loft pairing 'closest' needs single-outline sections; section ${index + 1} ${why}. Use pairing 'authored' for it.`); };
  let wire = outlineOf(section.profile);
  if (!wire) {
    const faces = [...sketchOf(section.profile).faces()];
    if (faces.length !== 1) unsupported(`has ${faces.length} regions`);
    if ([...faces[0]!.innerWires()].length) unsupported('has holes');
    wire = faces[0]!.outerWire();
  }
  const edges = [...wire.translate(vec(section.at)).edges()];
  const near = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) <= 1e-7;
  for (let k = 0; k < edges.length; k++) {
    const e = edges[k]!, next = edges[(k + 1) % edges.length]!;
    if (!near(e.end, next.start)) unsupported('is not one closed chain of edges');
    if (e.isClosed && edges.length > 1) unsupported('has a closed edge among others');
  }
  return edges;
}

/** Centroid of a closed chain of edges as a curve (Simpson's rule along each edge's length). */
function curveCentroid(edges: readonly Edge[]): P3 {
  const N = 64; // intervals per edge (even)
  let len = 0;
  const c: [number, number, number] = [0, 0, 0];
  for (const e of edges) {
    const l = e.length;
    for (let k = 0; k <= N; k++) {
      const w = (k === 0 || k === N ? 1 : k % 2 ? 4 : 2) * l / (3 * N), p = e.pointAt(k / N);
      c[0] += w * p.x; c[1] += w * p.y; c[2] += w * p.z;
    }
    len += l;
  }
  return [c[0] / len, c[1] / len, c[2] / len];
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
      const pairing = options.pairing ?? 'authored';
      if (pairing !== 'authored' && pairing !== 'closest') invalid(`Unknown loft pairing '${String(pairing)}' (authored or closest).`);
      return call('loft', () => sm.scope(() => {
        const ruled = !!options.ruled;
        // Straight-edged single outlines with different vertex counts get vertices inserted as
        // OCCT's ThruSections inserts them; with equal counts they are re-started as OCCT does only
        // for pairing 'closest' (compatible-sections.ts). 'authored' equal counts take the path below,
        // as in 0.1.4: vertex i joins vertex i as drawn.
        const counts = sections.map(s => polygonOf(s.profile)?.length);
        const unequal = counts.some(c => c !== counts[0]);
        if (counts.every(c => c !== undefined) && (unequal || pairing === 'closest')) {
          return solid('loft', sm.loft(lineWiresOf(sm, sections.map(s => polygonOf(s.profile)!.map(p => [p[0] + s.at[0], p[1] + s.at[1], p[2] + s.at[2]] as const)), pairing), { ruled }));
        }
        if (pairing === 'closest') {
          const closest = closestCurvedSectionsOf(sm, sections);
          if (closest) return solid('loft', sm.loft(closest, { ruled }));
        }
        // Path profiles loft through their outlines as drawn, so vertex i joins vertex i (ProfileHandle).
        const outlines = sections.every(s => outlineOf(s.profile)) ? sections.map(s => outlineOf(s.profile)!.translate(vec(s.at))) : undefined;
        const profiles = outlines ?? sections.map(s => sketchOf(s.profile).translate(vec(s.at)));
        return solid('loft', sm.loft(profiles, { ruled }));
      }));
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
    // Not SMLib's bbox(): it misses interior extremes of some rotated spheres (see bbox.ts).
    bbox: (s): BoundingBox => call('bbox', () => exactBoundingBox(partOf(s))),
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

/** Warnings are not failures (results are checked by measure); `importStepBodies` collects the
 * reader's own while it runs. */
const ignoreWarning = (): void => { /* see above */ };
export const DEFAULT_MAX_STEP_BODIES = 1000;
const STEP_MAGIC = 'ISO-10303-21';
const END_MARK = /END-ISO-10303-21;\s*$/;
/** The text without the NUL and SUB bytes some writers pad files with after the end marker. */
function unpadded(text: string): string {
  let end = text.length;
  while (end > 0 && (text.charCodeAt(end - 1) === 0 || text.charCodeAt(end - 1) === 26)) end--;
  return text.slice(0, end);
}

function stepText(data: string | Uint8Array): string {
  if (typeof data === 'string') return data;
  if (data instanceof Uint8Array) {
    let text = '';
    for (let i = 0; i < data.length; i += 0x8000) text += String.fromCharCode(...data.subarray(i, i + 0x8000));
    return text;
  }
  return invalid('STEP input must be text or bytes (a Uint8Array).');
}

function importStepBodies(sm: Smlib, data: string | Uint8Array, maxBodies: number): StepImport {
  const text = stepText(data);
  if (!text.length) invalid('STEP input must not be empty.');
  // A STEP file (ISO 10303-21) starts with its magic, after an optional byte-order mark.
  if (!text.replace(/^\uFEFF|^\xEF\xBB\xBF/, '').trimStart().startsWith(STEP_MAGIC)) invalid('This is not a STEP file: it does not start with ISO-10303-21.');
  // A file cut short (a partial download, a size limit) misses its end marker; refuse it as such
  // rather than reading the entities that happen to be complete.
  if (!END_MARK.test(unpadded(text))) invalid('The STEP file is incomplete: it does not end with END-ISO-10303-21; (was it cut short?).');
  const notes: string[] = [];
  let result: unknown;
  sm.setWarningHandler(message => { notes.push(String(message)); });
  try {
    result = sm.fromStep(text, { strict: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof sm.KernelError) throw new ExactKernelError('kernel-failure', `SMLib fromStep failed: ${message}`, { cause: error });
    if (error instanceof sm.ModelingError) {
      // Strict reading: a body the reader cannot build, or a file without bodies.
      throw new ExactKernelError('unsupported', /holds no B-rep/.test(message) ? 'The STEP file holds no solid (no B-rep body).' : `The STEP file cannot be read exactly: ${message.replace(/^import STEP: /, '')}`, { cause: error });
    }
    // The parser's own errors (bad syntax, truncated text, entities that do not resolve).
    throw new ExactKernelError('invalid-input', `The STEP file is malformed: ${message}`, { cause: error });
  } finally {
    sm.setWarningHandler(ignoreWarning);
  }
  const found: unknown[] = Array.isArray(result) ? [...result] : [result];
  const dispose = () => found.forEach(b => (b as { dispose?: () => void })?.dispose?.());
  try {
    if (!found.length) throw new ExactKernelError('unsupported', 'The STEP file holds no solid (no B-rep body).');
    if (found.length > maxBodies) throw new ExactKernelError('unsupported', `The STEP file holds ${found.length} bodies; at most ${maxBodies} can be imported.`);
    const label = (b: { name?: string | null }, i: number) => b.name ? `body ${i + 1} ('${b.name}')` : `body ${i + 1}`;
    found.forEach((b, i) => {
      if (!(b instanceof sm.Part)) {
        const kind = b instanceof sm.Shell ? 'an open surface (a sheet), not a closed solid' : `not a solid (${(b as object | null)?.constructor?.name ?? typeof b})`;
        throw new ExactKernelError('unsupported', `The STEP file's ${label(b as { name?: string }, i)} is ${kind}.`);
      }
      const valid = call('isValid', () => b.isValid());
      const volume = valid ? call('volume', () => b.volume) : 0;
      if (!valid || !(volume > 0)) throw new ExactKernelError('unsupported', `The STEP file's ${label(b, i)} is not a valid closed solid, even after repair.`);
    });
  } catch (error) {
    dispose();
    throw error;
  }
  const bodies: StepImportBody[] = (found as Part[]).map(part => {
    const color = part.color as readonly number[] | null;
    return { solid: solidOf(part), name: typeof part.name === 'string' && part.name ? part.name : null, color: color ? [Number(color[0]), Number(color[1]), Number(color[2])] : null };
  });
  return { bodies, notes };
}

function exchange({ sm, solid }: Ctx): Pick<ExactKernel, 'tessellate' | 'exportStl' | 'exportStep' | 'importStep' | 'importStepBodies'> {
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
    importStepBodies: (data, options = {}) => {
      const maxBodies = options.maxBodies ?? DEFAULT_MAX_STEP_BODIES;
      if (!Number.isInteger(maxBodies) || maxBodies < 1) invalid('maxBodies must be a positive whole number.');
      return importStepBodies(sm, data, maxBodies);
    },
  };
}

/** Load SMLib (once per process or worker) and return an ExactKernel on it. */
export async function createSmlibKernel(options: SmlibLoadOptions = {}): Promise<SmlibKernel> {
  const sm = await loadSmlib(options);
  if (options.guardSeconds !== undefined) {
    if (!(options.guardSeconds >= 0)) invalid('guardSeconds must be 0 or more.');
    sm.setGuardSeconds(options.guardSeconds);
  }
  sm.setWarningHandler(ignoreWarning);
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
    setGuardSeconds: (seconds: number) => {
      if (!(Number(seconds) >= 0)) invalid('The guard must be 0 or more seconds.');
      return sm.setGuardSeconds(seconds);
    },
    guardSeconds: () => sm.GUARD_SECONDS,
    ...(loadedCap !== undefined ? { maxMemoryBytes: loadedCap } : {}),
  };
}
