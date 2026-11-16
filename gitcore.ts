// The git object model: pkt-lines, packs (read with delta resolution, write
// undeltified), tree/commit/tag parse and build, reachability, diffs and
// three-way merges. Objects are stored verbatim and never re-serialized on
// read, so a clone returns byte-exact copies of what was pushed.

import { deflateSync, inflateSync } from 'node:zlib';
import { isOid, ZERO_OID, compareBytes, sha1Hex } from './util.ts';
import { hashObject, type GitObject, type ObjectType, type Repo, type Store } from './store.ts';

// ---------------------------------------------------------------- pkt-line

/** One pkt-line: a 4-hex length (including the length itself) + payload. */
export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const head = Buffer.from((data.length + 4).toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, data]);
}

/** The flush packet (`0000`). */
export const PKT_FLUSH = Buffer.from('0000', 'ascii');
/** The delimiter packet (`0001`). */
export const PKT_DELIM = Buffer.from('0001', 'ascii');

/**
 * Encode a list of lines: strings and Buffers become pkt-lines, 'flush' and
 * 'delim' become their control packets.
 */
export function pktLines(items: ReadonlyArray<string | Buffer | 'flush' | 'delim'>): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(PKT_FLUSH);
    else if (item === 'delim') parts.push(PKT_DELIM);
    else parts.push(pktLine(item));
  }
  return Buffer.concat(parts);
}

export type PktKind = 'data' | 'flush' | 'delim';
export interface Pkt {
  kind: PktKind;
  payload: Buffer;
}

/**
 * Decode a whole buffer of pkt-lines. Throws on a malformed length; trailing
 * raw bytes (the pack after a receive-pack command list, or sideband data)
 * are returned as `rest`.
 */
export function decodePktLines(buffer: Buffer): { packets: Pkt[]; rest: Buffer } {
  const packets: Pkt[] = [];
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const head = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-f]{4}$/.test(head)) break;
    const length = parseInt(head, 16);
    if (length === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > buffer.length) break;
    packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, rest: buffer.subarray(offset) };
}

// ---------------------------------------------------------------- trees, commits, tags

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree object into its entries, in stored order. */
export function parseTree(data: Buffer | Uint8Array): TreeEntry[] {
  const buffer = Buffer.from(data);
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const space = buffer.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = buffer.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > buffer.length) throw new Error('tree entry is truncated');
    entries.push({
      mode: buffer.subarray(offset, space).toString('ascii'),
      name: buffer.subarray(space + 1, nul).toString('utf8'),
      oid: buffer.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

/** git's tree-entry sort: byte order of the name, a directory as `name/`. */
function compareTreeEntries(a: TreeEntry, b: TreeEntry): number {
  const left = a.mode === '40000' ? `${a.name}/` : a.name;
  const right = b.mode === '40000' ? `${b.name}/` : b.name;
  return compareBytes(left, right);
}

/** Build a tree object from entries, sorted the way git sorts them. */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeEntries);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** Parse a commit object. */
export function parseCommit(data: Buffer | Uint8Array): CommitView {
  const buffer = Buffer.from(data);
  const blank = buffer.indexOf('\n\n');
  const headerEnd = blank < 0 ? buffer.length : blank;
  const message = blank < 0 ? '' : buffer.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of buffer.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  if (!isOid(tree)) throw new Error('commit has no valid tree header');
  return { tree, parents, author, committer, message };
}

export interface TagView {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

/** Parse an annotated tag object. */
export function parseTag(data: Buffer | Uint8Array): TagView {
  const buffer = Buffer.from(data);
  const blank = buffer.indexOf('\n\n');
  const headerEnd = blank < 0 ? buffer.length : blank;
  const headers = new Map<string, string>();
  for (const line of buffer.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space < 0) continue;
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  return {
    object: headers.get('object') ?? '',
    type: headers.get('type') ?? '',
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : buffer.subarray(blank + 2).toString('utf8'),
  };
}

/** Build a commit object's bytes. `who` is `Name <email>`; timestamp is epoch seconds. */
export function buildCommit(fields: {
  tree: string;
  parents?: readonly string[];
  message: string;
  author: string;
  committer: string;
  timestamp: number;
}): Buffer {
  const stamp = `${fields.timestamp} +0000`;
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents ?? []) lines.push(`parent ${parent}`);
  lines.push(`author ${fields.author} ${stamp}`, `committer ${fields.committer} ${stamp}`, '');
  const message = fields.message.endsWith('\n') ? fields.message : `${fields.message}\n`;
  return Buffer.from(`${lines.join('\n')}\n${message}`, 'utf8');
}

// ---------------------------------------------------------------- packs

const TYPE_CODE: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** Encode one object's pack header (type/size varint). */
function packObjectHeader(type: ObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/**
 * Build a packfile from plain objects (no deltas). Version 2, entries in the
 * caller's order, SHA-1 trailer over everything before it.
 */
export function writePack(objects: ReadonlyArray<{ type: ObjectType; data: Buffer }>): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(packObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, Buffer.from(sha1Hex(body), 'hex')]);
}

