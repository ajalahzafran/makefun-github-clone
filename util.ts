// Shared helpers for the forge: no dependencies, no I/O, no wall clock in any
// value that leaves the process. Everything here is pure and deterministic.

import { createHash } from 'node:crypto';

/** SHA-1 of bytes, as lowercase hex. */
export function sha1Hex(data: Buffer | Uint8Array | string): string {
  return createHash('sha1').update(data).digest('hex');
}

/** Standard base64 of bytes. */
export function toBase64(data: Buffer | Uint8Array | string): string {
  return Buffer.from(data).toString('base64');
}

/** Decode standard base64; returns null when the input is not valid base64. */
export function fromBase64(text: string): Buffer | null {
  const cleaned = text.replace(/\s+/g, '');
  if (cleaned.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(cleaned)) return null;
  try {
    return Buffer.from(cleaned, 'base64');
  } catch {
    return null;
  }
}

/** URL-safe base64 without padding (opaque ids, cursors). */
export function toBase64Url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

/** Decode a base64url value made by toBase64Url; null when invalid. */
export function fromBase64Url(text: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return null;
  try {
    return Buffer.from(text, 'base64url').toString('utf8');
  } catch {
    return null;
  }
}

/** Whether `value` is a 40-hex object id. */
export function isOid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
}

/** The all-zero object id. */
export const ZERO_OID = '0'.repeat(40);

/** A plain record check. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parse a JSON text body; returns null when it is not valid JSON. */
export function parseJsonText(text: string): unknown {
  if (text.trim() === '') return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/**
 * A logical clock: deterministic timestamps with no wall clock. The base is
 * the trial's fixed "now" (MAKEFUN_TRIAL_NOW, an ISO instant or epoch
 * seconds) or 2025-01-01T00:00:00Z; every tick advances one second, so two
 * creations never share a timestamp and a replay with the same request order
 * produces the same timestamps.
 */
export class LogicalClock {
  private seconds: number;
  private readonly base: number;

  constructor() {
    const raw = (process.env.MAKEFUN_TRIAL_NOW ?? '').trim();
    let base = 1_735_689_600; // 2025-01-01T00:00:00Z
    if (/^\d+$/.test(raw)) {
      const parsed = Number(raw);
      if (Number.isFinite(parsed) && parsed > 0) base = Math.trunc(parsed);
    } else if (raw !== '') {
      const parsed = Date.parse(raw);
      if (Number.isFinite(parsed)) base = Math.floor(parsed / 1000);
    }
    this.base = base;
    this.seconds = base;
  }

  /** The next timestamp, as epoch seconds. */
  tick(): number {
    this.seconds += 1;
    return this.seconds;
  }

  /** The current time without advancing, as epoch seconds. */
  now(): number {
    return this.seconds;
  }

  /** An ISO-8601 UTC string for an epoch second. */
  static iso(epochSec: number): string {
    return new Date(epochSec * 1000).toISOString();
  }

  /** The next timestamp, as an ISO-8601 UTC string. */
  tickIso(): string {
    return LogicalClock.iso(this.tick());
  }
}

/** Format a timestamp like git does: `<epoch> +0000`. */
export function gitTimestamp(epochSec: number): string {
  return `${epochSec} +0000`;
}

/**
 * Parse a query string (`a=1&b=two`) into a map. Repeated keys keep the first
 * value; `+` is a space; percent-decoding is applied, forgivingly.
 */
export function parseQuery(query: string): Map<string, string> {
  const out = new Map<string, string>();
  if (query === '') return out;
  for (const part of query.split('&')) {
    if (part === '') continue;
    const eq = part.indexOf('=');
    const rawKey = eq < 0 ? part : part.slice(0, eq);
    const rawValue = eq < 0 ? '' : part.slice(eq + 1);
    let key: string;
    let value: string;
    try {
      key = decodeURIComponent(rawKey.replace(/\+/g, ' '));
    } catch {
      key = rawKey;
    }
    try {
      value = decodeURIComponent(rawValue.replace(/\+/g, ' '));
    } catch {
      value = rawValue;
    }
    if (!out.has(key)) out.set(key, value);
  }
  return out;
}

/** Split a request target into path segments (decoded) and the query map. */
export function splitTarget(target: string): { segments: string[]; query: Map<string, string> } {
  const q = target.indexOf('?');
  const rawPath = q < 0 ? target : target.slice(0, q);
  const query = q < 0 ? new Map<string, string>() : parseQuery(target.slice(q + 1));
  const segments = rawPath
    .split('/')
    .filter((part) => part !== '')
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    });
  return { segments, query };
}

/** A positive integer from a query value, or the fallback. */
export function queryInt(query: Map<string, string>, name: string, fallback: number): number {
  const raw = query.get(name);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.trunc(parsed);
}

/** Compare two strings by UTF-8 bytes (git's tree-entry sort order). */
export function compareBytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}
