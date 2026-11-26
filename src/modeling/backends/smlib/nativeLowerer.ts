// SPDX-License-Identifier: MIT
// Copyright (c) 2026 CrispCAD contributors
//
// Native SMLib lowerer: compiles feature records straight to SMLib solids
// (SmlibBackend) with no OpenCASCADE reference, cross-check or STEP round trip.
// A feature kind or option this lowerer does not implement is an explicit
// `recompute.kernel.unsupported-feature` error; nothing falls back silently.
import type { FeatureLowerer, LowerResult, ResolvedInputs, ShapeBackend } from '../../../kernel/backends/backend';
import { SmlibBackend } from '../../../kernel/backends/smlib/smlibBackend';
import type { RuntimeMesh } from '../../../kernel/backends/runtimeMesh';
import type { CompilerDiagnostic } from '../../../shared/diagnostics/diagnostic';
import { withNextAction } from '../../../shared/diagnostics/diagnostic';
import type { FeatureRecord } from '../../../shared/intent/featureRecord';
import type { FeatureKind, Vec3 } from '../../../shared/intent/types';
import type { BackendTarget } from '../../../shared/types/backendTarget';
import { loadSmlib } from './runtime';
import { polygonLoops } from './polygonLoops';
import { outlineCrossing, type OutlinePoint } from './profileCrossing';
import { compatibleSections, type P3 } from './compatibleSections';
import { isSceneBackend, type SceneBackend, type SceneBackendPart } from '../../../kernel/backends/sceneBackend';
import { lookupSourceColor, lookupSourceMaterial } from '../../../kernel/backends/occt/lookupSourceColor';
import { resolvedPartAt } from '../../mates/partFrame';
import type { Connector } from '../../mates/connector';
// Kernel-agnostic: the mate solver works on connector frames and placements only.
import { lowerAssemblyModel } from '../occt/lowerers/assembly';
import { Transform } from '../../../shared/runtime/se3';
import { helixOptionsFromSpec, type HelixRailSpec } from '../../helix';
import type { FeatureId, Vec3Param } from '../../../shared/intent/types';

type Smlib = typeof import('@classcad/smlibwasm');
type Part = InstanceType<Smlib['Part']>;
type Sketch = ReturnType<Smlib['makeFace']>;
type Edge = InstanceType<Smlib['Edge']>;
type Face = InstanceType<Smlib['Face']>;
type Wire = InstanceType<Smlib['Wire']>;

class Unsupported extends Error {}
/** An outline that crosses itself: it bounds no region, so no kernel can build it (profileCrossing.ts). */
class CrossingOutline extends Error {}

/** Refuse a closed outline that crosses itself. */
function refuseCrossing(what: string, outline: readonly OutlinePoint[]): void {
  const crossing = outlineCrossing(outline);
  if (!crossing) return;
  const [x, y] = crossing.at.map(v => +v.toPrecision(6));
  throw new CrossingOutline(`The ${what} crosses itself at (${x}, ${y}), so it bounds no region and cannot be built as a solid.`);
}

/** Points along a closed loop of SMLib edges: each line's start, 32 points along each curved edge. */
function loopOutline(edges: readonly { length: number; pointAt(t: number): { x: number; y: number } }[]): OutlinePoint[] {
  const out: OutlinePoint[] = [];
  for (const edge of edges) {
    const a = edge.pointAt(0), b = edge.pointAt(1);
    const straight = Math.abs(edge.length - Math.hypot(b.x - a.x, b.y - a.y)) <= 1e-9 * Math.max(1, edge.length);
    const n = straight ? 1 : 32;
    for (let k = 0; k < n; k++) { const p = k ? edge.pointAt(k / n) : a; out.push([p.x, p.y]); }
  }
  return out;
}

/** Sections per turn of the loft that stands in for an axial helical sweep. */
const HELIX_SECTIONS_PER_TURN = 48;

interface AssemblyModelMeta {
  assemblyName?: string;
  partIds?: FeatureId[];
  mates?: unknown[];
  couplings?: unknown[];
  connectorsByPartId?: Record<FeatureId, readonly Connector[]>;
}

type Param = (name: string) => number;
type Builder = (sm: Smlib, r: FeatureRecord, inputs: ResolvedInputs, p: Param) => ShapeBackend;

