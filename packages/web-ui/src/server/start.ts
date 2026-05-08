import { createReadStream, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';
import type { SlopweaverDatabase } from '@slopweaver/db';
import { runStaticEnvChecks, type StaticEnvChecks } from './checks.ts';
import { buildDiagnosticsResponse } from './diagnostics.ts';
import { CLIENT_ASSETS_DIR } from './static-dir.ts';

export type StartWebUiServerOptions = {
  db: SlopweaverDatabase;
  /** Absolute path to the SlopWeaver data dir (e.g. `~/.slopweaver/`). */
  dataDir: string;
  host?: string;
  port?: number;
  /** Override directory of static assets (tests). */
  clientAssetsDir?: string;
  /** Override env checks (tests). */
  staticChecks?: StaticEnvChecks;
};

export type WebUiServerHandle = {
  url: string;
  address: { host: string; port: number };
  close: () => Promise<void>;
};

export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 60701;

/**
 * Format a host for use inside a URL. IPv6 addresses must be bracketed
 * (`[::1]`), all other hosts pass through unchanged.
 */
function formatHostForUrl(host: string): string {
  // Crude but sufficient: any host containing `:` is an IPv6 address.
  // Hostnames and IPv4 dotted-quad literals never contain `:`.
  return host.includes(':') ? `[${host}]` : host;
}

/**
 * Compute the set of `Origin` header values allowed for `/api/*` requests.
 *
 * Browsers loaded from the same address as the server will send
 * `Origin: <scheme>://<host>:<port>`. Always include `localhost:<port>` in
 * addition to the bound IP literal so users typing `http://localhost:N` in
 * the browser bar are not 403'd. Anything else (different host or port) is
 * cross-origin and rejected — baseline DNS-rebinding protection.
 */
function getAllowedOrigins(bindAddress: { host: string; port: number }): Set<string> {
  const origins = new Set<string>();
  origins.add(`http://${formatHostForUrl(bindAddress.host)}:${bindAddress.port}`);
  origins.add(`http://localhost:${bindAddress.port}`);
  return origins;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

export async function startWebUiServer(opts: StartWebUiServerOptions): Promise<WebUiServerHandle> {
  const requestedHost = opts.host ?? DEFAULT_HOST;
  const requestedPort = opts.port ?? DEFAULT_PORT;
  const clientAssetsDir = resolve(opts.clientAssetsDir ?? CLIENT_ASSETS_DIR);
  const staticChecks = opts.staticChecks ?? runStaticEnvChecks({ dataDir: opts.dataDir });

  // The bound port is only known after listen() resolves. Hold a mutable ref
  // and capture it by closure so the response can report the actual address
  // when callers pass `port: 0` (tests).
  const bindAddress = { host: requestedHost, port: requestedPort };

  const server = createServer(
    createHandler({ db: opts.db, staticChecks, clientAssetsDir, bindAddress }),
  );

  await listen(server, requestedPort, requestedHost);

  const addr = server.address();
  if (addr !== null && typeof addr === 'object') {
    bindAddress.port = addr.port;
    bindAddress.host = addr.address;
  }

  return {
    url: `http://${formatHostForUrl(bindAddress.host)}:${bindAddress.port}`,
    address: { host: bindAddress.host, port: bindAddress.port },
    close: () =>
      new Promise<void>((resolveClose, rejectClose) => {
        server.close((err) => {
          if (err) rejectClose(err);
          else resolveClose();
        });
      }),
  };
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolveListen, rejectListen) => {
    const onError = (err: unknown): void => {
      server.removeListener('listening', onListening);
      rejectListen(err);
    };
    const onListening = (): void => {
      server.removeListener('error', onError);
      resolveListen();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

type HandlerArgs = {
  db: SlopweaverDatabase;
  staticChecks: StaticEnvChecks;
  clientAssetsDir: string;
  bindAddress: { host: string; port: number };
};

function createHandler({
  db,
  staticChecks,
  clientAssetsDir,
  bindAddress,
}: HandlerArgs): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    const method = req.method ?? 'GET';
    const url = req.url ?? '/';
    let pathname: string;
    try {
      pathname = new URL(url, 'http://placeholder').pathname;
    } catch {
      writeText(res, 400, 'bad url\n');
      return;
    }

    if (pathname.startsWith('/api/')) {
      handleApi({ req, res, method, pathname, db, staticChecks, bindAddress });
      return;
    }

    if (method !== 'GET' && method !== 'HEAD') {
      res.writeHead(405, { 'content-type': 'text/plain', allow: 'GET, HEAD' });
      res.end('method not allowed\n');
      return;
    }
    serveStatic({ pathname, clientAssetsDir, res, headOnly: method === 'HEAD' });
  };
}

function handleApi({
  req,
  res,
  method,
  pathname,
  db,
  staticChecks,
  bindAddress,
}: {
  req: IncomingMessage;
  res: ServerResponse;
  method: string;
  pathname: string;
  db: SlopweaverDatabase;
  staticChecks: StaticEnvChecks;
  bindAddress: { host: string; port: number };
}): void {
  if (method !== 'GET' && method !== 'HEAD') {
    res.writeHead(405, { 'content-type': 'text/plain', allow: 'GET, HEAD' });
    res.end('method not allowed\n');
    return;
  }
  if (!isOriginAllowed(req, bindAddress)) {
    writeText(res, 403, 'forbidden origin\n');
    return;
  }
  if (pathname === '/api/diagnostics') {
    const body = JSON.stringify(buildDiagnosticsResponse({ db, staticChecks, bindAddress }));
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(method === 'HEAD' ? undefined : body);
    return;
  }
  writeText(res, 404, 'not found\n');
}

function isOriginAllowed(
  req: IncomingMessage,
  bindAddress: { host: string; port: number },
): boolean {
  const origin = req.headers.origin;
  // Same-origin requests from the page itself, plus curl / native fetch with
  // no Origin header, are allowed. Cross-origin requests are rejected — this
  // is baseline DNS-rebinding protection (full host-header validation is a
  // follow-up).
  if (origin === undefined) return true;
  if (typeof origin !== 'string') return false;
  return getAllowedOrigins(bindAddress).has(origin);
}

function serveStatic({
  pathname,
  clientAssetsDir,
  res,
  headOnly,
}: {
  pathname: string;
  clientAssetsDir: string;
  res: ServerResponse;
  headOnly: boolean;
}): void {
  const requested = pathname === '/' ? '/index.html' : pathname;
  const candidate = resolve(clientAssetsDir, '.' + requested);

  // Path-traversal guard: ensure the resolved path stays inside clientAssetsDir.
  const rel = relative(clientAssetsDir, candidate);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    writeText(res, 403, 'forbidden\n');
    return;
  }

  let target = candidate;
  if (!fileExists(target)) {
    // SPA fallback for unknown extensionless routes — render index.html and
    // let the client router take over.
    if (extname(requested) === '') {
      target = join(clientAssetsDir, 'index.html');
      if (!fileExists(target)) {
        writeText(res, 404, 'not found\n');
        return;
      }
    } else {
      writeText(res, 404, 'not found\n');
      return;
    }
  }

  const mime = MIME[extname(target).toLowerCase()] ?? 'application/octet-stream';
  res.writeHead(200, { 'content-type': mime, 'cache-control': 'no-cache' });
  if (headOnly) {
    res.end();
    return;
  }
  createReadStream(target).pipe(res);
}

function fileExists(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function writeText(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(body);
}
