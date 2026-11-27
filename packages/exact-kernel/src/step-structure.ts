// SPDX-License-Identifier: MIT
// Copyright (c) 2026 CrispCAD contributors
//
// The product structure of a STEP file (ISO 10303-21, AP203/AP214/AP242): which assembly
// occurrence each body that `importStepBodies` returns belongs to. smlibwasm's reader places every
// body through the file's assembly (NEXT_ASSEMBLY_USAGE_OCCURRENCE with its
// CONTEXT_DEPENDENT_SHAPE_REPRESENTATION, REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION,
// MAPPED_ITEM) but returns only each body's own name, so this module reads the same entities again
// and walks the same representation graph in the same order: one entry per body the reader
// returns, each the chain of occurrences from the top product down to the product that holds the
// solid. The host checks the count and the names against the reader's bodies and drops the
// structure when they differ, so a file this walk reads differently is imported flat, never
// grouped wrongly.
//
// Original code. The traversal order follows what the pinned smlibwasm 0.6.2 reader does (its
// `interpret` over the file's solids, each placed by every path from its representation up through
// the representation relationships, duplicates of a path dropped).

/** One level of a body's place in the assembly: the product and the name of its occurrence. */
export interface StepOccurrence {
  /** The product's name (PRODUCT name, else its id), or null when the file names none. */
  product: string | null;
  /** The occurrence's name in its parent assembly (NEXT_ASSEMBLY_USAGE_OCCURRENCE name, else its
   * id; MAPPED_ITEM name), or null for the top product and for unnamed occurrences. */
  instance: string | null;
}

type Value = null | number | string | Ref | Enum | Value[] | Typed;
class Ref { constructor(readonly id: number) {} }
class Enum { constructor(readonly name: string) {} }
class Typed { constructor(readonly type: string, readonly value: Value) {} }

interface Entity { type: string; args: Value[] }
interface Parsed {
  /** Simple entities in file order. */
  simple: Map<number, Entity>;
  /** Complex entities (one record of several types), in file order. */
  complex: Map<number, Map<string, Value[]>>;
}

/** The types whose arguments this module reads; every other entity is skipped unparsed. */
const WANTED = /^(PRODUCT|PRODUCT_DEFINITION|PRODUCT_DEFINITION_FORMATION|PRODUCT_DEFINITION_FORMATION_WITH_SPECIFIED_SOURCE|PRODUCT_DEFINITION_SHAPE|SHAPE_DEFINITION_REPRESENTATION|NEXT_ASSEMBLY_USAGE_OCCURRENCE|ASSEMBLY_USAGE_OCCURRENCE|PRODUCT_DEFINITION_USAGE|CONTEXT_DEPENDENT_SHAPE_REPRESENTATION|SHAPE_REPRESENTATION_RELATIONSHIP|REPRESENTATION_RELATIONSHIP|CONSTRUCTIVE_GEOMETRY_REPRESENTATION_RELATIONSHIP|MAPPED_ITEM|REPRESENTATION_MAP|MANIFOLD_SOLID_BREP|BREP_WITH_VOIDS|SHELL_BASED_SURFACE_MODEL|[A-Z_]*REPRESENTATION)$/;
const PLAIN_RELATIONSHIPS = ['SHAPE_REPRESENTATION_RELATIONSHIP', 'REPRESENTATION_RELATIONSHIP', 'CONSTRUCTIVE_GEOMETRY_REPRESENTATION_RELATIONSHIP'];
const SOLIDS = new Set(['MANIFOLD_SOLID_BREP', 'BREP_WITH_VOIDS', 'SHELL_BASED_SURFACE_MODEL']);