/** A lowered 2D sketch: consumed by extrude/revolve/loft/sweep, not a solid. */
export class SmlibSketchBackend implements ShapeBackend {
  readonly target: BackendTarget = 'export-smlib';
  readonly sketch: Sketch;
  readonly closed: boolean;
  /** A single-loop sketch's outline as drawn: its edges from the authored first point, in the
   *  authored direction. makeFace may start the face's boundary elsewhere (an 8-point square, whose
   *  edges run on collinearly, starts at another vertex), and a ruled loft joins vertex i of one
   *  section to vertex i of the next, so lofts take this wire. */
  readonly outline?: Wire;
  /** The outline's vertices as drawn when all its edges are straight (sketch x, y). Lofts
   *  between such sections with different vertex counts equalise them as OCCT does
   *  (compatibleSections.ts). */
  readonly polygon?: readonly Vec3[];
  constructor(sketch: Sketch, closed: boolean, outline?: Wire, polygon?: readonly Vec3[]) {
    this.sketch = sketch;
    this.closed = closed;
    this.outline = outline;
    this.polygon = polygon;
  }
  private flat(): never { throw new Unsupported('A sketch is a profile, not a solid; extrude, revolve, loft or sweep it first.'); }
  translate(): ShapeBackend { return this.flat(); }
  rotate(): ShapeBackend { return this.flat(); }
  scale(): ShapeBackend { return this.flat(); }
  union(): ShapeBackend { return this.flat(); }
  subtract(): ShapeBackend { return this.flat(); }
  intersect(): ShapeBackend { return this.flat(); }
  splitByPlane(): [ShapeBackend, ShapeBackend] { return this.flat(); }
  boundingBox(): { min: Vec3; max: Vec3 } { const b = this.sketch.bbox(); return { min: [b.min.x, b.min.y, b.min.z], max: [b.max.x, b.max.y, b.max.z] }; }
  volume(): number { return 0; }
  surfaceArea(): number { return this.sketch.area; }
  massProperties(): never { return this.flat(); }
  isEmpty(): boolean { return true; }
  solidComponents(): readonly ShapeBackend[] { return []; }
  getMesh(): RuntimeMesh { return { positions: new Float32Array(), normals: new Float32Array(), indices: new Uint32Array() }; }
  exportSTL(): Uint8Array { return this.flat(); }
  exportSTEP(): Uint8Array { return this.flat(); }
}

/** Feature kinds this lowerer builds natively. */
export const NATIVE_SMLIB_KINDS: readonly FeatureKind[] = [
  'box', 'cylinder', 'sphere', 'sketch', 'extrude', 'revolve', 'loft', 'sweep',
  'boolean', 'fillet', 'chamfer', 'shell', 'hole', 'holes', 'pattern', 'mirror',
  'assemblyPart', 'assemblyModel',
];

const word = (p: { expression: string } | undefined) => (p?.expression ?? '').replace(/['"]/g, '');
const num = (v: unknown): number => (typeof v === 'number' ? v : (v as { evaluated: number }).evaluated);
const CANONICAL_NORMALS: Record<string, Vec3> = { top: [0, 0, 1], bottom: [0, 0, -1], right: [1, 0, 0], left: [-1, 0, 0], back: [0, 1, 0], front: [0, -1, 0] };

type SketchCommand = { kind: string; [k: string]: unknown };
interface Pen { at: Vec3; start: Vec3; closed: boolean; edges: Edge[]; loops: Edge[][] }
const xy = (c: Record<string, unknown>, x: string, y: string): Vec3 => [num(c[x]), num(c[y]), 0];
/** Append one edge ending at the command's (x, y). */
const edgeTo = (make: (sm: Smlib, from: Vec3, to: Vec3, c: SketchCommand) => Edge) => (sm: Smlib, c: SketchCommand, pen: Pen) => {
  const next = xy(c, 'x', 'y');
  pen.edges.push(make(sm, pen.at, next, c));
  pen.at = next;
};
const SKETCH_STEPS: Record<string, (sm: Smlib, c: SketchCommand, pen: Pen) => void> = {
  // A moveTo after drawn edges closes that loop and starts another (as OCCT's profile
  // lowerer does); the loops fill even-odd, so inner loops are holes.
  moveTo: (sm, c, pen) => {
    if (pen.edges.length) {
      if (Math.hypot(pen.at[0] - pen.start[0], pen.at[1] - pen.start[1]) > 1e-9) pen.edges.push(sm.Line(pen.at, pen.start));
      pen.loops.push(pen.edges);
      pen.edges = [];
    }
    pen.at = pen.start = xy(c, 'x', 'y');
  },
  lineTo: edgeTo((sm, from, to) => sm.Line(from, to)),
  threePointsArc: edgeTo((sm, from, to, c) => sm.ThreePointArc(from, xy(c, 'midX', 'midY'), to)),
  radiusArc: edgeTo((sm, from, to, c) => sm.RadiusArc(from, to, num(c.radius))),
  sagittaArc: edgeTo((sm, from, to, c) => sm.SagittaArc(from, to, num(c.sagitta))),
  spline: (sm, c, pen) => {
    if (c.startTangent || c.endTangent || c.tension) throw new Unsupported('Splines with tangents or tension are not supported natively yet.');
    const pts = (c.points as Record<string, unknown>[]).map(pt => xy(pt, 'x', 'y'));
    pen.edges.push(sm.Spline(pen.at, ...pts));
    pen.at = pts.at(-1)!;
  },
  close: (sm, _c, pen) => {
    pen.closed = true;
    if (Math.hypot(pen.at[0] - pen.start[0], pen.at[1] - pen.start[1]) > 1e-9) pen.edges.push(sm.Line(pen.at, pen.start));
    pen.at = pen.start;
  },
};

/** The `part_*` inputs in numeric key order; each must be a native solid. */
function nativeAssemblyParts(inputs: ResolvedInputs): SmlibBackend[] {
  const entries = Object.entries(inputs.byKey).filter(([key]) => key.startsWith('part_')).sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }));
  return entries.map(([key, shape]) => {
    if (isSceneBackend(shape) || !(shape instanceof SmlibBackend)) throw new Unsupported(`Assembly part '${key}' is not a native SMLib solid.`);
    return shape;
  });
}

