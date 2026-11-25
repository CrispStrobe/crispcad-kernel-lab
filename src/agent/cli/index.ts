// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Andrii Shylenko and kernelCAD contributors
// src/agent/cli/index.ts
// Install the node host capabilities (filesystem port + package version) for
// the CLI process. Modeling features that read files reach node through these
// ports rather than bare node:fs imports, so the modeling API can also be
// bundled for a browser (see src/shared/runtime/hostFs.ts). Every node entry
// point installs them; this is the CLI's.
//
// Sandbox boot MUST stay the first import: it installs the fs + network
// chokepoints before any other module is evaluated (see docs/sandbox.md).
import './lib/sandboxBoot';
import '../../modeling/runtime/hostFsNode';
import '../../shared/runtime/kernelcadVersionNode';

import { HEAP_REEXEC_MARKER_ENV, maybeReexecWithLargerHeap } from './lib/heapReexec';
import { isDeprecatedBinName } from './lib/binName';
import { buildProgram } from './program';

// Mesh-heavy commands (parts/export/render/…) OOM at the default ~2 GB heap
// (gap #11). Re-exec once with a larger heap before commander parses anything;
// `npm run build:cli` bundles this entry point so `dist/cli/index.js` carries
// the guard. Fast commands are untouched.
maybeReexecWithLargerHeap();

// `crispcad` is the old name of this binary; CrispCAD itself now ships a `crispcad` CLI.
if (isDeprecatedBinName(process.argv[1]) && !process.env[HEAP_REEXEC_MARKER_ENV]) {
  console.error("crispcad: deprecated name of the CrispCAD kernel lab CLI; use 'crispcad-lab'.");
}

buildProgram().parseAsync(process.argv).catch(err => {
  console.error(err);
  process.exit(1);
});
