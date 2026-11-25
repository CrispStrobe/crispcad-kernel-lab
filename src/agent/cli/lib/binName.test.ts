// SPDX-License-Identifier: MIT
// Copyright (c) 2026 CrispCAD contributors
import { describe, expect, it } from 'vitest';
import { isDeprecatedBinName } from './binName';

describe('isDeprecatedBinName', () => {
  it('matches the old crispcad bin only', () => {
    expect(isDeprecatedBinName('/usr/local/bin/crispcad')).toBe(true);
    expect(isDeprecatedBinName('C:\\npm\\crispcad.cmd')).toBe(true);
    expect(isDeprecatedBinName('/usr/local/bin/crispcad-lab')).toBe(false);
    expect(isDeprecatedBinName('/repo/dist/cli/index.js')).toBe(false);
    expect(isDeprecatedBinName(undefined)).toBe(false);
  });
});