/** One mate-free assembly part: its solid at identity, with the source colour and material. */
function scenePartAtIdentity(shape: SmlibBackend, partId: FeatureId, records: readonly FeatureRecord[]): SceneBackendPart {
  const rec = records.find(x => x.id === partId);
  const color = rec ? lookupSourceColor(rec, records) : undefined;
  const material = rec ? lookupSourceMaterial(rec, records) : undefined;
  return { name: (rec?.metadata as { partName?: string } | undefined)?.partName ?? partId, shape, worldTransform: Transform.identity(), ...(color !== undefined ? { color } : {}), ...(material !== undefined ? { material } : {}) };
}

export class NativeSmlibLowerer implements FeatureLowerer {
  readonly target: BackendTarget = 'export-smlib';
  readonly supports: ReadonlySet<FeatureKind> = new Set(NATIVE_SMLIB_KINDS);

  async lower(r: FeatureRecord, inputs: ResolvedInputs): Promise<LowerResult> {
    const sm = await loadSmlib();
    try {
      if (!this.supports.has(r.kind)) throw new Unsupported(`Feature '${r.kind}' has no native SMLib implementation yet.`);
      if (r.kind === 'assemblyModel') return this.assemblyModel(r, inputs);
      let shape = this.build(sm, r, inputs);
      if (!(shape instanceof SmlibSketchBackend)) shape = this.applyTransforms(shape, r);
      else if (r.transforms.length) throw new Unsupported('Transforms on a sketch are not supported natively; transform the solid instead.');
      return { shape, diagnostics: [] };
    } catch (e) {
      const unsupported = e instanceof Unsupported, crossing = e instanceof CrossingOutline;
      const diagnostic: CompilerDiagnostic = withNextAction({
        target: this.target,
        featureId: r.id,
        severity: 'error',
        code: unsupported ? 'recompute.kernel.unsupported-feature' : 'recompute.lowering.exception',
        message: unsupported || crossing ? (e as Error).message : `SMLib could not build ${r.kind}: ${e instanceof Error ? e.message : String(e)}`,
        hint: unsupported
          ? "Change the model, or select kernel: 'occt' explicitly (OpenCASCADE is LGPL-2.1)."
          : crossing
            ? 'Reorder the outline\'s points so that no two edges cross, or draw each region as its own closed loop. (OpenCASCADE builds such an outline as an invalid solid whose volume is the signed area.)'
            : 'Read the kernel message; check dimensions and inputs.',
      });
      return { shape: undefined as unknown as ShapeBackend, diagnostics: [diagnostic] };
    }
  }

  private solid(sm: Smlib, part: Part): SmlibBackend { return new SmlibBackend(sm, part); }

  private input(inputs: ResolvedInputs, key: string): SmlibBackend {
    const shape = inputs.byKey[key];
    if (!(shape instanceof SmlibBackend)) throw new Unsupported(`Input '${key}' is not a native SMLib solid.`);
    return shape;
  }

  private sketchOf(inputs: ResolvedInputs, key = 'sketch'): SmlibSketchBackend {
    const shape = inputs.byKey[key];
    if (!(shape instanceof SmlibSketchBackend)) throw new Unsupported(`Input '${key}' is not a native sketch profile (got ${shape === undefined ? 'nothing' : (shape as object).constructor?.name}).`);
    return shape;
  }

  private build(sm: Smlib, r: FeatureRecord, inputs: ResolvedInputs): ShapeBackend {
    const builder = this.builders[r.kind];
    if (!builder) throw new Unsupported(`Feature '${r.kind}' has no native SMLib implementation yet.`);
    return builder(sm, r, inputs, (name: string) => num(r.params[name]));
  }

  private readonly builders: Partial<Record<FeatureKind, Builder>> = {
    // Like OCCT, a negative dimension spans [d, 0] instead of [0, d].
    box: (sm, _r, _i, p) => {
      const part = sm.Box(Math.abs(p('x')), Math.abs(p('y')), Math.abs(p('z')));
      return this.solid(sm, p('centered') > 0.5 ? part : part.translate([p('x') / 2, p('y') / 2, p('z') / 2]));
    },
    cylinder: (sm, _r, _i, p) => this.solid(sm, sm.Cylinder(p('r'), p('h')).translate([0, 0, p('h') / 2])),
    sphere: (sm, _r, _i, p) => this.solid(sm, sm.Sphere(p('r'))),
    sketch: (sm, r) => this.sketch(sm, r),
    extrude: (sm, r, inputs) => this.extrude(sm, r, inputs),
    // Sketch x is the radius and sketch y the height: map sketch Y onto world Z, revolve about Z.
    revolve: (sm, _r, inputs, p) => this.solid(sm, sm.revolve(this.sketchOf(inputs).sketch.rotate(sm.Axis.X, 90), sm.Axis.Z, p('angleDeg'))),
    loft: (sm, r, inputs, p) => this.loft(sm, r, inputs, p),
    sweep: (sm, r, inputs) => this.sweep(sm, r, inputs),
    boolean: (sm, r, inputs) => this.boolean(sm, r, inputs),
    fillet: (sm, r, inputs, p) => this.round(sm, r, inputs, p),
    chamfer: (sm, r, inputs, p) => this.round(sm, r, inputs, p),
    shell: (sm, r, inputs, p) => {
      const base = this.input(inputs, 'base').part;
      const openings = Object.keys(r.inputs).filter(k => k === 'face' || /^face_\d+$/.test(k)).map(k => this.face(base, r, k));
      return this.solid(sm, sm.shell(base, -p('thickness'), openings.length ? openings : null));
    },
    hole: (sm, r, inputs) => this.holes(sm, r, inputs),
    holes: (sm, r, inputs) => this.holes(sm, r, inputs),
    pattern: (sm, r, inputs) => this.pattern(sm, r, inputs),
    assemblyPart: (_sm, r, inputs) => {
      const source = this.input(inputs, 'shape');
      const resolved = inputs.resolveRecord ? inputs.resolveRecord(r) : r;
      const at = resolvedPartAt((resolved.metadata as { at?: Vec3Param } | undefined)?.at, inputs.resolveRecord ? undefined : inputs.paramTable);
      return at.some(v => v !== 0) ? source.translate(at[0], at[1], at[2]) : source;
    },
    mirror: (sm, r, inputs) => {
      const base = this.input(inputs, 'base');
      const { normal, origin } = this.planeNormal(r.metadata?.plane);
      return this.solid(sm, base.part.fuse(base.reflect(normal, origin).part));
    },
  };

