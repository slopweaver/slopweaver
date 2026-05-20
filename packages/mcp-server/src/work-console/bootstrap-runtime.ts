/**
 * Default Writers implementation for `runBootstrapWorkConsole`. Lives in
 * a separate file so the bootstrap module itself stays pure +
 * testable — this file does the real fs touches.
 */

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export type DefaultWritersResult = {
  fileExists: (absPath: string) => Promise<boolean>;
  readFile: (absPath: string) => Promise<string | null>;
  writeFile: (absPath: string, content: string) => Promise<{ bytesWritten: number; created: boolean }>;
  mkdir: (absPath: string) => Promise<void>;
};

export function defaultBootstrapWriters(): DefaultWritersResult {
  return {
    fileExists: async (absPath) => {
      // Treat any stat failure as "file is missing". The bootstrap is
      // idempotent, so a false negative just means we re-create a file
      // that may already exist — atomic-write tolerates that. Avoids
      // rethrowing inside the service-boundary scanned dir.
      try {
        await stat(absPath);
        return true;
      } catch {
        return false;
      }
    },
    readFile: async (absPath) => {
      // Same treatment as fileExists — best-effort read, null on any
      // failure. The caller (bootstrap-work-console.ts) only uses this
      // to decide whether to append the import line to CLAUDE.md; null
      // means "treat as missing" which is the right fallback.
      try {
        return await readFile(absPath, 'utf-8');
      } catch {
        return null;
      }
    },
    writeFile: async (absPath, content) => {
      const dir = dirname(absPath);
      await mkdir(dir, { recursive: true });
      let created = true;
      try {
        await stat(absPath);
        created = false;
      } catch {
        // file doesn't exist — fine, we're creating it.
      }
      await writeFile(absPath, content, { encoding: 'utf-8', mode: 0o644 });
      return {
        bytesWritten: Buffer.byteLength(content, 'utf-8'),
        created,
      };
    },
    mkdir: async (absPath) => {
      await mkdir(absPath, { recursive: true });
    },
  };
}
