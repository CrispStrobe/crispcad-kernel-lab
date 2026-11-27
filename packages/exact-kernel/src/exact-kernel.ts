// SPDX-License-Identifier: MIT
// Copyright (c) 2026 CrispCAD contributors
//
// Narrow exact-B-rep kernel interface. Moved from CrispCAD's experiments/exact-kernel
// (src/exact-kernel.ts, BSD-3-Clause there, by the same author) and relicensed MIT here, then
// extended with what the kernel lab's native SMLib backend uses (src/kernel/backends/smlib and
// src/modeling/backends/smlib in this repository): path profiles, loft, sweep, split, solid
// components, mass properties and STL.
//
// Solids and profiles are opaque handles, so another kernel (WASMLib, Solidcore) can implement
// the same interface. Conventions follow CAD Script, not the kernel: boxes, cylinders, cones and
// spheres are centred on the origin, extrusions start at z = 0, and revolutions turn sketch X
// (radius) / sketch Y (height) about world Z, counter-clockwise from +X.

export type Vec2 = readonly [number, number];
export type Vec3 = readonly [number, number, number];

declare const solidBrand: unique symbol;
declare const profileBrand: unique symbol;
/** An exact solid owned by one kernel. Free it with `dispose`, or build inside `scope`. */
export interface ExactSolid { readonly [solidBrand]: true; dispose(): void }
/** A closed planar region in the XY plane (outer boundary and holes). */
export interface ExactProfile { readonly [profileBrand]: true; dispose(): void }

/** The planar face whose outward normal is `faceNormal`. Exactly one face must match, unless
 * `outermost` is set: then the matching face furthest along the normal is taken (the lab's
 * canonical `top`/`bottom`/... selectors). */
export interface FaceSelector { faceNormal: Vec3; outermost?: boolean }
/** Edges by their positions in `topology(solid).edges` (since 0.1.9). The indices hold for that
 * solid only: a host that keeps a reference to an edge stores names, e.g. of the faces it bounds
 * (`nameFaces`), and resolves them to indices on the solid it is about to fillet. */
export interface EdgeIndexSelector { edgeIndices: readonly number[] }
/** Edges selected for fillet/chamfer: every edge, the edges of one planar face, or chosen edges. */
export type EdgeSelector = 'all' | FaceSelector | EdgeIndexSelector;

/** One face of a solid (see `ExactKernel.topology`). */
export interface ExactFaceInfo {
  /** Position in `topology(solid).faces` (and in the order `nameFaces` takes names). */
  index: number;
  /** The face's name (`nameFaces`), kept through later operations; null when it has none. */
  name: string | null;
  /** SMLib's surface kind: 'plane', 'cylinder', 'cone', 'sphere', 'torus', 'revolution',
   * 'extrusion', 'bspline', 'offset' or 'other'. */
  surface: string;
  area: number;
  /** A point on the face, and the outward unit normal there. */
  point: Vec3;
  normal: Vec3;
  /** Cylinder, cone (base), sphere and torus (minor) radius, and the surface's axis. */
  radius?: number;
  axis?: { origin: Vec3; direction: Vec3 };
}
/** One edge of a solid (see `ExactKernel.topology`). */
export interface ExactEdgeInfo {
  /** Position in `topology(solid).edges`: what `{ edgeIndices }` selects. */
  index: number;
  /** SMLib's curve kind: 'line', 'circle', 'ellipse', 'bspline' or 'other'. */
  curve: string;
  /** The faces the edge bounds (indices into `faces`): two for an ordinary edge. */
  faces: number[];
  length: number;
  closed: boolean;
  /** Points along the edge from its start to its end (both included): the two ends of a line,
   * up to 48 points on a curve. For display and picking, not for measuring. */
  points: Vec3[];
  /** Circular edges: radius, centre and axis. */
  radius?: number;
  center?: Vec3;
  axis?: Vec3;
}
export interface ExactTopology { faces: ExactFaceInfo[]; edges: ExactEdgeInfo[] }

