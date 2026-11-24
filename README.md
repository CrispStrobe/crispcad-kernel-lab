# CrispCAD

CrispCAD is agent-first parametric CAD: editable TypeScript model sources
(`.kcad.ts`), a CLI and a local MCP server, exact-geometry exports (STEP, STL, 3MF,
DXF, PDF drawings), manufacturing checks and a large CC0 parts catalog.

CrispCAD is a fork of [kernelCAD](https://github.com/w1ne/kernelCAD-web) (MIT) by
Andrii Shylenko and kernelCAD contributors. It is **not affiliated with or endorsed
by the kernelCAD project**; it is renamed as kernelCAD's
[trademark policy](TRADEMARKS.md) requires. The `.kcad.ts` source format keeps its
name for compatibility with kernelCAD models.

## Direction

- **Permissive licences only.** CrispCAD is replacing every LGPL component in its
  shipped dependency closure. The OpenCASCADE geometry kernel (LGPL-2.1 with an
  exception, bundled in `replicad-opencascadejs`) is being replaced by an exact
  B-rep kernel with an MIT/Apache licence. `npm run licence:audit` lists what remains.
- **Local first.** No telemetry by default, no hosted gateway, no deployment. See
  [TELEMETRY.md](TELEMETRY.md).
- **Integration with [Brickwright CAD](https://github.com/CrispStrobe/brickwright-cad)**
  (BSD-3-Clause), the visual workbench with Jolt simulation.

## Quick start

Requires Node.js 24.

```sh
npm ci
npm run build:cli
node dist/cli/index.js evaluate examples/bracket-with-hole.kcad.ts
node dist/cli/index.js mcp          # local MCP server over stdio
```

`npm link` installs the `crispcad` command. Run checks locally:
`npm run typecheck`, `npm test`, `npm run lint`.

## Licence

MIT; see [LICENSE](LICENSE) and [NOTICE](NOTICE). Third-party notices are in
[NOTICE](NOTICE) and `licenses/`. Catalog models carry their own content licence in
`meta()` (most are CC0-1.0).

The upstream README at the fork point is preserved in
[docs/upstream-README.md](docs/upstream-README.md) for reference; its hosted
services, install scripts and links belong to kernelCAD and do not apply here.
