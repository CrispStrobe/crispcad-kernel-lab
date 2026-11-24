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
import { isSceneBackend, type SceneBackend, type SceneBackendPart } from '../../../kernel/backends/sceneBackend';
import { lookupSourceColor, lookupSourceMaterial } from '../../../kernel/backends/occt/lookupSourceColor';
import { resolvedPartAt } from '../../mates/partFrame';
import { Transform } from '../../../shared/runtime/se3';
import type { FeatureId, Vec3Param } from '../../../shared/intent/types';

type Smlib = typeof import('@classcad/smlibwasm');
type Part = InstanceType<Smlib['Part']>;
type Sketch = ReturnType<Smlib['makeFace']>;
type Edge = InstanceType<Smlib['Edge']>;
type Face = InstanceType<Smlib['Face']>;

class Unsupported extends Error {}

type Param = (name: string) => number;
type Builder = (sm: Smlib, r: FeatureRecord, inputs: ResolvedInputs, p: Param) => ShapeBackend;

/** A lowered 2D sketch: consumed by extrude/revolve/loft/sweep, not a solid. */
export class SmlibSketchBackend implements ShapeBackend {
  readonly target: BackendTarget = 'export-smlib';
  readonly sketch: Sketch;
  readonly closed: boolean;
  constructor(sketch: Sketch, closed: boolean) {
    this.sketch = sketch;
    this.closed = closed;
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
interface Pen { at: Vec3; start: Vec3; closed: boolean; edges: Edge[] }
const xy = (c: Record<string, unknown>, x: string, y: string): Vec3 => [num(c[x]), num(c[y]), 0];
/** Append one edge ending at the command's (x, y). */
const edgeTo = (make: (sm: Smlib, from: Vec3, to: Vec3, c: SketchCommand) => Edge) => (sm: Smlib, c: SketchCommand, pen: Pen) => {
  const next = xy(c, 'x', 'y');
  pen.edges.push(make(sm, pen.at, next, c));
  pen.at = next;
};
const SKETCH_STEPS: Record<string, (sm: Smlib, c: SketchCommand, pen: Pen) => void> = {
  moveTo: (_sm, c, pen) => {
    if (pen.edges.length) throw new Unsupported('Sketches with several loops are not supported natively yet.');
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

export class NativeSmlibLowerer implements FeatureLowerer {
  readonly target: BackendTarget = 'export-smlib';
  readonly supports: ReadonlySet<FeatureKind> = new Set(NATIVE_SMLIB_KINDS);

  async lower(r: FeatureRecord, inputs: ResolvedInputs): Promise<LowerResult> {
    const sm = await loadSmlib();
    try {
      if (!this.supports.has(r.kind)) throw new Unsupported(`Feature '${r.kind}' has no native SMLib implementation yet.`);
      if (r.kind === 'assemblyModel') return { shape: this.assemblyModel(r, inputs) as unknown as ShapeBackend, diagnostics: [] };
      let shape = this.build(sm, r, inputs);
      if (!(shape instanceof SmlibSketchBackend)) shape = this.applyTransforms(shape, r);
      else if (r.transforms.length) throw new Unsupported('Transforms on a sketch are not supported natively; transform the solid instead.');
      return { shape, diagnostics: [] };
    } catch (e) {
      const unsupported = e instanceof Unsupported;
      const diagnostic: CompilerDiagnostic = withNextAction({
        target: this.target,
        featureId: r.id,
        severity: 'error',
        code: unsupported ? 'recompute.kernel.unsupported-feature' : 'recompute.lowering.exception',
        message: unsupported ? (e as Error).message : `SMLib could not build ${r.kind}: ${e instanceof Error ? e.message : String(e)}`,
        hint: unsupported
          ? "Change the model, or select kernel: 'occt' explicitly (OpenCASCADE is LGPL-2.1)."
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
    const planes = r.metadata?.planes as { plane?: string; origin?: unknown[] }[] | undefined;
    if (planes?.some(pl => pl.plane && pl.plane !== 'XY')) throw new Unsupported('Loft sections on planes other than XY are not supported natively.');
    const originOf = (i: number): unknown[] => {
      if (planes?.length === keys.length) return planes[i].origin ?? [0, 0, 0];
      if (planes?.length === keys.length - 1) return i === 0 ? [0, 0, 0] : planes[i - 1].origin ?? [0, 0, 0];
      return [0, 0, i * p('spacing')];
    };
    const sections = keys.map((k, i) => this.sketchOf(inputs, k).sketch.translate(originOf(i).map(num) as Vec3));
    return this.solid(sm, sm.loft(sections, { ruled: p('ruled') > 0.5 }));
  }

  private sweep(sm: Smlib, r: FeatureRecord, inputs: ResolvedInputs): SmlibBackend {
    const rail = r.metadata?.rail as unknown[][] | undefined;
    if (!Array.isArray(rail) || rail.length < 2 || r.metadata?.spine !== 'polyline') throw new Unsupported('Only straight-segment (polyline) sweep rails are supported natively.');
    const points = rail.map(pt => pt.map(num) as Vec3);
    const path = points.length === 2 ? sm.Line(points[0], points[1]) : sm.Polyline(points);
    return this.solid(sm, sm.sweep(this.sketchOf(inputs).sketch, path));
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

  /** Mate-free `assembly(...).model()`: one scene part per assembly part, at identity. */
  private assemblyModel(r: FeatureRecord, inputs: ResolvedInputs): SceneBackend {
    const meta = r.metadata as { assemblyName?: string; partIds?: FeatureId[]; mates?: unknown[]; couplings?: unknown[] } | undefined;
    if (meta?.mates?.length || meta?.couplings?.length) throw new Unsupported('Assemblies with mates are not supported natively yet.');
    const entries = Object.entries(inputs.byKey).filter(([key]) => key.startsWith('part_')).sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }));
    const partIds = meta?.partIds ?? [];
    if (entries.length !== partIds.length) throw new Error(`assemblyModel: ${entries.length} part inputs for ${partIds.length} part ids`);
    const records = inputs.records ?? [];
    const parts: SceneBackendPart[] = entries.map(([key, shape], i) => {
      if (isSceneBackend(shape) || !(shape instanceof SmlibBackend)) throw new Unsupported(`Assembly part '${key}' is not a native SMLib solid.`);
      const rec = records.find(x => x.id === partIds[i]);
      const color = rec ? lookupSourceColor(rec, records) : undefined;
      const material = rec ? lookupSourceMaterial(rec, records) : undefined;
      return { name: (rec?.metadata as { partName?: string } | undefined)?.partName ?? partIds[i], shape, worldTransform: Transform.identity(), ...(color !== undefined ? { color } : {}), ...(material !== undefined ? { material } : {}) };
    });
    return { target: this.target, assemblyName: meta?.assemblyName ?? 'assembly', parts, _kind: 'scene' };
  }

  private sketch(sm: Smlib, r: FeatureRecord): SmlibSketchBackend {
    if (typeof r.metadata?.textContent === 'string') throw new Unsupported('Text sketches are not supported natively yet.');
    const commands = r.metadata?.commands as SketchCommand[] | undefined;
    if (!Array.isArray(commands) || !commands.length) throw new Unsupported('Sketch has no path commands.');
    const pen: Pen = { at: [0, 0, 0], start: [0, 0, 0], closed: false, edges: [] };
    for (const c of commands) {
      const step = SKETCH_STEPS[c.kind];
      if (!step) throw new Unsupported(`Sketch command '${c.kind}' is not supported natively yet.`);
      step(sm, c, pen);
    }
    if (!pen.closed) throw new Unsupported('Open sketch paths are not supported natively yet.');
    return new SmlibSketchBackend(sm.makeFace(new sm.Wire(pen.edges)), true);
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
    if (Array.isArray(r.metadata?.points)) return [sm.Polygon(...(r.metadata.points as unknown[][]).map(pt => [num(pt[0]), num(pt[1])] as [number, number]), { align: null }), p('depth')];
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

  private holes(sm: Smlib, r: FeatureRecord, inputs: ResolvedInputs): SmlibBackend {
    const p = (name: string) => num(r.params[name]);
    const target = this.input(inputs, 'target').part;
    const face = this.face(target, r, 'face'), c = face.center(), nrm = face.normalAt();
    if (Math.abs(nrm.z) < 1 - 1e-9) throw new Unsupported('Native holes are drilled from top or bottom faces only.');
    const box = target.bbox(), through = r.params.depthMode !== undefined && p('depthMode') === 0;
    const span = box.max.z - box.min.z + 2;
    const positions = r.kind === 'holes' ? (r.metadata?.positions as { u: unknown; v: unknown }[]).map(q => [num(q.u), num(q.v)]) : [[p('u'), p('v')]];
    const down = nrm.z > 0 ? -1 : 1;
    let acc = target;
    for (const [u, v] of positions) {
      const x = c.x + u, y = c.y + v * (nrm.z > 0 ? 1 : -1);
      const depth = through ? span : p('depth');
      const drill = (radius: number, length: number) => sm.Cylinder(radius, length + 1).translate([x, y, c.z + down * (length - 1) / 2]);
      acc = acc.cut(drill(p('diameter') / 2, depth));
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
