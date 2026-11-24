// SPDX-License-Identifier: MIT
// The 27 reference parts built natively with WASMLib (SMLib SM_API, no OpenCASCADE).
// WASMLib is not an npm dependency: set WASMLIB_DIR to a checkout of
// https://github.com/au12/WASMLib (Apache-2.0) containing dist/wasmlib.mjs.
import { pathToFileURL } from 'node:url';

const dir = process.env.WASMLIB_DIR;
if (!dir) throw new Error('Set WASMLIB_DIR to a WASMLib checkout');
const W = await (await import(pathToFileURL(`${dir}/dist/wasmlib.mjs`).href)).default();
W.init();

export const kernel = { name: 'WASMLib', version: 'au12/WASMLib c7abc5d6c7820f6872886d3c7c37fb1df6977ce2', licence: 'Apache-2.0' };

const copy = b => W.SmApiBrepCopy(b);
const moved = (b, v) => { W.SmApiTranslate(b, v); return b; };
const corner = (x, y, z) => W.SmApiCreateBox([0, 0, 0], x, y, z);
const cyl = (h, r) => W.SmApiCreateCylinder([0, 0, 0], r, h);
const at = (x, y, z, b) => moved(b, [x, y, z]);
const union = (a, b) => W.SmApiBooleanUnion(copy(a), copy(b));
const cut = (a, b) => W.SmApiBooleanDifference(copy(a), copy(b));
const common = (a, b) => W.SmApiBooleanIntersection(copy(a), copy(b));
const polyline = pts => pts.map((p, i) => W.SmApiCreateLineSegment(p, pts[(i + 1) % pts.length]));
const xzProfile = pts => polyline(pts.map(([r, z]) => [r, 0, z]));
const revolveZ = curves => W.SmApiCreateRotationalSweep(curves, [0, 0, 0], [0, 0, 1], 360, 1);
const topFace = b => W.brepFaces(b).find(f => { const n = W.faceNormal(f, null).normal; return n[2] > 0.999 && W.faceNormal(f, null).point[2] >= W.brepBox(b)[1][2] - 1e-9; });

export const builders = {
  'rectangular-block': () => corner(40, 30, 20),
  'centered-block': () => W.SmApiCreateBox([-12, -9, -3], 24, 18, 6),
  'cylinder': () => cyl(50, 10),
  'sphere': () => W.SmApiCreateSphere([0, 0, 0], 12),
  'torus-revolve': () => revolveZ([W.SmApiCreateCircle([20, 0, 0], 5)].map(c => { W.SmApiRotate(c, [20, 0, 0], [1, 0, 0], 90); return c; })),
  'cone-frustum-revolve': () => revolveZ(xzProfile([[0, 0], [10, 0], [6, 20], [0, 20]])),
  'plate-through-hole': () => cut(corner(60, 40, 10), at(30, 20, -1, cyl(12, 5))),
  'plate-blind-hole': () => cut(corner(40, 30, 12), at(20, 15, 7, cyl(6, 4))),
  'plate-counterbore': () => cut(cut(corner(40, 30, 10), at(20, 15, -1, cyl(12, 3))), at(20, 15, 6, cyl(5, 5))),
  'plate-through-slot': () => cut(corner(50, 30, 10), at(15, 11, -1, corner(20, 8, 12))),
  'annular-cylinder': () => cut(cyl(20, 15), at(0, 0, -1, cyl(22, 5))),
  'open-top-shell': () => { const b = corner(50, 40, 30); return W.SmApiShellBrepFull(b, -3, 1, 1, 1, [topFace(b)]); }, // other flag sets give SM_ERR or a silent no-op
  'l-bracket-union': () => union(corner(40, 20, 8), at(0, 0, 8, corner(8, 20, 20))),
  'boolean-intersection': () => common(corner(20, 20, 20), at(5, -5, 0, corner(10, 30, 20))),
  'rounded-box': () => { const b = corner(40, 30, 20); W.SmApiFilletEdges(b, W.brepEdges(b), 3, 1, 1, 1); return b; },
  'top-edge-chamfer': () => { const b = corner(40, 30, 20); W.SmApiFilletEdges(b, W.faceEdges(topFace(b), true), 2, 0, 1, 1); return b; },
  'plate-four-holes': () => [[15, 10], [65, 10], [15, 40], [65, 40]].reduce((p, [x, y]) => cut(p, at(x, y, -1, cyl(12, 3))), corner(80, 50, 10)),
  'circular-pattern-pins': () => W.mergeDisjoint([0, 1, 2, 3, 4, 5].map(i => { const c = at(20, 0, 0, cyl(8, 3)); W.SmApiRotate(c, [0, 0, 0], [0, 0, 1], 60 * i); return c; })),
  'linear-pattern-pins': () => W.mergeDisjoint([5, 15, 25, 35].map(x => at(x, 0, 0, cyl(8, 3)))),
  'grid-pattern-pins': () => W.mergeDisjoint([[4, 5], [14, 5], [24, 5], [4, 15], [14, 15], [24, 15]].map(([x, y]) => at(x, y, 0, cyl(8, 3)))),
  'mirrored-blocks': () => { const a = at(10, 0, 0, corner(10, 10, 10)), b = copy(a); W.mirror(b, [1, 0, 0], [0, 0, 0]); return union(a, b); },
  'sweep-square-prism': () => W.SmApiCreateLinearSweep(polyline([[-2, -2, 0], [2, -2, 0], [2, 2, 0], [-2, 2, 0]]), [0, 0, 1], 30, 1),
  'sweep-round-prism': () => W.SmApiCreateLinearSweep([W.SmApiCreateCircle([0, 0, 0], 5)], [0, 0, 1], 20, 1),
  'loft-circular-frustum': () => W.SmApiCreateSkinPrimitive([1, 1], [W.SmApiCreateCircle([0, 0, 0], 10), W.SmApiCreateCircle([0, 0, 20], 5)], 1, 1).rpResult,
  'loft-square-frustum': () => W.SmApiCreateSkinPrimitive([4, 4], [...polyline([[-10, -10, 0], [10, -10, 0], [10, 10, 0], [-10, 10, 0]]), ...polyline([[-6, -6, 10], [6, -6, 10], [6, 6, 10], [-6, 6, 10]])], 1, 1).rpResult,
  'stepped-shaft-revolve': () => revolveZ(xzProfile([[0, 0], [4, 0], [4, 10], [8, 10], [8, 20], [0, 20]])),
  'rotated-box': () => { const b = corner(40, 20, 5); W.SmApiRotate(b, [0, 0, 0], [0, 0, 1], 30); return b; },
};

export function measure(b) {
  const [min, max] = W.brepBox(b);
  // 1e-10 fails with SM_ERR on the sphere; fall back to 1e-8 (still inside the 1e-6 scorecard tolerance).
  const exact = f => { try { return f(1e-10); } catch { return f(1e-8); } };
  return { volume: exact(a => W.SmApiBrepComputeVolume(b, a)), area: exact(a => W.SmApiBrepComputeArea(b, a)), min, max };
}

/** Heavier timing cases (not in the scorecard). */
export const stress = {
  'plate-48-holes': () => { let p = corner(100, 80, 5); for (let i = 0; i < 8; i++) for (let j = 0; j < 6; j++) p = cut(p, at(10 + 11.5 * i, 10 + 12 * j, -1, cyl(7, 2))); return p; },
  'filleted-shelled-box': () => { const b = corner(60, 40, 30); W.SmApiFilletEdges(b, W.brepEdges(b), 4, 1, 1, 1); return W.SmApiShellBrepFull(b, -2, 1, 1, 1, [topFace(b)]); },
};
