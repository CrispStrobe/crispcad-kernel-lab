// SPDX-License-Identifier: MIT
// Copyright (c) 2026 CrispCAD contributors
//
// The product structure importStepBodies reports since 0.1.11: each body's chain of assembly
// occurrences, matched one for one to the bodies the reader builds, or none at all.
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { createSmlibKernel, readStepStructure, type ExactKernel } from '../dist/index.js';

let k: ExactKernel;
beforeAll(async () => { k = await createSmlibKernel(); });
const asset = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url));
const label = (o: { product: string | null; instance: string | null }) => o.instance ? `${o.instance}<${o.product}>` : String(o.product);

describe('importStepBodies: product structure', () => {
  it('puts each instance of a repeated part under its own occurrence, in the placement the reader used', () => k.scope(() => {
    // OpenCASCADE 7.6 assembly: a panel with a plate, three standoffs (one product, three
    // occurrences), a bracket and four screws.
    const read = k.importStepBodies(asset('docs/demos/step-instance-roundtrip/panel-roundtrip.step'));
    expect(read.structure).toBe('assembly');
    expect(read.bodies.map(b => b.occurrence!.map(label))).toEqual([
      ['panel', 'plate<plate>'],
      ['panel', 'standoff_0<standoff_0>'], ['panel', 'standoff_1<standoff_0>'], ['panel', 'standoff_2<standoff_0>'],
      ['panel', 'bracket<bracket>'],
      ['panel', 'screw_0<screw_0>'], ['panel', 'screw_1<screw_0>'], ['panel', 'screw_2<screw_0>'], ['panel', 'screw_3<screw_0>'],
    ]);
    // The occurrence names belong to the bodies placed there: standoff_1 at x = 80 (#24), standoff_2 at 140.
    const centre = (i: number) => { const b = k.bbox(read.bodies[i].solid); return (b.min[0] + b.max[0]) / 2; };
    expect([1, 2, 3].map(centre)).toEqual([expect.closeTo(20, 6), expect.closeTo(80, 6), expect.closeTo(140, 6)]);
    expect([5, 6, 7, 8].map(centre)).toEqual([expect.closeTo(20, 6), expect.closeTo(80, 6), expect.closeTo(140, 6), expect.closeTo(200, 6)]);
    expect(read.notes).toEqual([]);
  }));
  it('gives every body of a file without assemblies its one product', () => k.scope(() => {
    const read = k.importStepBodies(asset('assets/parts-seed/stepper-motor/nema-17.step'));
    expect(read.structure).toBe('flat');
    expect(read.bodies.every(b => b.occurrence!.length === 1)).toBe(true);
    const own = k.importStepBodies(k.exportStep([{ solid: k.box([1, 2, 3]), name: 'a' }, { solid: k.translate(k.box([1, 1, 1]), [5, 0, 0]), name: 'b' }], { product: 'kit' }));
    expect(own.structure).toBe('flat');
    expect(own.bodies.map(b => [b.name, b.occurrence!.map(label)])).toEqual([['a', ['kit']], ['b', ['kit']]]);
  }));
  it('reads STEP string escapes and nested occurrences without the kernel', () => {
    const text = `ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;
#1=PRODUCT('top','Top','',());#2=PRODUCT_DEFINITION_FORMATION('','',#1);#3=PRODUCT_DEFINITION('d','',#2,$);
#4=PRODUCT('sub','Gr\\X2\\00FC\\X0\\n','',());#5=PRODUCT_DEFINITION_FORMATION('','',#4);#6=PRODUCT_DEFINITION('d','',#5,$);
#7=PRODUCT('leaf','Leaf','',());#8=PRODUCT_DEFINITION_FORMATION('','',#7);#9=PRODUCT_DEFINITION('d','',#8,$);
#10=SHAPE_REPRESENTATION('',(#40),#99);#11=SHAPE_REPRESENTATION('',(#40),#99);#12=ADVANCED_BREP_SHAPE_REPRESENTATION('',(#40,#30),#99);
#13=SHAPE_DEFINITION_REPRESENTATION(#14,#10);#14=PRODUCT_DEFINITION_SHAPE('','',#3);
#15=SHAPE_DEFINITION_REPRESENTATION(#16,#11);#16=PRODUCT_DEFINITION_SHAPE('','',#6);
#17=SHAPE_DEFINITION_REPRESENTATION(#18,#12);#18=PRODUCT_DEFINITION_SHAPE('','',#9);
#20=NEXT_ASSEMBLY_USAGE_OCCURRENCE('1','sub:1','',#3,#6,$);#21=NEXT_ASSEMBLY_USAGE_OCCURRENCE('2','leaf:1','',#6,#9,$);#22=NEXT_ASSEMBLY_USAGE_OCCURRENCE('3','leaf:2','',#6,#9,$);
#23=(REPRESENTATION_RELATIONSHIP('','',#11,#10)REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION(#33)SHAPE_REPRESENTATION_RELATIONSHIP());
#24=CONTEXT_DEPENDENT_SHAPE_REPRESENTATION(#23,#25);#25=PRODUCT_DEFINITION_SHAPE('','',#20);
#26=(REPRESENTATION_RELATIONSHIP('','',#12,#11)REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION(#33)SHAPE_REPRESENTATION_RELATIONSHIP());
#27=CONTEXT_DEPENDENT_SHAPE_REPRESENTATION(#26,#28);#28=PRODUCT_DEFINITION_SHAPE('','',#21);
#29=(REPRESENTATION_RELATIONSHIP('','',#12,#11)REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION(#33)SHAPE_REPRESENTATION_RELATIONSHIP());
#31=CONTEXT_DEPENDENT_SHAPE_REPRESENTATION(#29,#32);#32=PRODUCT_DEFINITION_SHAPE('','',#22);
#33=ITEM_DEFINED_TRANSFORMATION('','',#40,#40);
#30=MANIFOLD_SOLID_BREP('pin ''A''',#50);
ENDSEC;\nEND-ISO-10303-21;\n`;
    const read = readStepStructure(text);
    expect(read.assembly).toBe(true);
    expect(read.names).toEqual(["pin 'A'", "pin 'A'"]);
    expect(read.bodies.map(b => b.map(label))).toEqual([['Top', 'sub:1<Grün>', 'leaf:1<Leaf>'], ['Top', 'sub:1<Grün>', 'leaf:2<Leaf>']]);
    expect(() => readStepStructure('not a step file')).toThrow(SyntaxError);
  });
});