  private loft(sm: Smlib, r: FeatureRecord, inputs: ResolvedInputs, p: Param): SmlibBackend {
    if (r.params.twistDeg && p('twistDeg') !== 0) throw new Unsupported('Twisted lofts are not supported natively.');
    if (Array.isArray(r.metadata?.rails) && r.metadata.rails.length) throw new Unsupported('Lofts with rails are not supported natively.');
    const keys = Object.keys(inputs.byKey).filter(k => /^sketch_\d+$/.test(k)).sort((a, b) => Number(a.slice(7)) - Number(b.slice(7)));
    const planes = r.metadata?.planes as { plane?: string; origin?: unknown[]; rotationDeg?: unknown }[] | undefined;
    if (planes?.some(pl => pl.plane && !['XY', 'YZ', 'XZ'].includes(pl.plane))) throw new Unsupported('Loft sections on planes other than XY, YZ and XZ are not supported natively.');
    if (planes?.some(pl => pl.rotationDeg !== undefined && num(pl.rotationDeg) !== 0)) throw new Unsupported('Rotated loft sections are not supported natively.');
    const planeOf = (i: number) => (planes?.length === keys.length ? planes[i] : planes?.length === keys.length - 1 ? (i === 0 ? undefined : planes[i - 1]) : undefined);
    const originOf = (i: number): unknown[] => (planes?.length === keys.length || planes?.length === keys.length - 1 ? planeOf(i)?.origin ?? [0, 0, 0] : [0, 0, i * p('spacing')]);
    // Sketch (x, y) onto replicad's planes: YZ is (y, z) = (x, y), XZ is (x, z) = (x, y).
    const onPlane = (sk: Sketch, plane: string | undefined): Sketch => {
      if (plane === 'YZ') return sk.rotate(sm.Axis.X, 90).rotate(sm.Axis.Z, 90);
      if (plane === 'XZ') return sk.rotate(sm.Axis.X, 90);
      return sk;
    };
    const sketches = keys.map(k => this.sketchOf(inputs, k));
    const sections = sketches.map((s, i) => onPlane(s.sketch, planeOf(i)?.plane).translate(originOf(i).map(num) as Vec3));
    const ruled = p('ruled') > 0.5;
    // Single-loop sections loft through their outlines as drawn (see SmlibSketchBackend.outline):
    // vertex i of one section joins vertex i of the next, as in OCCT's ThruSections.
    const outlines = sketches.every(s => s.outline)
      ? sketches.map((s, i) => onPlane(s.outline as never, planeOf(i)?.plane).translate(originOf(i).map(num) as Vec3) as unknown as Wire)
      : undefined;
    // Polygons with different vertex counts: insert vertices and pair them as OCCT does.
    const equalised = this.equalisedPolygons(sm, sketches, i => planeOf(i)?.plane, i => originOf(i).map(num) as Vec3);
    let part = sm.loft(equalised ?? outlines ?? sections, { ruled }) as Part;
    // startPoint / endPoint: the loft runs on from the first / last section to an apex.
    const apex = (key: 'startPoint' | 'endPoint') => r.metadata?.[key] as unknown[] | undefined;
    for (const [key, section] of [['startPoint', sections[0]], ['endPoint', sections.at(-1)!]] as const) {
      const point = apex(key);
      if (!point) continue;
      if (!ruled) throw new Unsupported('Smooth lofts to a start or end point are not supported natively (ruled ones are).');
      part = part.fuse(pyramid(sm, section, point.map(num) as Vec3));
    }
    return this.solid(sm, part);
  }

  /** Loft sections that are all straight-edged single loops with different vertex counts, as
   *  wires with equal counts paired the way OCCT's ThruSections pairs them (compatibleSections.ts);
   *  undefined otherwise. */
  private equalisedPolygons(sm: Smlib, sketches: readonly SmlibSketchBackend[], plane: (i: number) => string | undefined, origin: (i: number) => Vec3): Wire[] | undefined {
    if (!sketches.every(s => s.polygon)) return undefined;
    // Sketch (x, y) onto replicad's planes, as onPlane does: YZ is (0, x, y), XZ is (x, 0, y).
    const placed = sketches.map((s, i) => {
      const pl = plane(i), o = origin(i);
      return s.polygon!.map(([x, y]): P3 => (pl === 'YZ' ? [o[0], o[1] + x, o[2] + y] : pl === 'XZ' ? [o[0] + x, o[1], o[2] + y] : [o[0] + x, o[1] + y, o[2]]));
    });
    // `.kcad.ts` lofts mean what OCCT's ThruSections builds from them: pair the sections as it does.
    const equal = compatibleSections(placed, 'closest');
    if (!equal) throw new Error('The loft sections cannot be matched vertex to vertex (OpenCASCADE fails on them too).');
    return equal.map(pts => new sm.Wire(pts.map((p, k) => sm.Line([...p] as Vec3, [...pts[(k + 1) % pts.length]!] as Vec3))));
  }

