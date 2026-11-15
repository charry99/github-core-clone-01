// app.ts — HTTP router for the github-core-clone-01 forge entry.
//
// createApp(store) returns a node:http request handler. Routing, in order:
//   GET /healthz            -> 200 {"ok": true}, no token required
//   /api/v3/...             -> REST v3 dispatch, segments after /api/v3
//   POST /api/graphql       -> GraphQL v4 dispatch
//   POST /mcp               -> MCP dispatch
//   /<owner>/<repo>.git/... -> git smart-HTTP dispatch (upload-pack / receive-pack)
//   anything else           -> 404 {"message": "Not Found"}
//
// Every dispatch function shares one shape: it takes the store, the HTTP
// method, the path segments after the module's prefix, the query object, the
// authorization header value, and the raw request body, and returns an object
// with a numeric status, a headers record, and a body that is a string or a
// Buffer. The handler modules were written in parallel sessions, so each
// dispatch function is resolved by name from a short list of candidates when
// the app is created; createApp throws if a module exports none of them, so
// a wiring mismatch fails fast at startup instead of mid-trial.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { createStore } from './store.ts';
import * as restModule from './rest.ts';
import * as graphqlModule from './graphql.ts';
import * as mcpModule from './mcp.ts';
import * as gitModule from './git.ts';

export type Store = ReturnType<typeof createStore>;

export interface DispatchResult {
  status: number;
  headers: Record<string, string>;
  body: string | Buffer;
}

export type DispatchFn = (
  store: Store,
  method: string,
  segments: string[],
  query: Record<string, string | string[]>,
  authorization: string | undefined,
  body: Buffer,
) => DispatchResult;

type ModuleExports = Record<string, unknown>;

function resolveDispatch(moduleExports: ModuleExports, candidates: readonly string[]): DispatchFn {
  for (const name of candidates) {
    const value = moduleExports[name];
    if (typeof value === 'function') return value as DispatchFn;
  }
  const fallback = moduleExports['default'];
  if (typeof fallback === 'function') return fallback as DispatchFn;
  throw new Error(`no dispatch function found (tried: ${candidates.join(', ')})`);
}