class Reader {
  at = 0;
  constructor(readonly text: string) {}
  space() { while (this.at < this.text.length && this.text.charCodeAt(this.at) <= 32) this.at++; }
  value(): Value {
    this.space();
    const c = this.text[this.at];
    if (c === '$' || c === '*') { this.at++; return null; }
    if (c === '#') {
      const m = /^#(\d+)/.exec(this.text.slice(this.at, this.at + 24));
      if (!m) throw new SyntaxError('bad reference');
      this.at += m[0].length;
      return new Ref(Number(m[1]));
    }
    if (c === "'") return this.string();
    if (c === '.') {
      const end = this.text.indexOf('.', this.at + 1);
      if (end < 0) throw new SyntaxError('bad enumeration');
      const name = this.text.slice(this.at + 1, end);
      this.at = end + 1;
      return new Enum(name);
    }
    if (c === '(') return this.list();
    if (c === '"') { // binary
      const end = this.text.indexOf('"', this.at + 1);
      this.at = end + 1;
      return null;
    }
    const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.text.slice(this.at, this.at + 200));
    if (word) {
      this.at += word[0].length;
      this.space();
      if (this.text[this.at] !== '(') throw new SyntaxError('bad typed parameter');
      const inner = this.list();
      return new Typed(word[0].toUpperCase(), inner.length === 1 ? inner[0] : inner);
    }
    const number = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(this.text.slice(this.at, this.at + 64));
    if (!number) throw new SyntaxError(`unexpected ${JSON.stringify(c)}`);
    this.at += number[0].length;
    return Number(number[0]);
  }
  string(): string {
    let out = '';
    this.at++;
    for (;;) {
      const end = this.text.indexOf("'", this.at);
      if (end < 0) throw new SyntaxError('unterminated string');
      out += this.text.slice(this.at, end);
      this.at = end + 1;
      if (this.text[this.at] === "'") { out += "'"; this.at++; continue; }
      return decodeStepString(out);
    }
  }
  list(): Value[] {
    const items: Value[] = [];
    this.at++; // (
    this.space();
    if (this.text[this.at] === ')') { this.at++; return items; }
    for (;;) {
      items.push(this.value());
      this.space();
      const c = this.text[this.at++];
      if (c === ')') return items;
      if (c !== ',') throw new SyntaxError('expected , or )');
    }
  }
}

/** STEP's string escapes (ISO 10303-21 §6.4.3): \X2\…\X0\ (UCS-2), \X4\…\X0\, \X\hh, \S\c, \\. */
function decodeStepString(raw: string): string {
  if (!raw.includes('\\')) return raw;
  return raw
    .replace(/\\X2\\((?:[0-9A-Fa-f]{4})*)\\X0\\/g, (_m, hex: string) => String.fromCharCode(...(hex.match(/.{4}/g) ?? []).map(h => parseInt(h, 16))))
    .replace(/\\X4\\((?:[0-9A-Fa-f]{8})*)\\X0\\/g, (_m, hex: string) => String.fromCodePoint(...(hex.match(/.{8}/g) ?? []).map(h => parseInt(h, 16))))
    .replace(/\\X\\([0-9A-Fa-f]{2})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\S\\(.)/g, (_m, c: string) => String.fromCharCode(c.charCodeAt(0) + 128))
    .replace(/\\\\/g, '\\');
}

