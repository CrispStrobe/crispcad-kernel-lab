# CrispCAD kernel lab

The CrispCAD kernel lab is where the exact geometry kernel of
[CrispCAD](https://github.com/CrispStrobe/CrispCAD) is built and tested. It is a
workbench for that kernel, not an end-user CAD application. Use
[CrispCAD](https://github.com/CrispStrobe/CrispCAD) for modeling.

```
crispcad-kernel-lab ──(@crispcad/exact-kernel, MIT + Apache-2.0)──▶ CrispCAD ──(SDK)──▶ BrickWright
```

## What the lab produces

- **[`@crispcad/exact-kernel`](packages/exact-kernel)**, an exact B-rep kernel
  that does not use OpenCASCADE.
  - It is built on SMLib (Apache-2.0) through the `@classcad/smlibwasm` bindings
    (MIT).
  - Every file it ships is MIT or Apache-2.0; the bindings' OFL font is stubbed out,
    and a test checks the packed tarball.
  - It is released as a tarball on the `exact-kernel-v*` tags, and CrispCAD pins
    those releases. It is not published to npm.
- **Qualification evidence** for the kernel:
  - 27 reference parts with analytic volume, area and bounding box, checked at 1e-6
    relative tolerance;
  - a 2,402-model catalog, of which 2,391 (99.5%) build natively with OpenCASCADE
    blocked from loading;
  - native mated assemblies, cross-checked against an OpenCASCADE reference build.

  See [docs/kernels.md](docs/kernels.md) and
  [experiments/kernel-qualification](experiments/kernel-qualification).
- **A reference pipeline** to test the kernel against. It is a TypeScript modeling
  API with model scripts (`.kcad.ts`), a CLI (`crispcad-lab`), a local MCP server,
  and STEP/STL export. It still uses OpenCASCADE as the comparison kernel, which is
  how native results are checked.

## Kernels

| id | geometry | status |
| --- | --- | --- |
| `occt` | OpenCASCADE (LGPL-2.1 with exception) | reference for comparisons; default for the lab's own tools |
| `smlib-native` | SMLib, via `@classcad/smlibwasm` | builds without OpenCASCADE; STEP and STL export |

To select the native kernel, use `crispcad-lab --kernel smlib-native <command>` or
set `CRISPCAD_LAB_KERNEL=smlib-native`. An unknown or unsupported kernel is an
explicit error; nothing quietly falls back to OpenCASCADE.

## Quick start

Requires Node.js 24.

```sh
npm ci
npm run build:cli
node dist/cli/index.js --kernel smlib-native evaluate examples/bracket-with-hole.kcad.ts
npm run build:exact-kernel && npm run test:exact-kernel
```

`npm link` installs the `crispcad-lab` command. The old name `crispcad` still works
with a deprecation notice, because CrispCAD ships its own `crispcad` CLI.

Run checks locally:

- `npm run typecheck`
- `npm test`
- `npm run lint`
- `npm run licence:audit`

GitHub workflows are not enabled.

## Direction

- **Permissive licences only.** The goal is that no shipped file is LGPL.
  `npm run licence:audit` lists what remains. Today that is OpenCASCADE, kept
  only as the comparison kernel.
- **Gaps in the native kernel**, in priority order:
  - sweeps along curved rails;
  - holes on side faces;
  - sketches with several loops;
  - lofts with sections off the XY plane;
  - connectors placed by face or edge queries.
- **Local first.** No telemetry by default, no hosted services, no deployment. See
  [TELEMETRY.md](TELEMETRY.md).

## Licence and origin

MIT; see [LICENSE](LICENSE) and [NOTICE](NOTICE). Third-party licences are in
`licenses/`. Catalog models carry their own content licence in `meta()`; most are
CC0-1.0.

The lab started as a fork of an MIT-licensed project, kernelCAD, and keeps its
copyright notices as the MIT licence requires. It is a separately named project,
not affiliated with or endorsed by kernelCAD, and does not use its name or logo.
See [TRADEMARKS.md](TRADEMARKS.md). The `.kcad.ts` extension is kept so that
existing model files stay compatible.