export interface BoundingBox { min: [number, number, number]; max: [number, number, number] }
/** Triangle mesh; `normals` are per vertex (area-weighted). */
export interface TriangleMesh { positions: Float64Array; normals: Float64Array; indices: Uint32Array }
export interface KernelMemory { /** Bytes held by live kernel objects. */ used: number; /** WASM linear memory size (only grows). */ heap: number; /** Live kernel object handles. */ handles: number }

/** Mass properties at unit density (mm units): volume mm^3, inertia mm^5 about the centroid. */
export interface MassProperties {
  volume: number;
  centroid: [number, number, number];
  /** Inertia tensor about the centroid, world-parallel axes, symmetric. */
  inertia: [[number, number, number], [number, number, number], [number, number, number]];
  principalMoments: [number, number, number];
  /** Unit principal axes, one per moment. */
  principalAxes: [Vec3, Vec3, Vec3];
}

/** One segment of a closed path profile, continuing from the previous end point. */
export type PathSegment =
  | { kind: 'line'; to: Vec2 }
  /** Circular arc through `via`. */
  | { kind: 'arc'; via: Vec2; to: Vec2 }
  /** Circular arc of this radius; positive bulges to the left of the direction of travel. */
  | { kind: 'radiusArc'; to: Vec2; radius: number }
  /** Circular arc bulging by `sagitta` from the chord; positive bulges to the left of travel. */
  | { kind: 'sagittaArc'; to: Vec2; sagitta: number }
  /** Interpolating spline through `through` (the last point is the end). */
  | { kind: 'spline'; through: readonly Vec2[] };

/** How `loft` pairs the vertices of neighbouring sections (see ExactKernel.loft). */
export type LoftPairing = 'authored' | 'closest';
export interface LoftOptions { ruled?: boolean; pairing?: LoftPairing }
export interface LoftSection { profile: ExactProfile; /** Where the XY profile is placed. */ at: Vec3 }

export interface StepImportOptions {
  /** Refuse files with more bodies than this (default 1,000). Counted after reading. */
  maxBodies?: number;
}
/** One body of a STEP file, read by `importStepBodies`. */
export interface StepImportBody {
  solid: ExactSolid;
  /** The body's (or its product's) name in the file, or null. */
  name: string | null;
  /** The body's colour in the file, [r, g, b] from 0 to 1, or null. */
  color: [number, number, number] | null;
}
export interface StepImport {
  bodies: StepImportBody[];
  /** The reader's notes on bodies it repaired while reading (healed or stitched faces). */
  notes: string[];
}

export type ExactKernelErrorCode =
  /** The request is well formed but this backend has no exact construction for it. */
  | 'unsupported'
  /** The request itself is invalid (non-finite, non-positive or degenerate dimensions). */
  | 'invalid-input'
  /** The kernel rejected or failed the operation (e.g. a fillet radius it cannot realise). */
  | 'kernel-failure';

export class ExactKernelError extends Error {
  readonly code: ExactKernelErrorCode;
  constructor(code: ExactKernelErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ExactKernelError';
    this.code = code;
  }
}