  private sweep(sm: Smlib, r: FeatureRecord, inputs: ResolvedInputs): SmlibBackend {
    if (r.metadata?.spine === 'helix') return this.helicalSweep(sm, r, inputs);
    const rail = r.metadata?.rail as unknown[][] | undefined;
    if (!Array.isArray(rail) || rail.length < 2 || r.metadata?.spine !== 'polyline') throw new Unsupported("Only polyline and helix sweep rails are supported natively ('smooth' spines are not yet).");
    const points = rail.map(pt => pt.map(num) as Vec3);
    const path = points.length === 2 ? sm.Line(points[0], points[1]) : sm.Polyline(points);
    return this.solid(sm, sm.sweep(this.sketchOf(inputs).sketch, path));
  }

  /** `spine: 'helix'`, as OCCT's sweepProfileAlongHelix (kernel/backends/occt/helicalSweep.ts):
   *  the exact helix x = R cos(t + a), y = R sin(t + a), z = pitch t / 2 pi about Z (axis X and
   *  Y permute those coordinates as helix() does). 'axial': sketch x is the radial offset from
   *  the start point, y the axial offset, moved by screw motion. 'transverse': the sketch is the
   *  cross-section on the axis (x towards the start angle), a twisted extrusion of one turn per
   *  pitch (SMLib's twist deformation). Built about Z with a = 0, then turned by a and mapped
   *  onto the helix axis. */
  private helicalSweep(sm: Smlib, r: FeatureRecord, inputs: ResolvedInputs): SmlibBackend {
    const spec = r.metadata?.helix as HelixRailSpec | undefined;
    if (!spec) throw new Unsupported("A 'helix' sweep needs the helix() rail's dimensions.");
    const { radius, pitch, turns, startAngle = 0, axis = 'Z' } = helixOptionsFromSpec(spec);
    if (!(radius > 0 && pitch > 0 && turns > 0)) throw new Error(`helical sweep: radius, pitch and turns must be positive (got ${radius}, ${pitch}, ${turns}).`);
    const sketch = this.sketchOf(inputs).sketch, height = pitch * turns;
    let part: Part;
    if ((r.metadata as { section?: unknown }).section === 'transverse') {
      // OCCT's frame for axis Y is (x, y) -> x X - y Z; the y <-> z mirror below gives x X + y Z,
      // so the section is flipped first.
      const section = axis === 'Y' ? sketch.mirror(new sm.Plane([0, 0, 0], undefined, [0, 1, 0])) : sketch;
      part = sm.twist(sm.extrude(section, height), 360 * turns);
    } else {
      const b = sketch.bbox();
      if (radius + b.min.x <= 0) throw new Error('helical sweep: the profile crosses the helix axis (keep radius + min(x) > 0).');
      if (b.max.y - b.min.y >= pitch - 1e-6) throw new Error(`helical sweep: the profile spans ${(b.max.y - b.min.y).toFixed(4)} mm along the axis, not below the pitch ${pitch} mm.`);
      // SMLib's sweep turns a profile that is not square to the path, so the screw motion is a
      // smooth loft through screw-moved copies of the axial section, HELIX_SECTIONS_PER_TURN per
      // turn (volume within about 1e-6 of the closed form; OCCT's helix spine is also fitted).
      const placed = sketch.rotate(sm.Axis.X, 90).translate([radius, 0, 0]); // (x, y) -> (R + x, 0, y)
      const n = Math.max(2, Math.ceil(turns * HELIX_SECTIONS_PER_TURN));
      part = sm.loft(Array.from({ length: n + 1 }, (_, i) => placed.rotate(sm.Axis.Z, (360 * turns * i) / n).translate([0, 0, (height * i) / n])), { ruled: false });
    }
    if (startAngle) part = part.rotate(sm.Axis.Z, (startAngle * 180) / Math.PI);
    if (axis === 'X') part = part.rotate(new sm.Axis([0, 0, 0], [1, 1, 1]), 120); // x, y, z -> y, z, x
    else if (axis === 'Y') part = part.mirror(new sm.Plane([0, 0, 0], undefined, [0, 1, -1])); // y <-> z
    return this.solid(sm, part);
  }

  private boolean(sm: Smlib, r: FeatureRecord, inputs: ResolvedInputs): SmlibBackend {
    const op = word(r.params.op);
    const combine: Record<string, (a: Part, b: Part) => Part> = { union: (a, b) => a.fuse(b), difference: (a, b) => a.cut(b), intersection: (a, b) => a.intersect(b) };
    if (!combine[op]) throw new Unsupported(`Boolean '${op}' is not supported natively.`);
    const cutters = Object.keys(inputs.byKey).filter(k => k.startsWith('cutter_')).sort();
    return this.solid(sm, cutters.reduce((acc, key) => combine[op](acc, this.input(inputs, key).part), this.input(inputs, 'base').part));
  }

