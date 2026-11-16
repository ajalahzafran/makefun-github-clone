// Tiny HTTP response helpers shared by every surface. Every response carries
// a non-empty X-GitHub-Request-Id (the protocol checks require it on REST
// replies; it is harmless everywhere else).

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Store } from './store.ts';

/** Read a request body fully, as a Buffer. */
export function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function baseHeaders(store: Store, extra: Readonly<Record<string, string>> = {}): Record<string, string> {
  return { 'x-github-request-id': store.nextRequestId(), ...extra };
}

/** Answer with a JSON body (always `application/json`, never HTML). */
export function sendJson(
  store: Store,
  res: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders: Readonly<Record<string, string>> = {},
): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    ...baseHeaders(store, extraHeaders),
  });
  res.end(text);
}

/** Answer with raw bytes and an explicit content type. */
export function sendBytes(
  store: Store,
  res: ServerResponse,
  status: number,
  data: Buffer,
  contentType: string,
  extraHeaders: Readonly<Record<string, string>> = {},
): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': data.length,
    ...baseHeaders(store, extraHeaders),
  });
  res.end(data);
}

/** A JSON error body: `{message}`. */
export function sendError(store: Store, res: ServerResponse, status: number, message: string): void {
  sendJson(store, res, status, { message });
}

/** The bearer token a request presents, or null when it presents none. */
export function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(.+)$/.exec(header);
  return match === null ? null : (match[1] as string);
}