export interface ExactProfileOps {
  /** Even-odd region of one or more closed polylines (holes and islands by nesting). */
  polygon(contours: readonly (readonly Vec2[])[]): ExactProfile;
  circle(radius: number): ExactProfile;
  rectangle(width: number, height: number, centred: boolean): ExactProfile;
  /** Centred rectangle with round corners (0 < radius < half the short side). */
  roundedRectangle(width: number, height: number, radius: number): ExactProfile;
  /** Closed region bounded by lines, arcs and splines from `start`; closed by a line if needed. */
  path(start: Vec2, segments: readonly PathSegment[]): ExactProfile;
  /** Text outline in the kernel's default font. The bundle ships no font (the upstream
   * font file is left out), so this is an `unsupported` error. */
  text(content: string, size: number): ExactProfile;
  union(first: ExactProfile, ...rest: ExactProfile[]): ExactProfile;
  subtract(base: ExactProfile, ...cutters: ExactProfile[]): ExactProfile;
  intersect(first: ExactProfile, ...rest: ExactProfile[]): ExactProfile;
  /** Convex hull; arcs stay exact (tangent lines between circles). */
  hull(...profiles: ExactProfile[]): ExactProfile;
  translate(profile: ExactProfile, offset: Vec2): ExactProfile;
  /** Counter-clockwise, degrees, about the origin. */
  rotate(profile: ExactProfile, degrees: number): ExactProfile;
  /** Per-axis factors; negative factors mirror. */
  scale(profile: ExactProfile, factors: Vec2): ExactProfile;
  /** Offset outward (positive) or inward; round or sharp corners. */
  offset(profile: ExactProfile, distance: number, round: boolean): ExactProfile;
  bounds(profile: ExactProfile): { min: [number, number]; max: [number, number] };
  area(profile: ExactProfile): number;
}

export interface ExactKernel {
  readonly name: string;
  readonly version: string;
  /** SPDX expression of the code that runs (the shipped bundle). */
  readonly licence: string;

  // Primitives (centred on the origin, axes along Z).
  box(size: Vec3): ExactSolid;
  cylinder(radius: number, height: number): ExactSolid;
  /** Frustum; one radius may be zero. */
  cone(bottomRadius: number, topRadius: number, height: number): ExactSolid;
  sphere(radius: number): ExactSolid;
  torus(majorRadius: number, minorRadius: number): ExactSolid;
  /** Closed solid bounded by planar polygon faces (counter-clockwise seen from outside). */
  polyhedron(points: readonly Vec3[], faces: readonly (readonly number[])[]): ExactSolid;

  readonly profile: ExactProfileOps;
  /** Prism from z = 0 to z = height. */
  extrude(profile: ExactProfile, height: number): ExactSolid;
  /** Revolve the XY profile (X radius, Y height) about world Z by `degrees` (0 < |degrees| <= 360). */
  revolve(profile: ExactProfile, degrees: number): ExactSolid;
  /**
   * Solid through two or more parallel XY sections; smooth unless `ruled`.
   *
   * `pairing` says which vertices of neighbouring sections are joined, for sections with equal
   * vertex counts: `'authored'` (the default, as before 0.1.5) joins vertex i of each section to
   * vertex i of the next, as drawn; `'closest'` re-starts each straight-edged section at the
   * vertex, and in the direction, where it lies closest to the section before, as
   * `BRepOffsetAPI_ThruSections` does (for models written against that loft). Straight-edged sections
   * with different vertex counts have no vertex i to keep: either way they get vertices inserted
   * by ThruSections' polar rule (the first section keeps its start and direction). Since 0.1.7
   * `'closest'` also takes sections with curved edges, each a single outline: equal edge counts are
   * re-started at the vertex and direction closest to the section before (lines and circular arcs
   * either way, other curves only forward from a path's own edges); sections without a corner stay
   * as drawn; different edge counts with a curved edge, and sections with holes, are `unsupported`.
   */
  loft(sections: readonly LoftSection[], options?: LoftOptions): ExactSolid;
  /** Sweep the XY profile along a polyline rail starting at the profile's plane. */
  sweep(profile: ExactProfile, rail: readonly Vec3[]): ExactSolid;

  union(first: ExactSolid, ...rest: ExactSolid[]): ExactSolid;
  subtract(base: ExactSolid, ...cutters: ExactSolid[]): ExactSolid;
  intersect(first: ExactSolid, ...rest: ExactSolid[]): ExactSolid;
  /** The parts on the positive and negative side of the plane `normal . x = offset`. */
  splitByPlane(solid: ExactSolid, normal: Vec3, offset: number): [ExactSolid, ExactSolid];

