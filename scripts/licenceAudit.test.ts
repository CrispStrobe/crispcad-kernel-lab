// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
// @ts-expect-error untyped script module
import { audit, classify } from './licenceAudit.mjs';

describe('licence audit', () => {
  it('classifies SPDX expressions', () => {
    expect(classify('MIT').status).toBe('permissive');
    expect(classify('(MIT OR GPL-3.0-only)').status).toBe('permissive');
    expect(classify('Apache-2.0 AND MIT').status).toBe('permissive');
    expect(classify('Apache-2.0 AND LGPL-3.0-or-later').status).toBe('copyleft');
    expect(classify('LGPL-2.1-only WITH OCCT-exception-1.0').status).toBe('copyleft');
    expect(classify('MPL-2.0').status).toBe('copyleft');
    expect(classify('SEE LICENSE IN LICENSE').status).toBe('unknown');
    expect(classify(undefined).status).toBe('unknown');
  });

  it('does not trust an MIT wrapper around OpenCASCADE', () => {
    const findings = audit(fileURLToPath(new URL('..', import.meta.url)));
    const occt = findings.find((f: { package: string }) => f.package === 'replicad-opencascadejs');
    // Present until the exact-kernel replacement lands; then this test should be inverted.
    if (occt) expect(occt).toMatchObject({ declared: 'MIT', status: 'copyleft' });
    expect(findings.every((f: { status: string }) => f.status !== 'permissive')).toBe(true);
  });
});
