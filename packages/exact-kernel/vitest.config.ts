// SPDX-License-Identifier: MIT
// Copyright (c) 2026 CrispCAD contributors
import { defineConfig } from 'vitest/config';

// One fork: smlibwasm loads its ~9 MB WASM per worker. Tests import the built bundle (dist/).
export default defineConfig({ test: { include: ['tests/**/*.test.ts'], environment: 'node', pool: 'forks', maxWorkers: 1, testTimeout: 120_000, hookTimeout: 120_000 } });