  translate(solid: ExactSolid, offset: Vec3): ExactSolid;
  /** Right-handed rotation about an axis through `pivot` (default origin). */
  rotate(solid: ExactSolid, axis: Vec3, degrees: number, pivot?: Vec3): ExactSolid;
  /** Reflection in the plane through `origin` (default the origin) with this normal. */
  mirror(solid: ExactSolid, normal: Vec3, origin?: Vec3): ExactSolid;
  /** Per-axis scale about the origin; negative factors mirror. */
  scale(solid: ExactSolid, factors: Vec3): ExactSolid;

  /** Faces and edges with their names, kinds, sample points and adjacency (since 0.1.9). Edge
   * indices are what `fillet` and `chamfer` take as `{ edgeIndices }`. */
  topology(solid: ExactSolid): ExactTopology;
  /** The same solid with face i (of `topology(solid).faces`) named `names[i]`: null keeps a
   * face's name, '' takes it off. A name stays with the face and with its pieces through
   * Booleans, transforms, fillets, chamfers and shells (faces an operation makes anew, such as a
   * fillet's round, have none) and is written to STEP on the face (since 0.1.9). */
  nameFaces(solid: ExactSolid, names: readonly (string | null)[]): ExactSolid;

  fillet(solid: ExactSolid, radius: number, edges?: EdgeSelector): ExactSolid;
  chamfer(solid: ExactSolid, distance: number, edges?: EdgeSelector): ExactSolid;
  /** Hollow inward to wall `thickness`, removing the selected faces (a normal, a selector or several). */
  shell(solid: ExactSolid, thickness: number, openFaces?: Vec3 | FaceSelector | readonly (Vec3 | FaceSelector)[]): ExactSolid;

  volume(solid: ExactSolid): number;
  area(solid: ExactSolid): number;
  bbox(solid: ExactSolid): BoundingBox;
  massProperties(solid: ExactSolid): MassProperties;
  /** Closed, manifold, positive volume. */
  isValid(solid: ExactSolid): boolean;
  /** Number of separate solids (disconnected components) in the body. */
  solidCount(solid: ExactSolid): number;
  /** The disconnected components as separate solids (the caller disposes them). */
  components(solid: ExactSolid): ExactSolid[];

  /** Triangles within `tolerance` mm chordal deviation (and `angleDeg` normal deviation). */
  tessellate(solid: ExactSolid, options?: { tolerance?: number; angleDeg?: number }): TriangleMesh;
  /** Binary STL at the same tolerances as `tessellate`. */
  exportStl(solid: ExactSolid, options?: { tolerance?: number; angleDeg?: number }): Uint8Array;
  /** AP214 STEP text, millimetres. */
  exportStep(solid: ExactSolid): string;
  /** Exact STEP import (the kernel's own reader); several bodies are joined into one solid.
   * Lenient: a body the reader cannot build is left out. Use `importStepBodies` to refuse that. */
  importStep(text: string): ExactSolid;
  /**
   * Strict exact STEP import (since 0.1.8): every body of the file as its own closed solid, in
   * file order, in millimetres, with assembly placements applied and nothing joined. The file is
   * refused as a whole, never read in part: `invalid-input` for input that is not STEP text,
   * `unsupported` for a file with no solid, a body the reader cannot build, a body that is an open
   * surface (sheet) instead of a closed solid, a body that stays invalid after healing, or more
   * bodies than `maxBodies`; `kernel-failure` for anything else the kernel reports. Bodies the
   * reader had to repair (heal or stitch) are read, and each repair is listed in `notes`.
   */
  importStepBodies(data: string | Uint8Array, options?: StepImportOptions): StepImport;

  memory(): KernelMemory;
  /** Run `fn`, freeing every kernel object it made that its result does not hold. */
  scope<T>(fn: () => T): T;
}
