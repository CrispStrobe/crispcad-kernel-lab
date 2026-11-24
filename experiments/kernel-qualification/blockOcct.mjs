// Node module hook: any attempt to load OpenCASCADE fails, so a native build
// that silently reaches for OCCT is reported as an error, not a pass.
// Usage: node --import ./experiments/kernel-qualification/blockOcct.mjs ...
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (/replicad-opencascadejs/.test(specifier)) {
      throw new Error(`OpenCASCADE blocked: import of ${specifier}`);
    }
    const r = nextResolve(specifier, context);
    if (/replicad-opencascadejs/.test(r.url)) throw new Error(`OpenCASCADE blocked: ${r.url}`);
    return r;
  },
});