function parseQuery(searchParams: URLSearchParams): Record<string, string | string[]> {
  const query: Record<string, string | string[]> = {};
  for (const key of new Set(searchParams.keys())) {
    const values = searchParams.getAll(key);
    query[key] = values.length === 1 ? (values[0] as string) : values;
  }
  return query;
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export function createApp(store: Store): (req: IncomingMessage, res: ServerResponse) => void {
  const dispatchRest = resolveDispatch(restModule as unknown as ModuleExports, [
    'dispatchRest',
    'dispatchREST',
    'restDispatch',
    'handleRest',
    'dispatch',
  ]);
  const dispatchGraphQL = resolveDispatch(graphqlModule as unknown as ModuleExports, [
    'dispatchGraphQL',
    'dispatchGraphql',
    'graphqlDispatch',
    'handleGraphQL',
    'dispatch',
  ]);
  const dispatchMcp = resolveDispatch(mcpModule as unknown as ModuleExports, [
    'dispatchMcp',
    'dispatchMCP',
    'mcpDispatch',
    'handleMcp',
    'dispatch',
  ]);
  const dispatchUploadPack = resolveDispatch(gitModule as unknown as ModuleExports, [
    'dispatchUploadPack',
    'handleUploadPack',
    'uploadPack',
    'uploadPackDispatch',
    'dispatchGitUploadPack',
  ]);
  const dispatchReceivePack = resolveDispatch(gitModule as unknown as ModuleExports, [
    'dispatchReceivePack',
    'handleReceivePack',
    'receivePack',
    'receivePackDispatch',
    'dispatchGitReceivePack',
  ]);

  let requestCounter = 0;

  function sendJson(res: ServerResponse, status: number, value: unknown, requestId: string): void {
    const body = JSON.stringify(value);
    res.writeHead(status, {
      'content-type': 'application/json',
      'x-github-request-id': requestId,
    });
    res.end(body);
  }

  function sendResult(res: ServerResponse, result: DispatchResult, requestId: string): void {
    const headers: Record<string, string> = { ...result.headers };
    headers['x-github-request-id'] = requestId;
    if (headers['content-type'] === undefined && typeof result.body === 'string') {
      headers['content-type'] = 'application/json';
    }
    res.writeHead(result.status, headers);
    res.end(result.body);
  }

  function route(req: IncomingMessage, res: ServerResponse, body: Buffer, requestId: string): void {
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      sendJson(res, 400, { message: 'Bad Request' }, requestId);
      return;
    }
    const method = (req.method ?? 'GET').toUpperCase();
    const pathname = url.pathname;
    const segments = pathname
      .split('/')
      .filter((part) => part.length > 0)
      .map(decodeSegment);
    const query = parseQuery(url.searchParams);
    const headerValue = req.headers.authorization;
    const authorization = Array.isArray(headerValue) ? headerValue[0] : headerValue;
    // The Link headers must carry absolute URLs on the entry's own origin
    // (the conformance client refuses to follow a relative next link), so
    // the origin the request arrived on is folded into the query object.
    const host = req.headers.host;
    if (typeof host === 'string' && host !== '') {
      query['__origin'] = `http://${host}`;
    }
    // The shared dispatch shape carries no headers, so the one header a git
    // handler needs — Git-Protocol: version=2, which asks for the protocol v2
    // advertisement — is folded into the query object for it to read.
    const gitProtocol = req.headers['git-protocol'];
    if (typeof gitProtocol === 'string' && gitProtocol !== '') {
      query['git-protocol'] = gitProtocol;
    }

    try {
      if (method === 'GET' && pathname === '/healthz') {
        sendJson(res, 200, { ok: true }, requestId);
        return;
      }

      if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
        const restSegments = segments.slice(2);
        sendResult(res, dispatchRest(store, method, restSegments, query, authorization, body), requestId);
        return;
      }

      if (method === 'POST' && pathname === '/api/graphql') {
        sendResult(res, dispatchGraphQL(store, method, [], query, authorization, body), requestId);
        return;
      }

      if (method === 'POST' && pathname === '/mcp') {
        sendResult(res, dispatchMcp(store, method, [], query, authorization, body), requestId);
        return;
      }

      if (segments.length >= 2 && (segments[1] as string).endsWith('.git')) {
        const gitSegments = segments.slice(2);
        const service = query['service'];
        if (method === 'GET' && gitSegments[0] === 'info' && gitSegments[1] === 'refs') {
          if (service === 'git-receive-pack') {
            sendResult(res, dispatchReceivePack(store, method, segments, query, authorization, body), requestId);
          } else {
            sendResult(res, dispatchUploadPack(store, method, segments, query, authorization, body), requestId);
          }
          return;
        }
        if (method === 'POST' && gitSegments[0] === 'git-upload-pack') {
          sendResult(res, dispatchUploadPack(store, method, segments, query, authorization, body), requestId);
          return;
        }
        if (method === 'POST' && gitSegments[0] === 'git-receive-pack') {
          sendResult(res, dispatchReceivePack(store, method, segments, query, authorization, body), requestId);
          return;
        }
        sendJson(res, 404, { message: 'Not Found' }, requestId);
        return;
      }

      sendJson(res, 404, { message: 'Not Found' }, requestId);
    } catch (err) {
      process.stderr.write(`dispatch error: ${err instanceof Error ? err.message : String(err)}\n`);
      if (!res.headersSent) {
        sendJson(res, 500, { message: 'Internal Server Error' }, requestId);
      } else {
        res.end();
      }
    }
  }

  return (req: IncomingMessage, res: ServerResponse): void => {
    const requestId = `req-${++requestCounter}`;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    req.on('error', () => {
      if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' }, requestId);
    });
    req.on('end', () => {
      route(req, res, Buffer.concat(chunks), requestId);
    });
  };
}