/** Read a pack entry's type/size varint. */
function readPackVarint(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  if (start >= buffer.length) throw new Error('pack entry has no size header');
  let byte = buffer[start] as number;
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('pack entry size is truncated');
    byte = buffer[offset] as number;
    size |= (byte & 0x7f) << shift;
    shift += 7;
    offset += 1;
  }
  return { size, next: offset, first };
}

/** Read an ofs-delta base offset (git's encoding). */
function readOfsBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  if (start >= buffer.length) throw new Error('ofs-delta base is truncated');
  let byte = buffer[start] as number;
  let offset = byte & 0x7f;
  let pos = start + 1;
  while (byte & 0x80) {
    if (pos >= buffer.length) throw new Error('ofs-delta base is truncated');
    byte = buffer[pos] as number;
    pos += 1;
    offset = ((offset + 1) << 7) | (byte & 0x7f);
  }
  return { baseOffset: offset, next: pos };
}

/**
 * Inflate the deflated stream starting at `start`, stopping at `limit`
 * (exclusive). `inflateSync` ignores trailing bytes and throws on truncation,
 * so a binary search finds the exact stream end.
 */
function inflateAt(buffer: Buffer, start: number, limit: number, declaredSize: number): { data: Buffer; next: number } {
  let low = start + 1;
  let high = limit;
  let found = -1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    try {
      const data = inflateSync(buffer.subarray(start, mid));
      if (data.length === declaredSize) {
        found = mid;
        high = mid - 1;
      } else if (data.length < declaredSize) {
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    } catch {
      low = mid + 1;
    }
  }
  if (found < 0) throw new Error('pack entry deflate stream does not terminate');
  return { data: inflateSync(buffer.subarray(start, found)), next: found };
}

/** Apply a git delta to a base object. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (pos >= delta.length) throw new Error('delta varint is truncated');
      const byte = delta[pos] as number;
      pos += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  const targetSize = readVarint();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const out: Buffer[] = [];
  let outLen = 0;
  while (pos < delta.length) {
    const op = delta[pos] as number;
    pos += 1;
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      for (let i = 0; i < 4; i += 1) {
        if (op & (1 << i)) {
          if (pos >= delta.length) throw new Error('delta copy offset is truncated');
          offset |= (delta[pos] as number) << (i * 8);
          pos += 1;
        }
      }
      for (let i = 0; i < 3; i += 1) {
        if (op & (0x10 << i)) {
          if (pos >= delta.length) throw new Error('delta copy size is truncated');
          size |= (delta[pos] as number) << (i * 8);
          pos += 1;
        }
      }
      if (size === 0) size = 0x10000;
      if (offset + size > base.length) throw new Error('delta copy runs past the base');
      out.push(base.subarray(offset, offset + size));
      outLen += size;
    } else if (op !== 0) {
      if (pos + op > delta.length) throw new Error('delta literal is truncated');
      out.push(delta.subarray(pos, pos + op));
      pos += op;
      outLen += op;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  if (outLen !== targetSize) throw new Error('delta target size mismatch');
  return Buffer.concat(out);
}

interface RawEntry {
  offset: number;
  typeCode: number;
  size: number;
  data: Buffer;
  baseOffset?: number;
  baseOid?: string;
  resolved?: { type: ObjectType; data: Buffer; oid: string };
}

/**
 * Read a packfile (version 2 or 3) and resolve every object, including
 * OFS_DELTA and REF_DELTA. A thin pack's missing base is supplied by
 * `resolveBase` (the store lookup). Throws on a bad checksum, a truncated
 * entry, a size mismatch or an unresolvable delta.
 */
