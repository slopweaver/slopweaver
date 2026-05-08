import { resolve } from 'node:path';

/**
 * Absolute path to the directory holding the Vite-built React app
 * (`dist/client/index.html`, `dist/client/assets/*`).
 *
 * After tsc emits this file to `dist/server/static-dir.js`, the relative
 * `../client` resolves to `dist/client` — the same directory `vite build`
 * writes to.
 */
export const CLIENT_ASSETS_DIR = resolve(import.meta.dirname, '..', 'client');