  private round(sm: Smlib, r: FeatureRecord, inputs: ResolvedInputs, p: Param): SmlibBackend {
    if (r.metadata?.variable || (r.metadata?.continuity && r.metadata.continuity !== 'G1')) throw new Unsupported('Variable or G2 fillets are not supported natively.');
    const edges = this.edges(this.input(inputs, 'base').part, r);
    return this.solid(sm, r.kind === 'fillet' ? sm.fillet(edges, p('radius'), { propagate: false }) : sm.chamfer(edges, p('distance')));
  }

  /** `assembly(...).model()`: mate-free parts stay at identity; mated parts are
   *  placed by the shared mate solver (`lowerAssemblyModel`), which needs only
   *  connector frames and part placements, so the result matches OCCT exactly. */
  private assemblyModel(r: FeatureRecord, inputs: ResolvedInputs): LowerResult {
    const meta = r.metadata as AssemblyModelMeta | undefined;
    const entries = nativeAssemblyParts(inputs);
    if (meta && (meta.mates?.length || meta.couplings?.length)) return this.matedAssemblyModel(r, inputs, meta);
    const partIds = meta?.partIds ?? [];
    if (entries.length !== partIds.length) throw new Error(`assemblyModel: ${entries.length} part inputs for ${partIds.length} part ids`);
    const records = inputs.records ?? [];
    const parts = entries.map((shape, i) => scenePartAtIdentity(shape, partIds[i], records));
    const scene: SceneBackend = { target: this.target, assemblyName: meta?.assemblyName ?? 'assembly', parts, _kind: 'scene' };
    return { shape: scene as unknown as ShapeBackend, diagnostics: [] };
  }

  /** Mated parts are placed by the shared mate solver; it reads connector frames
   *  only, so topology-placed connectors (which need face queries) are refused. */
  private matedAssemblyModel(r: FeatureRecord, inputs: ResolvedInputs, meta: AssemblyModelMeta): LowerResult {
    const topology = Object.values(meta.connectorsByPartId ?? {}).flat().find(c => c.origin.kind !== 'vec3');
    if (topology) throw new Unsupported(`Connector '${topology.name}' is placed by a topology query; native assemblies need numeric connector origins.`);
    const diagnostics: CompilerDiagnostic[] = [];
    const ctx = { target: this.target, inputs, allRecords: inputs.records, diagnostics, importedGeometry: new Map(), surfaceCache: new Map() };
    return { shape: lowerAssemblyModel(ctx, r).shape, diagnostics };
  }

  private sketch(sm: Smlib, r: FeatureRecord): SmlibSketchBackend {
    if (typeof r.metadata?.textContent === 'string') throw new Unsupported('Text sketches are not supported natively yet.');
    const commands = r.metadata?.commands as SketchCommand[] | undefined;
    if (!Array.isArray(commands) || !commands.length) throw new Unsupported('Sketch has no path commands.');
    const pen: Pen = { at: [0, 0, 0], start: [0, 0, 0], closed: false, edges: [], loops: [] };
    for (const c of commands) {
      const step = SKETCH_STEPS[c.kind];
      if (!step) throw new Unsupported(`Sketch command '${c.kind}' is not supported natively yet.`);
      step(sm, c, pen);
    }
    if (!pen.closed) throw new Unsupported('Open sketch paths are not supported natively yet.');
    // Largest region first: SMLib's xor of a hole with its outer region inverts the faces.
    const loops = [...pen.loops, pen.edges].filter(l => l.length);
    for (const loop of loops) refuseCrossing('sketch outline', loopOutline(loop));
    const faces = loops.map(l => sm.makeFace(new sm.Wire(l))).sort((a, b) => b.area - a.area);
    const single = loops.length === 1 ? loops[0] : undefined;
    const outline = single ? loopOutline(single) : undefined;
    const polygon = single && outline!.length === single.length ? outline!.map(([x, y]) => [x, y, 0] as Vec3) : undefined;
    return new SmlibSketchBackend(faces.length === 1 ? faces[0] : sm.xor(faces[0], ...faces.slice(1)), true, single ? new sm.Wire(single) : undefined, polygon);
  }

  private extrude(sm: Smlib, r: FeatureRecord, inputs: ResolvedInputs): SmlibBackend {
    const p = (name: string) => num(r.params[name]);
    if (r.params.twistAngle && p('twistAngle') !== 0) throw new Unsupported('Twisted extrusions are not supported natively.');
    if (r.params.taperDeg && p('taperDeg') !== 0) throw new Unsupported('Tapered extrusions are not supported natively.');
    if (inputs.byKey.sketch) return this.solid(sm, sm.extrude(this.sketchOf(inputs).sketch, p('depth')));
    if (word(r.params.profileKind) === 'rounded-rect') return this.roundedRect(sm, r, p);
    return this.solid(sm, sm.extrude(...this.inlineProfile(sm, r, p)));
  }