/** Splits the DATA section into entity records and parses the ones this module reads. */
function parse(text: string): Parsed {
  const source = text.replace(/\/\*[\s\S]*?\*\//g, '');
  const start = source.search(/\bDATA\s*(\([^)]*\))?\s*;/);
  if (start < 0) throw new SyntaxError('no DATA section');
  const simple = new Map<number, Entity>(), complex = new Map<number, Map<string, Value[]>>();
  let at = source.indexOf(';', start) + 1;
  const n = source.length;
  while (at < n) {
    // One record: up to the semicolon that is outside strings.
    let end = at, inString = false;
    for (; end < n; end++) {
      const c = source.charCodeAt(end);
      if (c === 39) inString = !inString; // '  (a doubled quote toggles twice)
      else if (c === 59 && !inString) break; // ;
    }
    const record = source.slice(at, end).trim();
    at = end + 1;
    if (!record.startsWith('#')) { if (/^ENDSEC$/.test(record)) break; continue; }
    const head = /^#(\d+)\s*=\s*/.exec(record);
    if (!head) continue;
    const id = Number(head[1]), body = record.slice(head[0].length);
    if (body.startsWith('(')) {
      if (!/REPRESENTATION_RELATIONSHIP|REPRESENTATION\s*\(/.test(body)) continue;
      const reader = new Reader(body);
      reader.at = 1;
      const parts = new Map<string, Value[]>();
      for (;;) {
        reader.space();
        if (body[reader.at] === ')' || reader.at >= body.length) break;
        const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(body.slice(reader.at, reader.at + 200));
        if (!word) break;
        reader.at += word[0].length;
        reader.space();
        parts.set(word[0].toUpperCase(), reader.list());
      }
      complex.set(id, parts);
      continue;
    }
    const type = /^[A-Za-z_][A-Za-z0-9_]*/.exec(body)?.[0].toUpperCase();
    if (!type || !WANTED.test(type)) continue;
    const reader = new Reader(body);
    reader.at = type.length;
    reader.space();
    simple.set(id, { type, args: reader.list() });
  }
  return { simple, complex };
}

const ref = (v: Value | undefined): number | undefined => v instanceof Ref ? v.id : undefined;
const str = (v: Value | undefined): string | undefined => typeof v === 'string' && v.trim() ? v : undefined;

export interface StepStructure {
  /** For each body the reader returns, in its order: the occurrences from the top product down. */
  bodies: StepOccurrence[][];
  /** The expected name of each body, as the reader names it (the solid's, else its product's). */
  names: (string | null)[];
  /** True when the file places products in assemblies (at least one occurrence below the top). */
  assembly: boolean;
}

/**
 * Reads the product structure of `text`. Throws SyntaxError on text it cannot read; the caller
 * treats every failure as "no structure".
 */
export function readStepStructure(text: string): StepStructure {
  const { simple, complex } = parse(text);
  const get = (id: number | undefined) => id === undefined ? undefined : simple.get(id);

  // Representations and the items they list.
  const items = new Map<number, Set<number>>();
  const owner = new Map<number, number[]>();
  const addItems = (id: number, list: Value | undefined) => {
    if (!Array.isArray(list)) return;
    const set = new Set<number>();
    for (const item of list) {
      const r = ref(item);
      if (r === undefined) continue;
      set.add(r);
      const owners = owner.get(r);
      if (owners) owners.push(id); else owner.set(r, [id]);
    }
    items.set(id, set);
  };
  for (const [id, e] of simple) if (e.type.endsWith('REPRESENTATION') && e.args.length >= 2) addItems(id, e.args[1]);
  for (const [id, parts] of complex) for (const [kind, args] of parts) if (kind.endsWith('REPRESENTATION') && args.length >= 2 && !items.has(id)) {
    const set = new Set<number>();
    for (const item of Array.isArray(args[1]) ? args[1] : []) { const r = ref(item); if (r !== undefined) set.add(r); }
    items.set(id, set);
  }

  // Product names: product definition -> formation -> product.
  const productName = (pd: number | undefined): string | null => {
    const def = get(pd);
    if (!def || !def.type.includes('PRODUCT_DEFINITION') || def.type.includes('SHAPE')) return null;
    const formation = get(ref(def.args[2]));
    const product = get(ref(formation?.args[2]));
    if (!product) return null;
    return str(product.args[1]) ?? str(product.args[0]) ?? null;
  };
  // The shape representation of each product definition, and each representation's product name.
  const pdRep = new Map<number, number>(), repProduct = new Map<number, string>(), repPd = new Map<number, number>();
  for (const [, e] of simple) {
    if (e.type !== 'SHAPE_DEFINITION_REPRESENTATION') continue;
    const pds = get(ref(e.args[0])), rep = ref(e.args[1]);
    if (!pds || rep === undefined) continue;
    const pd = ref(pds.args[2]), def = get(pd);
    if (!def || !def.type.includes('PRODUCT_DEFINITION') || def.type.includes('SHAPE')) continue;
    if (pds.type === 'PRODUCT_DEFINITION_SHAPE') { pdRep.set(pd!, rep); repPd.set(rep, pd!); }
    const name = productName(pd);
    if (name) repProduct.set(rep, name);
  }
  // Product names spread over plain relationships, as the reader does (up to four rounds).
  for (let round = 0; round < 4; round++) {
    let grew = false;
    for (const [, e] of simple) {
      if (!PLAIN_RELATIONSHIPS.includes(e.type) || e.args.length < 4) continue;
      const r1 = ref(e.args[2]), r2 = ref(e.args[3]);
      if (r1 === undefined || r2 === undefined) continue;
      for (const [x, y] of [[r1, r2], [r2, r1]] as const) if (!repProduct.has(x) && repProduct.has(y)) { repProduct.set(x, repProduct.get(y)!); grew = true; }
    }
    if (!grew) break;
  }

  // Which occurrence each placed relationship stands for (CONTEXT_DEPENDENT_SHAPE_REPRESENTATION).
  const relUsage = new Map<number, Entity>();
  for (const [, e] of simple) {
    if (e.type !== 'CONTEXT_DEPENDENT_SHAPE_REPRESENTATION') continue;
    const rel = ref(e.args[0]), pds = get(ref(e.args[1])), usage = get(ref(pds?.args[2]));
    if (rel !== undefined && usage && (usage.type.includes('ASSEMBLY_USAGE_OCCURRENCE') || usage.type === 'PRODUCT_DEFINITION_USAGE')) relUsage.set(rel, usage);
  }

  // The representation graph, child -> [parent, step], in the reader's order: placed
  // relationships first (file order), then plain relationships and mapped items.
  type Step = StepOccurrence | null;
  const parentOf = new Map<number, [number, Step][]>();
  const link = (child: number, parent: number, step: Step) => {
    const list = parentOf.get(child);
    if (list) list.push([parent, step]); else parentOf.set(child, [[parent, step]]);
  };
  for (const [id, parts] of complex) {
    const rr = parts.get('REPRESENTATION_RELATIONSHIP');
    const withTransform = parts.get('REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION');
    if (!rr || !withTransform) continue;
    const r1 = ref(rr[2]), r2 = ref(rr[3]);
    if (r1 === undefined || r2 === undefined) continue;
    const transform = get(ref(withTransform[0]));
    // The reader skips a placement it cannot compute; it computes item-defined transformations
    // and transformation operators (complex records, which `get` does not return).
    if (transform && transform.type !== 'ITEM_DEFINED_TRANSFORMATION') continue;
    let child = r1, parent = r2;
    const usage = relUsage.get(id);
    if (usage) {
      const relating = ref(usage.args[3]), related = ref(usage.args[4]);
      if ((relating !== undefined && pdRep.get(relating) === r1) || (related !== undefined && pdRep.get(related) === r2)) [child, parent] = [r2, r1];
    }
    const occurrence: StepOccurrence = usage
      ? { product: productName(ref(usage.args[4])) ?? repProduct.get(child) ?? null, instance: str(usage.args[1]) ?? str(usage.args[0]) ?? null }
      : { product: repProduct.get(child) ?? null, instance: null };
    link(child, parent, occurrence);
  }
  const productReps = new Set(pdRep.values());
  for (const [id, e] of simple) {
    if (PLAIN_RELATIONSHIPS.includes(e.type) && e.args.length >= 4) {
      const r1 = ref(e.args[2]), r2 = ref(e.args[3]);
      if (r1 === undefined || r2 === undefined) continue;
      if (productReps.has(r1) && !productReps.has(r2)) link(r2, r1, null);
      else if (productReps.has(r2) && !productReps.has(r1)) link(r1, r2, null);
      else link(r2, r1, null);
    } else if (e.type === 'MAPPED_ITEM') {
      const map = get(ref(e.args[1])), mapped = ref(map?.args[1]);
      if (mapped === undefined) continue;
      for (const [rep, its] of items) if (its.has(id)) link(mapped, rep, { product: repProduct.get(mapped) ?? null, instance: str(e.args[0]) ?? null });
    }
  }

  // Every path from a representation up to a top one, as the reader enumerates its placements.
  const cache = new Map<number, Step[][]>();
  const paths = (rep: number, depth = 0): Step[][] => {
    const cached = cache.get(rep);
    if (cached) return cached;
    const parents = parentOf.get(rep);
    if (depth > 32 || !parents) return [[{ product: repProduct.get(rep) ?? null, instance: null }]];
    const out: Step[][] = [];
    for (const [parent, step] of parents) for (const p of paths(parent, depth + 1)) out.push([...p, step]);
    const result = out.length ? out : [[{ product: repProduct.get(rep) ?? null, instance: null }]];
    cache.set(rep, result);
    return result;
  };
  const linkedMemo = new Map<number, boolean>();
  const inProduct = (rep: number, depth = 0): boolean => {
    if (!linkedMemo.has(rep)) {
      linkedMemo.set(rep, false);
      let yes = productReps.has(rep);
      if (!yes && depth < 32) for (const [parent] of parentOf.get(rep) ?? []) if (inProduct(parent, depth + 1)) { yes = true; break; }
      linkedMemo.set(rep, yes);
    }
    return linkedMemo.get(rep)!;
  };

  const bodies: StepOccurrence[][] = [], names: (string | null)[] = [];
  let assembly = false;
  for (const [id, e] of simple) {
    if (!SOLIDS.has(e.type)) continue;
    const owned = owner.get(id) ?? [];
    const placed = owned.filter(r => inProduct(r));
    const reps = placed.length ? placed : owned;
    let product = '';
    for (const r of reps) { const name = repProduct.get(r); if (name !== undefined) { product = name; break; } }
    const name = str(e.args[0]) ?? (product || null);
    const seen = new Set<string>();
    const found: StepOccurrence[][] = [];
    for (const r of reps) for (const path of paths(r)) {
      const chain = path.filter((s): s is StepOccurrence => s !== null);
      const key = JSON.stringify(chain);
      if (seen.has(key)) continue;
      seen.add(key);
      found.push(chain);
    }
    if (!found.length) found.push([{ product: product || null, instance: null }]);
    for (const chain of found) {
      if (chain.length > 1) assembly = true;
      bodies.push(chain);
      names.push(name);
    }
  }
  return { bodies, names, assembly };
}
