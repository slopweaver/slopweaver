// Bundles src/cli.ts → dist/cli.js, copies the Drizzle migrations folder
// next to the bundle so `migrate(db, { migrationsFolder })` resolves at
// runtime, then chmod +x's the entry so npm consumers get an executable
// `slopweaver` bin without a shell shim.
//
// Run via `pnpm --filter @slopweaver/mcp-local build` (or `pnpm build` from
// this directory). Idempotent: rm -rf dist/migrations on every invocation
// to avoid stale outputs across migration renames.

import { chmodSync, cpSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');
const distDir = resolve(here, 'dist');
const migrationsSrc = resolve(repoRoot, 'packages/db/migrations');
const migrationsDest = resolve(here, 'migrations');

const pkg = JSON.parse(readFileSync(resolve(here, 'package.json'), 'utf-8'));

rmSync(distDir, { recursive: true, force: true });
rmSync(migrationsDest, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });

await esbuild.build({
  entryPoints: [resolve(here, 'src/cli.ts')],
  outfile: resolve(distDir, 'cli.js'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  // better-sqlite3 ships native bindings (.node) that can't be bundled.
  // Stays a runtime dependency; the bundle requires it via Node's resolver.
  external: ['better-sqlite3'],
  // ESM bundles in Node need a CJS interop shim for transitive `require`
  // calls (drizzle-orm/better-sqlite3 uses one for the migrator). esbuild's
  // recommended banner.
  banner: {
    js: [
      '#!/usr/bin/env node',
      "import { createRequire as __slopweaverCreateRequire } from 'node:module';",
      'const require = __slopweaverCreateRequire(import.meta.url);',
    ].join('\n'),
  },
  define: {
    __SLOPWEAVER_VERSION__: JSON.stringify(pkg.version),
  },
  legalComments: 'none',
  logLevel: 'info',
});

cpSync(migrationsSrc, migrationsDest, { recursive: true });
chmodSync(resolve(distDir, 'cli.js'), 0o755);