  /** Profile and depth of an extrusion given by points, w/h or r. */
  private inlineProfile(sm: Smlib, r: FeatureRecord, p: Param): [Sketch, number] {
    if (Array.isArray(r.metadata?.points)) {
      // A self-touching outline is split into simple loops, filled even-odd (polygonLoops.ts);
      // one that crosses itself is refused (profileCrossing.ts).
      const loops = polygonLoops((r.metadata.points as unknown[][]).map(pt => [num(pt[0]), num(pt[1])] as [number, number]));
      if (!loops.length) throw new Error('The polygon profile encloses no area.');
      for (const loop of loops) refuseCrossing('polygon outline', loop);
      const faces = loops.map(l => sm.Polygon(...(l as [number, number][]), { align: null }));
      return [faces.length === 1 ? faces[0] : sm.xor(faces[0], ...faces.slice(1)), p('depth')];
    }
    if (r.params.w && r.params.h) return [sm.Rectangle(p('w'), p('h')), p('height')];
    if (r.params.r && r.params.height) return [sm.Circle(p('r')), p('height')];
    throw new Unsupported('This extrusion profile is not supported natively.');
  }

  /** Same as OCCT: radius clamped below half the short side; axis rotations match extrudeRoundedRectShape. */
  private roundedRect(sm: Smlib, r: FeatureRecord, p: Param): SmlibBackend {
    const radius = Math.min(Math.max(0, p('radius')), Math.min(p('width'), p('height')) / 2 * 0.9999);
    const body = sm.extrude(radius > 0 ? sm.RoundedRectangle(p('width'), p('height'), radius) : sm.Rectangle(p('width'), p('height')), p('depth'));
    const orient: Record<string, () => Part> = {
      z: () => body,
      x: () => body.rotate(new sm.Axis([0, 0, 0], [1, 1, 1]), 120),
      y: () => body.rotate(sm.Axis.X, -90),
    };
    const axis = word(r.params.axis) || 'z';
    if (!orient[axis]) throw new Unsupported(`Extrusion axis '${axis}' is not supported.`);
    return this.solid(sm, orient[axis]());
  }

  /** Planar face of `base` matching a canonical selector (top/bottom/left/right/front/back). */
  private face(base: Part, r: FeatureRecord, key: string): Face {
    const ref = (r.inputs[key] as { ref?: { kind?: string; face?: string } } | undefined)?.ref;
    if (ref?.kind !== 'canonical' || !ref.face || !CANONICAL_NORMALS[ref.face]) throw new Unsupported(`Face selector ${JSON.stringify(ref)} is not supported natively; use top/bottom/left/right/front/back.`);
    const n = CANONICAL_NORMALS[ref.face];
    const extreme = (f: Face) => { const c = f.center(); return c.x * n[0] + c.y * n[1] + c.z * n[2]; };
    const candidates = [...base.faces()].filter(f => { const d = f.normalAt(); return d.x * n[0] + d.y * n[1] + d.z * n[2] > 1 - 1e-9; });
    if (!candidates.length) throw new Unsupported(`No planar ${ref.face} face found.`);
    return candidates.sort((a, b) => extreme(b) - extreme(a))[0];
  }

  private edges(base: Part, r: FeatureRecord): Edge[] {
    if (r.inputs.face) return [...this.face(base, r, 'face').edges()];
    const edgeRef = (r.inputs.edges as { ref?: { kind?: string; query?: { edges?: string } } } | undefined)?.ref;
    if (!edgeRef) return [...base.edges()];
    if (edgeRef.kind === 'query' && typeof edgeRef.query?.edges === 'string' && CANONICAL_NORMALS[edgeRef.query.edges]) {
      return [...this.face(base, { ...r, inputs: { ...r.inputs, face: { kind: 'face', featureId: '', ref: { kind: 'canonical', face: edgeRef.query.edges } } } } as FeatureRecord, 'face').edges()];
    }
    throw new Unsupported(`Edge selector ${JSON.stringify(edgeRef)} is not supported natively; select all edges or a canonical face's edges.`);
  }

  /** Holes on a canonical planar face. The (u, v) frame is OCCT's (holeLowerer buildUvBasis):
   *  top/bottom u = X, v = Y (v mirrored on the bottom, as before); left/right u = Y, v = Z;
   *  front/back u = X, v = Z; origin at the face's area centroid. */
  private holes(sm: Smlib, r: FeatureRecord, inputs: ResolvedInputs): SmlibBackend {
    const p = (name: string) => num(r.params[name]);
    const target = this.input(inputs, 'target').part;
    const face = this.face(target, r, 'face'), c = face.center(), nr = face.normalAt();
    const n: Vec3 = [nr.x, nr.y, nr.z];
    const axis = n.findIndex(v => Math.abs(v) > 1 - 1e-9);
    if (axis < 0) throw new Unsupported('Native holes are drilled from axis-aligned planar faces only.');
    const sign = Math.sign(n[axis]);
    const [uAxis, vAxis] = axis === 2 ? [0, 1] : axis === 0 ? [1, 2] : [0, 2];
    const vSign = axis === 2 && sign < 0 ? -1 : 1;
    const box = target.bbox(), through = r.params.depthMode !== undefined && p('depthMode') === 0;
    const lo = [box.min.x, box.min.y, box.min.z], hi = [box.max.x, box.max.y, box.max.z];
    const span = hi[axis] - lo[axis] + 2;
    const positions = r.kind === 'holes' ? (r.metadata?.positions as { u: unknown; v: unknown }[]).map(q => [num(q.u), num(q.v)]) : [[p('u'), p('v')]];
    // A Z cylinder turned onto the drill axis (the turn is symmetric for a centred cylinder).
    const orient = (part: Part) => (axis === 2 ? part : part.rotate(axis === 0 ? sm.Axis.Y : sm.Axis.X, 90));
    let acc = target;
    for (const [u, v] of positions) {
      const entry: Vec3 = [c.x, c.y, c.z];
      entry[uAxis] += u; entry[vAxis] += v * vSign;
      const drill = (radius: number, length: number) => {
        const centre = [...entry] as Vec3;
        centre[axis] -= sign * (length - 1) / 2; // from 1 above the face to `length` into the body
        return orient(sm.Cylinder(radius, length + 1)).translate(centre);
      };
      acc = acc.cut(drill(p('diameter') / 2, through ? span : p('depth')));
      if (r.params.counterboreDiameter) acc = acc.cut(drill(p('counterboreDiameter') / 2, p('counterboreDepth')));
      if (r.params.countersinkDiameter) throw new Unsupported('Countersinks are not supported natively yet.');
    }
    return this.solid(sm, acc);
  }

