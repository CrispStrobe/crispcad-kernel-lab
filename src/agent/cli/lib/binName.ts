// SPDX-License-Identifier: MIT
// Copyright (c) 2026 CrispCAD contributors

/** True when the CLI was started through its deprecated `crispcad` bin name. */
export function isDeprecatedBinName(scriptPath: string | undefined): boolean {
  return /(^|[\\/])crispcad(\.cmd|\.ps1)?$/i.test(scriptPath ?? '');
}
