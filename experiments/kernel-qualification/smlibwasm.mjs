// SPDX-License-Identifier: MIT
// The 27 reference parts built natively with @classcad/smlibwasm (SMLib, no OpenCASCADE).
// kernelCAD conventions: box(x,y,z) is corner-anchored at the origin; cylinder(h,r)
// spans z = 0..h; path revolves use sketch x as radius and sketch y as height.
import * as S from '@classcad/smlibwasm';

const { Box, Cylinder, Sphere, Torus, Pos, Rot, Polygon, Rectangle, Circle, Plane, Axis, Line, revolve, loft, sweep, fillet, chamfer, shell, mirror } = S;
const corner = (x, y, z) => Box(x, y, z, { align: 'min' });
const cyl = (h, r) => Cylinder(r, h, { align: ['center', 'center', 'min'] });
const at = (x, y, z, part) => Pos(x, y, z).mul(part);
const xz = points => Polygon(points.map(([u, v]) => [u, v]), { align: null }).on(Plane.XZ);

export const kernel = { name: '@classcad/smlibwasm', version: '0.6.2', licence: 'MIT AND Apache-2.0 AND OFL-1.1' };

export const builders = {
  'rectangular-block': () => corner(40, 30, 20),
  'centered-block': () => Box(24, 18, 6),
  'cylinder': () => cyl(50, 10),
  'sphere': () => Sphere(12),
  'torus-revolve': () => revolve(Pos(20, 0, 0).mul(Circle(5).on(Plane.XZ)), Axis.Z),
  'cone-frustum-revolve': () => revolve(xz([[0, 0], [10, 0], [6, 20], [0, 20]]), Axis.Z),
  'plate-through-hole': () => corner(60, 40, 10).cut(at(30, 20, -1, cyl(12, 5))),
  'plate-blind-hole': () => corner(40, 30, 12).cut(at(20, 15, 7, cyl(6, 4))),
  'plate-counterbore': () => corner(40, 30, 10).cut(at(20, 15, -1, cyl(12, 3))).cut(at(20, 15, 6, cyl(5, 5))),
  'plate-through-slot': () => corner(50, 30, 10).cut(at(15, 11, -1, corner(20, 8, 12))),
  'annular-cylinder': () => cyl(20, 15).cut(at(0, 0, -1, cyl(22, 5))),
  'open-top-shell': () => { const b = corner(50, 40, 30); return shell(b, -3, b.faces().sortBy(Axis.Z).last); },
  'l-bracket-union': () => corner(40, 20, 8).fuse(at(0, 0, 8, corner(8, 20, 20))),
  'boolean-intersection': () => corner(20, 20, 20).intersect(at(5, -5, 0, corner(10, 30, 20))),
  'rounded-box': () => { const b = corner(40, 30, 20); return fillet(b.edges(), 3); },
  'top-edge-chamfer': () => { const b = corner(40, 30, 20); return chamfer(b.faces().sortBy(Axis.Z).last.edges(), 2); },
  'plate-four-holes': () => [[15, 10], [65, 10], [15, 40], [65, 40]].reduce((p, [x, y]) => p.cut(at(x, y, -1, cyl(12, 3))), corner(80, 50, 10)),
  'circular-pattern-pins': () => [0, 1, 2, 3, 4, 5].map(i => Rot(0, 0, 60 * i).mul(at(20, 0, 0, cyl(8, 3)))).reduce((a, b) => a.fuse(b)),
  'linear-pattern-pins': () => [5, 15, 25, 35].map(x => at(x, 0, 0, cyl(8, 3))).reduce((a, b) => a.fuse(b)),
  'grid-pattern-pins': () => [[4, 5], [14, 5], [24, 5], [4, 15], [14, 15], [24, 15]].map(([x, y]) => at(x, y, 0, cyl(8, 3))).reduce((a, b) => a.fuse(b)),
  'mirrored-blocks': () => { const block = at(10, 0, 0, corner(10, 10, 10)); return block.fuse(mirror(block, Plane.YZ)); },
  'sweep-square-prism': () => sweep(Rectangle(4, 4), Line([0, 0, 0], [0, 0, 30])),
  'sweep-round-prism': () => sweep(Circle(5), Line([0, 0, 0], [0, 0, 20])),
  'loft-circular-frustum': () => loft([Circle(10), Pos(0, 0, 20).mul(Circle(5))]),
  'loft-square-frustum': () => loft([Rectangle(20, 20), Pos(0, 0, 10).mul(Rectangle(12, 12))]),
  'stepped-shaft-revolve': () => revolve(xz([[0, 0], [4, 0], [4, 10], [8, 10], [8, 20], [0, 20]]), Axis.Z),
  'rotated-box': () => Rot(0, 0, 30).mul(corner(40, 20, 5)),
};

export function measure(part) {
  const box = part.bbox();
  return { volume: part.volume, area: part.area, min: [box.min.x, box.min.y, box.min.z], max: [box.max.x, box.max.y, box.max.z] };
}

/** Heavier timing cases (not in the scorecard). */
export const stress = {
  'plate-48-holes': () => { let p = corner(100, 80, 5); for (let i = 0; i < 8; i++) for (let j = 0; j < 6; j++) p = p.cut(at(10 + 11.5 * i, 10 + 12 * j, -1, cyl(7, 2))); return p; },
  'filleted-shelled-box': () => { const b = fillet(corner(60, 40, 30).edges(), 4); return shell(b, -2, b.faces().sortBy(Axis.Z).last); },
};
