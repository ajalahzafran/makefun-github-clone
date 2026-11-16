// The HTTP server: one process, one store, four surfaces. Routing is by path
// prefix; git smart HTTP, REST v3, GraphQL and MCP all require the shop
// bearer token, `/healthz` does not, and anything else is a JSON 404. A
// handler that throws answers 500 JSON and the server keeps serving.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { splitTarget } from './util.ts';
import { bearerToken, readBody, sendError, sendJson } from './respond.ts';
import { handleInfoRefs, handleUploadPack, handleReceivePack } from './githttp.ts';
import { handleRest } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): Server {
  const store = new Store();
  const expectedToken = process.env.MAKEFUN_SHOP_TOKEN ?? '';

  /** Whether the request presents the shop token (any non-empty token when none is configured). */
  const authorized = (req: IncomingMessage): boolean => {
    const token = bearerToken(req);
    if (token === null || token === '') return false;
    if (expectedToken === '') return true;
    return token === expectedToken;
  };

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        await dispatch(store, expectedToken, authorized, req, res);
      } catch (err) {
        if (!res.headersSent) {
          sendError(store, res, 500, err instanceof Error ? err.message : 'internal error');
        } else {
          try {
            res.end();
          } catch {
            // The response is already gone; nothing more to do.
          }
        }
      }
    })();
  });
}

async function dispatch(
  store: Store,
  expectedToken: string,
  authorized: (req: IncomingMessage) => boolean,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  void expectedToken;
  const method = req.method ?? 'GET';
  const { segments, query } = splitTarget(req.url ?? '/');

  // The env's boot probe: 200 {"ok":true}, no token.
  if (method === 'GET' && segments.length === 1 && segments[0] === 'healthz') {
    sendJson(store, res, 200, { ok: true });
    return;
  }

  // GitHub REST v3.
  if (segments.length >= 2 && segments[0] === 'api' && segments[1] === 'v3') {
    if (!authorized(req)) {
      sendError(store, res, 401, 'Requires authentication');
      return;
    }
    await handleRest(store, req, res, segments.slice(2), query);
    return;
  }

  // GitHub GraphQL v4.
  if (segments.length === 2 && segments[0] === 'api' && segments[1] === 'graphql') {
    if (!authorized(req)) {
      sendError(store, res, 401, 'Requires authentication');
      return;
    }
    await handleGraphql(store, req, res);
    return;
  }

  // Model Context Protocol.
  if (segments.length === 1 && segments[0] === 'mcp') {
    if (!authorized(req)) {
      sendError(store, res, 401, 'Requires authentication');
      return;
    }
    await handleMcp(store, req, res);
    return;
  }

  // Git smart HTTP: /{owner}/{repo}.git/info/refs,
  // /{owner}/{repo}.git/git-upload-pack, /{owner}/{repo}.git/git-receive-pack.
  if (segments.length >= 3 && segments[1] !== undefined && segments[1].endsWith('.git')) {
    if (!authorized(req)) {
      sendError(store, res, 401, 'Requires authentication');
      return;
    }
    const owner = segments[0] as string;
    const repoName = (segments[1] as string).slice(0, -'.git'.length);
    const service = segments[2] as string;
    if (service === 'info' && segments[3] === 'refs' && method === 'GET') {
      handleInfoRefs(store, req, res, owner, repoName, query.get('service'));
      return;
    }
    if (service === 'git-upload-pack' && method === 'POST') {
      const body = await readBody(req);
      handleUploadPack(store, req, res, owner, repoName, body);
      return;
    }
    if (service === 'git-receive-pack' && method === 'POST') {
      const body = await readBody(req);
      handleReceivePack(store, req, res, owner, repoName, body);
      return;
    }
    sendError(store, res, 404, 'Not Found');
    return;
  }

  // Everything else: GitHub's 404 body.
  sendError(store, res, 404, 'Not Found');
}