export function readPack(
  pack: Buffer,
  resolveBase?: (oid: string) => GitObject | undefined,
): { objects: Map<string, GitObject>; deltaCount: number } {
  if (pack.length < 32) throw new Error('pack is too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  if (sha1Hex(pack.subarray(0, trailerStart)) !== trailer) throw new Error('pack trailer checksum mismatch');

  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readPackVarint(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawEntry = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsBase(pack, offset);
      offset = base.next;
      if (base.baseOffset <= 0 || base.baseOffset > entryOffset) throw new Error('ofs-delta names an invalid base offset');
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      if (offset + 20 > trailerStart) throw new Error('ref-delta base id is truncated');
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (CODE_TYPE[typeCode] === undefined) {
      throw new Error(`pack entry ${index} has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(pack, offset, trailerStart, header.size);
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error('pack has stray bytes before its trailer');

  const objects = new Map<string, GitObject>();
  const resolvedByOid = new Map<string, RawEntry>();
  const resolving = new Set<number>();
  const resolve = (entry: RawEntry): { type: ObjectType; data: Buffer; oid: string } => {
    if (entry.resolved !== undefined) return entry.resolved;
    if (resolving.has(entry.offset)) throw new Error('delta cycle in pack');
    resolving.add(entry.offset);
    let type: ObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset as number);
      if (baseEntry === undefined) throw new Error('ofs-delta base is not in the pack');
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid as string;
      const baseEntry = resolvedByOid.get(wanted);
      if (baseEntry !== undefined) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = resolveBase?.(wanted);
        if (external === undefined) throw new Error(`ref-delta base ${wanted} is not in the pack or the store`);
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode] as ObjectType;
      data = entry.data;
    }
    const oid = hashObject(type, data);
    const resolved = { type, data, oid };
    entry.resolved = resolved;
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return resolved;
  };

  let deltaCount = 0;
  for (const entry of raw) {
    const resolved = resolve(entry);
    if (entry.typeCode === 6 || entry.typeCode === 7) deltaCount += 1;
    if (!objects.has(resolved.oid)) objects.set(resolved.oid, { type: resolved.type, data: resolved.data });
  }
  return { objects, deltaCount };
}

// ---------------------------------------------------------------- reachability

/**
 * Every object reachable from `roots`: commit → tree + parents, tag → target,
 * tree → entries (gitlinks skipped), blob → nothing. Throws on a missing
 * object unless `allowMissing` is set.
 */
export function collectReachable(
  repo: Repo,
  roots: Iterable<string>,
  options: { allowMissing?: boolean } = {},
): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (isOid(root) && root !== ZERO_OID) queue.push(root);
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object === undefined) {
      if (options.allowMissing) continue;
      throw new Error(`object ${oid} is missing from the store`);
    }
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      for (const parent of commit.parents) queue.push(parent);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue;
        queue.push(entry.oid);
      }
    }
  }
  return seen;
}

/**
 * The closure of `wants` where commit parents are followed only while the
 * generation is below `depth`; commits at exactly `depth` generations are the
 * boundary. `stopAt` commits are treated as shallow (their parents are not
 * followed) — the client's current shallow boundary on the haves side.
 */
export function collectDepth(
  repo: Repo,
  wants: readonly string[],
  depth: number | null,
  stopAt?: ReadonlySet<string>,
): { objects: Set<string>; boundary: Set<string> } {
  const objects = new Set<string>();
  const boundary = new Set<string>();
  const visitedCommits = new Set<string>();
  const queue: Array<{ oid: string; generation: number }> = [];
  for (const want of wants) {
    if (isOid(want) && want !== ZERO_OID) queue.push({ oid: want, generation: 0 });
  }
  while (queue.length > 0) {
    const { oid, generation } = queue.pop() as { oid: string; generation: number };
    if (objects.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object === undefined) continue;
    objects.add(oid);
    if (object.type === 'commit') {
      if (visitedCommits.has(oid)) continue;
      visitedCommits.add(oid);
      const commit = parseCommit(object.data);
      queue.push({ oid: commit.tree, generation });
      if (stopAt !== undefined && stopAt.has(oid)) {
        boundary.add(oid);
        continue;
      }
      // Depth N means N generations from the tip: a commit at generation
      // N-1 is the boundary (its parents are not followed). Depth 1 makes
      // the tip itself the shallow boundary.
      if (depth !== null && generation >= depth - 1) {
        boundary.add(oid);
        continue;
      }
      for (const parent of commit.parents) queue.push({ oid: parent, generation: generation + 1 });
    } else if (object.type === 'tag') {
      queue.push({ oid: parseTag(object.data).object, generation });
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue;
        queue.push({ oid: entry.oid, generation });
      }
    }
  }
  return { objects, boundary };
}

/** Peel a ref target to its commit: a tag object follows to its target. */
export function peelToCommit(repo: Repo, oid: string): string | undefined {
  let current = oid;
  for (let i = 0; i < 10; i += 1) {
    const object = repo.objects.get(current);
    if (object === undefined) return undefined;
    if (object.type === 'commit') return current;
    if (object.type === 'tag') {
      current = parseTag(object.data).object;
      continue;
    }
    return undefined;
  }
  return undefined;
}

// ---------------------------------------------------------------- trees as flat maps

export interface FlatEntry {
  oid: string;
  mode: string;
}

/** A tree flattened to `path → {oid, mode}`, following nested trees. */
export function flattenTree(repo: Repo, treeOid: string): Map<string, FlatEntry> {
  const out = new Map<string, FlatEntry>();
  const walk = (oid: string, prefix: string): void => {
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  };
  walk(treeOid, '');
  return out;
}

/**
 * Build nested tree objects from a flat `path → {oid, mode}` map, storing
 * them in the repo. Returns the root tree oid.
 */
export function buildTreeFromFlat(store: Store, repo: Repo, flat: Map<string, FlatEntry>): string {
  interface Node {
    files: Map<string, FlatEntry>;
    dirs: Map<string, Node>;
  }
  const makeNode = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = makeNode();
  for (const [path, entry] of [...flat.entries()].sort((a, b) => compareBytes(a[0], b[0]))) {
    const segments = path.split('/');
    let node = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const segment = segments[i] as string;
      let child = node.dirs.get(segment);
      if (child === undefined) {
        child = makeNode();
        node.dirs.set(segment, child);
      }
      node = child;
    }
    node.files.set(segments[segments.length - 1] as string, entry);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return store.putObject(repo, 'tree', buildTree(entries));
  };
  return build(root);
}

/** Split text into lines, each keeping its terminator (except possibly the last). */
function splitLinesKeepEnds(text: string): string[] {
  if (text === '') return [];
  return text.split(/(?<=\n)/);
}

/** Split text into lines without the trailing newline (empty text → []). */
function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

interface LineHunk {
  oldStart: number;
  oldEnd: number;
  newLines: string[];
}

/**
 * The changed regions between two line lists, via a full LCS table with
 * backtracking. Each hunk covers a maximal run of changed lines. Returns
 * null when the table would be too large; the caller then treats the file
 * as a whole-file change.
 */
function diffHunks(oldLines: string[], newLines: string[]): LineHunk[] | null {
  const n = oldLines.length;
  const m = newLines.length;
  if (n * m > 4_000_000) return null;
  const width = m + 1;
  const dp = new Uint32Array((n + 1) * width);
  for (let i = 1; i <= n; i += 1) {
    for (let j = 1; j <= m; j += 1) {
      dp[i * width + j] =
        oldLines[i - 1] === newLines[j - 1]
          ? (dp[(i - 1) * width + (j - 1)] as number) + 1
          : Math.max(dp[(i - 1) * width + j] as number, dp[i * width + (j - 1)] as number);
    }
  }
  // Backtrack into an edit script: ' ' match, '-' deletion, '+' insertion.
  const ops: Array<' ' | '-' | '+'> = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      ops.push(' ');
      i -= 1;
      j -= 1;
    } else if (j > 0 && (i === 0 || (dp[i * width + (j - 1)] as number) >= (dp[(i - 1) * width + j] as number))) {
      ops.push('+');
      j -= 1;
    } else {
      ops.push('-');
      i -= 1;
    }
  }
  ops.reverse();
  const hunks: LineHunk[] = [];
  let oldPos = 0;
  let newPos = 0;
  let k = 0;
  while (k < ops.length) {
    if (ops[k] === ' ') {
      oldPos += 1;
      newPos += 1;
      k += 1;
      continue;
    }
    const start = oldPos;
    const lines: string[] = [];
    while (k < ops.length && ops[k] !== ' ') {
      if (ops[k] === '-') oldPos += 1;
      else {
        lines.push(newLines[newPos] as string);
        newPos += 1;
      }
      k += 1;
    }
    hunks.push({ oldStart: start, oldEnd: oldPos, newLines: lines });
  }
  return hunks;
}

function sameLines(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * A line-level three-way merge of two texts against their common ancestor.
 * Returns the merged text, or null when both sides changed an overlapping
 * region differently. Non-overlapping changes combine; identical changes on
 * both sides are taken once.
 */
export function mergeLines(baseText: string, oursText: string, theirsText: string): string | null {
  const base = splitLinesKeepEnds(baseText);
  const ours = splitLinesKeepEnds(oursText);
  const theirs = splitLinesKeepEnds(theirsText);
  const hunksA = diffHunks(base, ours);
  const hunksB = diffHunks(base, theirs);
  if (hunksA === null || hunksB === null) {
    // Too large for a line table: only an identical change merges.
    return oursText === theirsText ? oursText : null;
  }
  const out: string[] = [];
  let pos = 0;
  let a = 0;
  let b = 0;
  const emitBase = (until: number): void => {
    while (pos < until) {
      out.push(base[pos] as string);
      pos += 1;
    }
  };
  while (a < hunksA.length || b < hunksB.length) {
    const ha = hunksA[a];
    const hb = hunksB[b];
    if (ha !== undefined && hb !== undefined && ha.oldStart === hb.oldStart && ha.oldEnd === hb.oldEnd && sameLines(ha.newLines, hb.newLines)) {
      emitBase(ha.oldStart);
      out.push(...ha.newLines);
      pos = ha.oldEnd;
      a += 1;
      b += 1;
      continue;
    }
    if (ha !== undefined && hb !== undefined) {
      const overlap = Math.max(ha.oldStart, hb.oldStart) < Math.min(ha.oldEnd, hb.oldEnd);
      const adjacent = ha.oldEnd === hb.oldStart || hb.oldEnd === ha.oldStart;
      const bothInsertionsAtSamePoint =
        ha.oldStart === ha.oldEnd && hb.oldStart === hb.oldEnd && ha.oldStart === hb.oldStart;
      const shareLine = ha.newLines.some((line) => hb.newLines.includes(line));
      // Two different changes to an overlapping region conflict; so do two
      // insertions at the same point, and adjacent changes whose new lines
      // share a line (the shared line's placement is ambiguous — git
      // conflicts on those, e.g. both sides adding the same line next to a
      // change). Adjacent changes with disjoint new lines combine cleanly.
      if (overlap || bothInsertionsAtSamePoint || (adjacent && shareLine)) return null;
    }
    if (hb === undefined || (ha !== undefined && ha.oldEnd <= hb.oldStart)) {
      emitBase(ha.oldStart);
      out.push(...ha.newLines);
      pos = ha.oldEnd;
      a += 1;
      continue;
    }
    if (ha === undefined || hb.oldEnd <= ha.oldStart) {
      emitBase(hb.oldStart);
      out.push(...hb.newLines);
      pos = hb.oldEnd;
      b += 1;
      continue;
    }
    // The hunks overlap in the ancestor and differ: a real conflict.
    return null;
  }
  emitBase(base.length);
  return out.join('');
}

/**
 * Line additions/deletions between two texts, via LCS (bounded: very large
 * files fall back to a multiset difference). Returns {additions, deletions}.
 */
export function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  const product = oldLines.length * newLines.length;
  if (product > 4_000_000) {
    const count = (lines: string[]): Map<string, number> => {
      const map = new Map<string, number>();
      for (const line of lines) map.set(line, (map.get(line) ?? 0) + 1);
      return map;
    };
    const oldCounts = count(oldLines);
    const newCounts = count(newLines);
    let additions = 0;
    let deletions = 0;
    for (const [line, n] of newCounts) additions += Math.max(0, n - (oldCounts.get(line) ?? 0));
    for (const [line, n] of oldCounts) deletions += Math.max(0, n - (newCounts.get(line) ?? 0));
    return { additions, deletions };
  }
  let prev = new Array<number>(newLines.length + 1).fill(0);
  let curr = new Array<number>(newLines.length + 1).fill(0);
  for (let i = 1; i <= oldLines.length; i += 1) {
    for (let j = 1; j <= newLines.length; j += 1) {
      curr[j] = oldLines[i - 1] === newLines[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], curr[j - 1]);
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
    curr.fill(0);
  }
  const common = prev[newLines.length] as number;
  return { additions: newLines.length - common, deletions: oldLines.length - common };
}

export interface FileChange {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
  oldOid: string | null;
  newOid: string | null;
}

/**
 * The file-level diff between two trees: every path that differs, with
 * line counts. `getBlob` reads blob bytes for the counts.
 */
export function diffTrees(
  repo: Repo,
  baseTreeOid: string,
  headTreeOid: string,
): FileChange[] {
  const base = baseTreeOid === ZERO_OID ? new Map<string, FlatEntry>() : flattenTree(repo, baseTreeOid);
  const head = headTreeOid === ZERO_OID ? new Map<string, FlatEntry>() : flattenTree(repo, headTreeOid);
  const paths = new Set<string>([...base.keys(), ...head.keys()]);
  const changes: FileChange[] = [];
  for (const path of [...paths].sort(compareBytes)) {
    const b = base.get(path);
    const h = head.get(path);
    if (b !== undefined && h !== undefined && b.oid === h.oid) continue;
    if (b === undefined && h !== undefined) {
      const blob = repo.objects.get(h.oid);
      const lines = blob === undefined ? 0 : splitLines(blob.data.toString('utf8')).length;
      changes.push({ filename: path, status: 'added', additions: lines, deletions: 0, changes: lines, oldOid: null, newOid: h.oid });
    } else if (b !== undefined && h === undefined) {
      const blob = repo.objects.get(b.oid);
      const lines = blob === undefined ? 0 : splitLines(blob.data.toString('utf8')).length;
      changes.push({ filename: path, status: 'removed', additions: 0, deletions: lines, changes: lines, oldOid: b.oid, newOid: null });
    } else if (b !== undefined && h !== undefined) {
      const oldBlob = repo.objects.get(b.oid);
      const newBlob = repo.objects.get(h.oid);
      const counts = lineDiff(
        oldBlob === undefined ? '' : oldBlob.data.toString('utf8'),
        newBlob === undefined ? '' : newBlob.data.toString('utf8'),
      );
      changes.push({
        filename: path,
        status: 'modified',
        additions: counts.additions,
        deletions: counts.deletions,
        changes: counts.additions + counts.deletions,
        oldOid: b.oid,
        newOid: h.oid,
      });
    }
  }
  return changes;
}

// ---------------------------------------------------------------- merge base and three-way merge

/** Ancestors of `tip` with their generation (distance in parent steps). */
function ancestorsWithDepth(repo: Repo, tip: string): Map<string, number> {
  const depths = new Map<string, number>();
  const queue: Array<{ oid: string; depth: number }> = [{ oid: tip, depth: 0 }];
  while (queue.length > 0) {
    const { oid, depth } = queue.pop() as { oid: string; depth: number };
    if (depths.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    depths.set(oid, depth);
    for (const parent of parseCommit(object.data).parents) {
      if (!depths.has(parent)) queue.push({ oid: parent, depth: depth + 1 });
    }
  }
  return depths;
}

/** The best common ancestor of two commits (lowest sum of generations). */
export function mergeBase(repo: Repo, a: string, b: string): string | null {
  if (a === ZERO_OID || b === ZERO_OID) return null;
  const aDepths = ancestorsWithDepth(repo, a);
  if (aDepths.has(b)) return b;
  const bQueue: Array<{ oid: string; depth: number }> = [{ oid: b, depth: 0 }];
  const bSeen = new Set<string>();
  let best: string | null = null;
  let bestTotal = Number.POSITIVE_INFINITY;
  while (bQueue.length > 0) {
    const { oid, depth } = bQueue.pop() as { oid: string; depth: number };
    if (bSeen.has(oid)) continue;
    bSeen.add(oid);
    const aDepth = aDepths.get(oid);
    if (aDepth !== undefined) {
      const total = aDepth + depth;
      if (total < bestTotal) {
        bestTotal = total;
        best = oid;
      }
    }
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (!bSeen.has(parent)) bQueue.push({ oid: parent, depth: depth + 1 });
    }
  }
  return best;
}

/** Whether `descendant` descends from `ancestor` (or equals it). */
export function isDescendant(repo: Repo, descendant: string, ancestor: string): boolean {
  if (descendant === ancestor) return true;
  if (ancestor === ZERO_OID) return true;
  return ancestorsWithDepth(repo, descendant).has(ancestor);
}

export interface MergeOutcome {
  conflict: boolean;
  conflictPaths: string[];
  treeOid: string | null;
}

/**
 * Whether blob bytes look like text: no NUL byte (git's binary heuristic)
 * and a clean UTF-8 round-trip.
 */
function isTextBlob(data: Buffer): boolean {
  if (data.includes(0)) return false;
  return Buffer.from(data.toString('utf8'), 'utf8').equals(data);
}

/**
 * A line-level merge of one file both sides changed: the merged text, or
 * null when the change is not mergeable line by line (a side deleted the
 * file, the modes differ, the content is binary, or the changed lines
 * overlap differently).
 */
function tryLineMerge(
  repo: Repo,
  ancestor: FlatEntry | undefined,
  ours: FlatEntry | undefined,
  theirs: FlatEntry | undefined,
): string | null {
  if (ancestor === undefined || ours === undefined || theirs === undefined) return null;
  if (ours.mode !== theirs.mode) return null;
  const aBlob = repo.objects.get(ancestor.oid);
  const oBlob = repo.objects.get(ours.oid);
  const tBlob = repo.objects.get(theirs.oid);
  if (aBlob === undefined || oBlob === undefined || tBlob === undefined) return null;
  if (!isTextBlob(aBlob.data) || !isTextBlob(oBlob.data) || !isTextBlob(tBlob.data)) return null;
  return mergeLines(aBlob.data.toString('utf8'), oBlob.data.toString('utf8'), tBlob.data.toString('utf8'));
}

/**
 * The merged flat file map and the conflicting paths of a three-way merge,
 * without writing any objects: a path both sides changed differently is a
 * conflict unless the changes combine line by line. `blobs` holds the
 * contents of blobs the merge creates (keyed by their oid); the caller
 * stores them before building the tree.
 */
export function computeMergedFlat(
  repo: Repo,
  baseTip: string,
  headTip: string,
  mergeBaseOid: string | null,
): { merged: Map<string, FlatEntry>; conflicts: string[]; blobs: Map<string, Buffer> } {
  const baseTreeOid = baseTip === ZERO_OID ? ZERO_OID : parseCommit(repo.objects.get(baseTip)?.data ?? Buffer.alloc(0)).tree;
  const headTreeOid = headTip === ZERO_OID ? ZERO_OID : parseCommit(repo.objects.get(headTip)?.data ?? Buffer.alloc(0)).tree;
  const ancestorTreeOid =
    mergeBaseOid === null || mergeBaseOid === ZERO_OID
      ? ZERO_OID
      : parseCommit(repo.objects.get(mergeBaseOid)?.data ?? Buffer.alloc(0)).tree;
  const base = flattenTree(repo, baseTreeOid);
  const head = flattenTree(repo, headTreeOid);
  const ancestor = ancestorTreeOid === ZERO_OID ? new Map<string, FlatEntry>() : flattenTree(repo, ancestorTreeOid);
  const merged = new Map<string, FlatEntry>();
  const blobs = new Map<string, Buffer>();
  const conflicts: string[] = [];
  const paths = new Set<string>([...base.keys(), ...head.keys(), ...ancestor.keys()]);
  for (const path of paths) {
    const a = ancestor.get(path);
    const o = base.get(path);
    const t = head.get(path);
    const oOid = o?.oid ?? null;
    const tOid = t?.oid ?? null;
    const aOid = a?.oid ?? null;
    if (oOid === tOid) {
      if (o !== undefined) merged.set(path, o);
      continue;
    }
    if (oOid === aOid) {
      if (t !== undefined) merged.set(path, t);
      continue;
    }
    if (tOid === aOid) {
      if (o !== undefined) merged.set(path, o);
      continue;
    }
    const mergedText = tryLineMerge(repo, a, o, t);
    if (mergedText !== null) {
      const content = Buffer.from(mergedText, 'utf8');
      const oid = hashObject('blob', content);
      blobs.set(oid, content);
      merged.set(path, { oid, mode: o?.mode ?? t?.mode ?? '100644' });
      continue;
    }
    conflicts.push(path);
  }
  // A merged path that is a prefix of another merged path is a file/directory
  // collision: also a conflict.
  const mergedPaths = [...merged.keys()].sort(compareBytes);
  for (let i = 0; i < mergedPaths.length; i += 1) {
    for (let j = i + 1; j < mergedPaths.length; j += 1) {
      if ((mergedPaths[j] as string).startsWith(`${mergedPaths[i] as string}/`)) {
        conflicts.push(mergedPaths[i] as string);
      }
    }
  }
  return { merged, conflicts: [...new Set(conflicts)].sort(compareBytes), blobs };
}

/** The conflicting paths of a three-way merge, without writing any objects. */
export function findMergeConflicts(
  repo: Repo,
  baseTip: string,
  headTip: string,
  mergeBaseOid: string | null,
): string[] {
  return computeMergedFlat(repo, baseTip, headTip, mergeBaseOid).conflicts;
}

/**
 * A three-way merge of `headTip` into `baseTip` with `mergeBaseOid` as the
 * base. Takes a side's version when only it changed; a path both sides
 * changed differently (or a file/directory collision) is a conflict.
 */
export function threeWayMerge(
  store: Store,
  repo: Repo,
  baseTip: string,
  headTip: string,
  mergeBaseOid: string | null,
): MergeOutcome {
  const { merged, conflicts, blobs } = computeMergedFlat(repo, baseTip, headTip, mergeBaseOid);
  if (conflicts.length > 0) {
    return { conflict: true, conflictPaths: conflicts, treeOid: null };
  }
  for (const [oid, content] of blobs) {
    if (!repo.objects.has(oid)) store.putObject(repo, 'blob', content);
  }
  const treeOid = buildTreeFromFlat(store, repo, merged);
  return { conflict: false, conflictPaths: [], treeOid };
}