  private pattern(sm: Smlib, r: FeatureRecord, inputs: ResolvedInputs): SmlibBackend {
    const base = this.input(inputs, 'base').part;
    const spec = r.metadata?.pattern as Record<string, unknown> | undefined;
    let copies: Part[];
    if (spec?.kind === 'circular') copies = circularCopies(sm, base, spec);
    else if (spec?.kind === 'linear' || spec?.kind === 'grid') copies = linearOffsets(spec).map(o => (o.every(v => v === 0) ? base : base.translate(o)));
    else throw new Unsupported(`Pattern ${JSON.stringify(spec?.kind)} is not supported natively.`);
    return this.solid(sm, copies.reduce((a, b) => a.fuse(b)));
  }

  private planeNormal(plane: unknown): { normal: Vec3; origin: Vec3 } {
    const spec = typeof plane === 'string' ? { plane, offset: 0 } : (plane as { plane: string; offset?: number } | undefined);
    const normal: Vec3 | undefined = spec?.plane === 'xy' ? [0, 0, 1] : spec?.plane === 'xz' ? [0, 1, 0] : spec?.plane === 'yz' ? [1, 0, 0] : undefined;
    if (!normal) throw new Unsupported(`Mirror plane ${JSON.stringify(plane)} is not supported natively.`);
    const offset = num(spec!.offset ?? 0);
    return { normal, origin: normal.map(c => c * offset) as Vec3 };
  }

  private applyTransforms(shape: ShapeBackend, r: FeatureRecord): ShapeBackend {
    let out = shape as SmlibBackend;
    for (const t of r.transforms) {
      if (t.op === 'translate') out = out.translate(t.vec.x.evaluated, t.vec.y.evaluated, t.vec.z.evaluated) as SmlibBackend;
      else if (t.op === 'rotateAxis') out = out.rotate([t.axis.x.evaluated, t.axis.y.evaluated, t.axis.z.evaluated], t.degrees.evaluated, t.pivot ? [t.pivot.x.evaluated, t.pivot.y.evaluated, t.pivot.z.evaluated] : undefined) as SmlibBackend;
      else if (t.op === 'scale') out = out.scale([num(t.sx), num(t.sy), num(t.sz)]) as SmlibBackend;
      else if (t.op === 'reflect') { const { normal, origin } = this.planeNormal(t.plane); out = out.reflect(normal, origin); }
      else throw new Unsupported(`Transform '${(t as { op: string }).op}' is not supported natively.`);
    }
    return out;
  }
}

/** The solid from a planar polygon section (straight edges, holes allowed) to an apex point. */
function pyramid(sm: Smlib, section: Sketch, apex: Vec3): Part {
  const sides = [...section.edges()].map(e => {
    if (e.geomType !== 'line') throw new Unsupported('A loft to a start or end point needs straight-edged sections natively.');
    const a = e.start, b = e.end;
    return sm.makeFace(sm.Polyline([a.x, a.y, a.z], [b.x, b.y, b.z], apex, [a.x, a.y, a.z]));
  });
  const body = sm.stitch(section, ...sides);
  if (!(body instanceof sm.Part) || !body.isValid()) throw new Error('loft apex: the pyramid to the start or end point does not close.');
  return body;
}

function circularCopies(sm: Smlib, base: Part, spec: Record<string, unknown>): Part[] {
  const count = num(spec.count), angle = num(spec.angleDeg ?? 360), axis = (spec.axis as unknown[] ?? [0, 0, 1]).map(num) as Vec3;
  const step = Math.abs(angle - 360) < 1e-9 ? 360 / count : angle / Math.max(1, count - 1);
  return Array.from({ length: count }, (_, i) => (i === 0 ? base : base.rotate(new sm.Axis([0, 0, 0], axis), i * step)));
}

/** Offsets of a linear pattern, or the product of a grid's x and y axes. */
function linearOffsets(spec: Record<string, unknown>): Vec3[] {
  const axes = (spec.kind === 'linear' ? [spec] : [spec.x, spec.y].filter(Boolean)) as Record<string, unknown>[];
  let offsets: Vec3[] = [[0, 0, 0]];
  for (const a of axes) {
    const dir = (a.direction as unknown[]).map(num), len = Math.hypot(...dir), count = num(a.count), spacing = num(a.spacing);
    offsets = offsets.flatMap(o => Array.from({ length: count }, (_, i) => o.map((v, k) => v + dir[k] / len * spacing * i) as Vec3));
  }
  return offsets;
}

export const createNativeSmlibLowerer = (): NativeSmlibLowerer => new NativeSmlibLowerer();
