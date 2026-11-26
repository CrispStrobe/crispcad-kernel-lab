// SPDX-License-Identifier: MIT
// Copyright (c) 2026 CrispCAD contributors
//
// @crispcad/exact-kernel: an exact B-rep kernel without OpenCASCADE. Importing this module does
// not load WebAssembly; `createSmlibKernel()` does.
export * from './exact-kernel.ts';
export { createSmlibKernel, EXACT_KERNEL_LICENCE, SMLIB_MESH_ANGLE, SMLIB_MESH_TOLERANCE, type SmlibKernel, type SmlibLoadOptions } from './smlib-kernel.ts';
export { convexHull, isConvexPolyhedron, MAX_HULL_POINTS, planarFaces, type Polytope } from './polytope.ts';
export { symmetricEigen } from './validate.ts';
