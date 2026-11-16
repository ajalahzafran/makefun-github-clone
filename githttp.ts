// Git smart HTTP: info/refs advertisements (protocol v2 and v0),
// upload-pack (v2 fetch, v0 fetch, v2 ls-refs) and receive-pack (v0).
// Framing is pkt-lines throughout; packs are version 2, undeltified, with a
// SHA-1 trailer; sideband band 1 carries pack bytes and push reports.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  pktLine,
  pktLines,
  decodePktLines,
  readPack,
  writePack,
  collectReachable,
  collectDepth,
  peelToCommit,
  parseCommit,
  parseTag,
  parseTree,
  isDescendant,
  type Pkt,
} from './gitcore.ts';
import { isOid, ZERO_OID, compareBytes } from './util.ts';
import { ownerLogin, type Repo, type Store } from './store.ts';
import { sendBytes, sendError, sendJson } from './respond.ts';

const AGENT = 'forge/1.0';
const UPLOAD_AD = 'application/x-git-upload-pack-advertisement';
const RECEIVE_AD = 'application/x-git-receive-pack-advertisement';
const UPLOAD_RESULT = 'application/x-git-upload-pack-result';
const RECEIVE_RESULT = 'application/x-git-receive-pack-result';

/** A ref as the server advertises it: name, tip oid, peeled commit for tags. */
interface AdvertisedRef {
  name: string;
  oid: string;
  peeled?: string;
}

/** All refs of a repo, sorted by name, with peeled tag targets. */
function advertisedRefs(repo: Repo): AdvertisedRef[] {
  const refs: AdvertisedRef[] = [];
  for (const name of [...repo.refs.keys()].sort(compareBytes)) {
    const oid = repo.refs.get(name) as string;
    const ref: AdvertisedRef = { name, oid };
    if (name.startsWith('refs/tags/')) {
      const object = repo.objects.get(oid);
      if (object !== undefined && object.type === 'tag') {
        const peeled = peelToCommit(repo, oid);
        if (peeled !== undefined) ref.peeled = peeled;
      }
    }
    refs.push(ref);
  }
  return refs;
}

/** The v2 capability lines (ls-refs is bare: no `unborn`, so an empty repo lists no refs). */
function v2Capabilities(): string[] {
  return ['version 2', 'ls-refs', 'fetch=shallow filter', 'object-format=sha1', `agent=${AGENT}`];
}

/** The v0 upload-pack capability list (after NUL on the first line). */
function v0UploadCapabilities(defaultBranch: string): string[] {
  return [
    'multi_ack_detailed',
    'side-band-64k',
    'thin-pack',
    'no-progress',
    'ofs-delta',
    'shallow',
    `symref=HEAD:refs/heads/${defaultBranch}`,
    `agent=${AGENT}`,
  ];
}

/** The v0 receive-pack capability list (after NUL on the first line). */
function v0ReceiveCapabilities(defaultBranch: string): string[] {
  return [
    'report-status',
    'side-band-64k',
    'delete-refs',
    'ofs-delta',
    `symref=HEAD:refs/heads/${defaultBranch}`,
    `agent=${AGENT}`,
  ];
}

/** Look a repository up by owner/name; null unless it is the viewer's repo. */
function findRepo(store: Store, owner: string, name: string): Repo | null {
  if (owner !== ownerLogin()) return null;
  return store.getRepo(owner, name) ?? null;
}

/** Parse a pkt-line stream's data lines as text (without the trailing LF). */
function textLines(packets: readonly Pkt[]): string[] {
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    lines.push(packet.payload.toString('utf8').replace(/\n$/, ''));
  }
  return lines;
}

// ---------------------------------------------------------------- info/refs

export function handleInfoRefs(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  owner: string,
  repoName: string,
  service: string | undefined,
): void {
  const repo = findRepo(store, owner, repoName);
  if (repo === null) {
    sendError(store, res, 404, 'Not Found');
    return;
  }
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    sendError(store, res, 400, 'a service query parameter is required');
    return;
  }
  const wantsV2 = service === 'git-upload-pack' && (req.headers['git-protocol'] ?? '') === 'version=2';
  if (wantsV2) {
    const body = pktLines([...v2Capabilities(), 'flush']);
    sendBytes(store, res, 200, body, UPLOAD_AD);
    return;
  }
  const refs = advertisedRefs(repo);
  const caps = service === 'git-upload-pack' ? v0UploadCapabilities(repo.defaultBranch) : v0ReceiveCapabilities(repo.defaultBranch);
  const contentType = service === 'git-upload-pack' ? UPLOAD_AD : RECEIVE_AD;
  const lines: string[] = [];
  if (refs.length === 0) {
    // An empty repository advertises the capabilities pseudo-ref only.
    lines.push(`${ZERO_OID} capabilities^{}\0${caps.join(' ')}\n`);
  } else {
    // The first line names HEAD and carries the capabilities after NUL.
    lines.push(`${store.headOid(repo)} HEAD\0${caps.join(' ')}\n`);
    for (const ref of refs) {
      lines.push(`${ref.oid} ${ref.name}\n`);
      if (ref.peeled !== undefined) lines.push(`${ref.peeled} ${ref.name}^{}\n`);
    }
  }
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), Buffer.from('0000', 'ascii')];
  for (const line of lines) parts.push(pktLine(line));
  parts.push(Buffer.from('0000', 'ascii'));
  sendBytes(store, res, 200, Buffer.concat(parts), contentType);
}

// ---------------------------------------------------------------- ls-refs (v2)

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function handleLsRefs(store: Store, repo: Repo, args: LsRefsArgs): Buffer {
  const lines: string[] = [];
  const refs = advertisedRefs(repo);
  // With a ref-prefix filter the HEAD line is only emitted when a prefix
  // matches it (a prefix of "HEAD"); a refs/heads/ or refs/tags/ prefix
  // must not leak HEAD into the answer.
  const headAllowed = args.prefixes.length === 0 || args.prefixes.some((prefix) => 'HEAD'.startsWith(prefix));
  if (args.symrefs && headAllowed) {
    const tip = store.defaultTip(repo);
    if (tip !== undefined) lines.push(`${tip} HEAD symref-target:refs/heads/${repo.defaultBranch}\n`);
  }
  for (const ref of refs) {
    if (args.prefixes.length > 0 && !args.prefixes.some((prefix) => ref.name.startsWith(prefix))) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (args.peel && ref.peeled !== undefined) line += ` peeled:${ref.peeled}`;
    lines.push(`${line}\n`);
  }
  return pktLines([...lines, 'flush']);
}

// ---------------------------------------------------------------- fetch

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  deepenSince: number | null;
  deepenNot: string[];
  thinPack: boolean;
  /** Whether the client sent `done`: the negotiation is over and the pack follows. */
  done: boolean;
}

function parseFetchLines(lines: string[]): FetchArgs {
  const args: FetchArgs = {
    wants: [],
    haves: [],
    shallow: [],
    depth: null,
    deepenSince: null,
    deepenNot: [],
    thinPack: false,
    done: false,
  };
  for (const line of lines) {
    // A v0 want line carries capabilities after the oid
    // ("want <oid> side-band-64k ..."): only the first token is the oid.
    if (line.startsWith('want ')) args.wants.push(line.slice(5).trim().split(/\s+/)[0] as string);
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim().split(/\s+/)[0] as string);
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim().split(/\s+/)[0] as string);
    else if (line === 'done') args.done = true;
    else if (line.startsWith('deepen ')) {
      const n = Number(line.slice(7).trim());
      if (Number.isFinite(n) && n > 0) args.depth = Math.trunc(n);
    } else if (line.startsWith('deepen-since ')) {
      const n = Number(line.slice(13).trim());
      if (Number.isFinite(n)) args.deepenSince = n;
    } else if (line.startsWith('deepen-not ')) args.deepenNot.push(line.slice(11).trim());
    else if (line === 'thin-pack') args.thinPack = true;
  }
  return args;
}

/**
 * The objects a fetch sends: the want closure (cut at `depth` when given)
 * minus the have closure (whose shallow boundaries are not traversed).
 * Returns the pack bytes (null when nothing is new), the new shallow
 * boundary, and the old shallow commits that are now included.
 */
function computeFetch(
  store: Store,
  repo: Repo,
  args: FetchArgs,
): { pack: Buffer | null; shallow: string[]; unshallow: string[]; wantedRefs: Array<{ oid: string; ref: string }> } {
  const wants = [...new Set(args.wants)].filter((oid) => isOid(oid) && store.hasObject(repo, oid));
  if (wants.length === 0) return { pack: null, shallow: [], unshallow: [], wantedRefs: [] };
  const shallowSet = new Set(args.shallow.filter((oid) => isOid(oid)));
  const wantSide = collectDepth(repo, wants, args.depth, undefined);
  const haveSide = collectDepth(repo, args.haves, null, shallowSet);
  const toSend = new Set<string>();
  for (const oid of wantSide.objects) {
    if (!haveSide.objects.has(oid)) toSend.add(oid);
  }
  let pack: Buffer | null = null;
  if (toSend.size > 0) {
    const cacheKey = [
      repo.id,
      repo.version,
      wants.slice().sort().join(','),
      args.depth ?? '',
      [...args.haves].sort().join(','),
      [...args.shallow].sort().join(','),
    ].join('|');
    const cached = store.packCache.get(cacheKey);
    if (cached !== undefined) {
      pack = cached;
    } else {
      const objects = [...toSend].sort().map((oid) => {
        const object = repo.objects.get(oid) as { type: 'commit' | 'tree' | 'blob' | 'tag'; data: Buffer };
        return { type: object.type, data: object.data };
      });
      pack = writePack(objects);
      store.packCache.set(cacheKey, pack);
    }
  }
  const shallow: string[] = [];
  const unshallow: string[] = [];
  if (args.depth !== null) {
    for (const oid of [...wantSide.boundary].sort()) shallow.push(oid);
    for (const oid of [...shallowSet].sort()) {
      if (wantSide.objects.has(oid) && !wantSide.boundary.has(oid)) unshallow.push(oid);
    }
  }
  const wantedRefs: Array<{ oid: string; ref: string }> = [];
  for (const ref of advertisedRefs(repo)) {
    if (wants.includes(ref.oid)) wantedRefs.push({ oid: ref.oid, ref: ref.name });
  }
  return { pack, shallow, unshallow, wantedRefs };
}

/** Split pack bytes into sideband band-1 pkt-lines (each ≤ 65520 bytes). */
function sidebandPackets(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const CHUNK = 65500;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    out.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return out;
}

/**
 * The v2 fetch response, shaped by whether the client is done negotiating.
 * Git's client reads the response through a state machine: a request that
 * carries `done` goes straight to the pack, so the response must start with
 * the `shallow-info` section — an `acknowledgments` section there makes git
 * die with "expected 'packfile'". A request without `done` is a negotiation
 * round and answers with the `acknowledgments` section only (never `ready`,
 * so the client sends another request and the pack follows then). The
 * `shallow-info` and `wanted-refs` sections are always present in the done
 * response, even when empty; the `packfile` section is omitted entirely when
 * the client already holds everything.
 */
function handleFetchV2(store: Store, repo: Repo, args: FetchArgs): Buffer {
  const commonHaves = args.haves.filter((oid) => isOid(oid) && store.hasObject(repo, oid));
  if (!args.done) {
    const ackLines = commonHaves.length > 0 ? commonHaves.map((oid) => `ACK ${oid}\n`) : ['NAK\n'];
    return pktLines(['acknowledgments\n', ...ackLines, 'flush']);
  }
  const { pack, shallow, unshallow, wantedRefs } = computeFetch(store, repo, args);
  const parts: Buffer[] = [];
  const shallowLines: string[] = [];
  for (const oid of shallow) shallowLines.push(`shallow ${oid}\n`);
  for (const oid of unshallow) shallowLines.push(`unshallow ${oid}\n`);
  parts.push(pktLines(['shallow-info\n', ...shallowLines, 'delim']));
  parts.push(pktLines(['wanted-refs\n', ...wantedRefs.map((entry) => `${entry.oid} ${entry.ref}\n`), 'delim']));
  if (pack !== null) {
    parts.push(pktLine('packfile\n'));
    for (const packet of sidebandPackets(pack)) parts.push(packet);
  }
  parts.push(Buffer.from('0000', 'ascii'));
  return Buffer.concat(parts);
}

function handleFetchV0(store: Store, repo: Repo, args: FetchArgs): Buffer {
  const { pack, shallow, unshallow } = computeFetch(store, repo, args);
  const parts: Buffer[] = [];
  // Common haves in the order the client sent them.
  const commonHaves = args.haves.filter((oid) => isOid(oid) && store.hasObject(repo, oid));
  if (!args.done) {
    // A negotiation round: one "ACK <oid> common" per common have. When
    // every have was common, "ACK <last> ready" + NAK tells the client to
    // send done; otherwise NAK asks for more haves.
    for (const oid of commonHaves) parts.push(pktLine(`ACK ${oid} common\n`));
    const validHaves = args.haves.filter((oid) => isOid(oid));
    if (commonHaves.length > 0 && commonHaves.length === validHaves.length) {
      parts.push(pktLine(`ACK ${commonHaves[commonHaves.length - 1] as string} ready\n`));
    }
    parts.push(pktLine('NAK\n'));
    parts.push(Buffer.from('0000', 'ascii'));
    return Buffer.concat(parts);
  }
  // The done response starts with exactly one acknowledgment line: the
  // client reads a single ACK/NAK here, and any extra ACK line would be
  // misread as the start of the pack.
  if (commonHaves.length > 0) {
    parts.push(pktLine(`ACK ${commonHaves[commonHaves.length - 1] as string}\n`));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  if (pack !== null) {
    for (const packet of sidebandPackets(pack)) parts.push(packet);
  }
  parts.push(Buffer.from('0000', 'ascii'));
  return Buffer.concat(parts);
}

export function handleUploadPack(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  owner: string,
  repoName: string,
  body: Buffer,
): void {
  const repo = findRepo(store, owner, repoName);
  if (repo === null) {
    sendError(store, res, 404, 'Not Found');
    return;
  }
  const isV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
  const { packets } = decodePktLines(body);
  const lines = textLines(packets);
  if (lines.length === 0) {
    sendError(store, res, 400, 'empty git-upload-pack request');
    return;
  }
  const first = lines[0] as string;
  if (isV2 && first === 'command=ls-refs') {
    const args: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
    // The argument lines follow the command/agent/object-format lines; the
    // argument names never appear before the delimiter, so scanning all of
    // them is exact.
    for (const line of lines.slice(1)) {
      if (line.startsWith('command=') || line.startsWith('agent=') || line.startsWith('object-format=')) continue;
      if (line === 'peel') args.peel = true;
      else if (line === 'symrefs') args.symrefs = true;
      else if (line === 'unborn') args.unborn = true;
      else if (line.startsWith('ref-prefix ')) args.prefixes.push(line.slice(11));
    }
    sendBytes(store, res, 200, handleLsRefs(store, repo, args), UPLOAD_RESULT);
    return;
  }
  if (isV2 && first !== 'command=fetch') {
    sendError(store, res, 400, `unsupported v2 command ${JSON.stringify(first)}`);
    return;
  }
  if (!isV2) {
    // v0: want lines (the first carries capabilities), shallow/deepen,
    // flush, then have lines and done.
    const args = parseFetchLines(lines);
    sendBytes(store, res, 200, handleFetchV0(store, repo, args), UPLOAD_RESULT);
    return;
  }
  // v2 fetch: lines after the delim are the arguments.
  const delimIndex = packets.findIndex((packet) => packet.kind === 'delim');
  const argLines = delimIndex < 0 ? lines.slice(1) : textLines(packets.slice(delimIndex + 1));
  const args = parseFetchLines(argLines);
  sendBytes(store, res, 200, handleFetchV2(store, repo, args), UPLOAD_RESULT);
}

// ---------------------------------------------------------------- receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function handleReceivePack(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  owner: string,
  repoName: string,
  body: Buffer,
): void {
  const repo = findRepo(store, owner, repoName);
  if (repo === null) {
    sendError(store, res, 404, 'Not Found');
    return;
  }
  const { packets, rest } = decodePktLines(body);
  const commands: PushCommand[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    let text = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = text.indexOf('\0');
    if (nul >= 0) text = text.slice(0, nul);
    const parts = text.split(' ');
    if (parts.length < 3) continue;
    const [oldOid, newOid, ref] = parts as [string, string, string];
    if (isOid(oldOid) && isOid(newOid) && ref.startsWith('refs/')) {
      commands.push({ oldOid, newOid, ref });
    }
  }
  if (commands.length === 0) {
    sendError(store, res, 400, 'no push commands');
    return;
  }

  // Unpack: a pack follows the command list (an empty pack for updates, no
  // pack at all for delete-only). Objects are stored even when a ref update
  // is refused — the unpack itself must succeed.
  let unpackOk = true;
  let unpackDetail = 'ok';
  const updatesRef = commands.some((command) => command.newOid !== ZERO_OID);
  if (rest.length > 0) {
    try {
      const { objects } = readPack(rest, (oid) => repo.objects.get(oid));
      for (const [oid, object] of objects) {
        if (!repo.objects.has(oid)) {
          repo.objects.set(oid, object);
          repo.version += 1;
        }
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'unpack failed';
    }
  } else if (updatesRef) {
    unpackOk = false;
    unpackDetail = 'missing packfile';
  }

  const report: Array<{ ref: string; ok: boolean; reason: string }> = [];
  // The first branch pushed to an empty repository becomes its default
  // branch, as on a real forge (a client that clones an empty repo cannot
  // know the default branch from the advertisement, so it pushes its own).
  const wasUnborn = repo.refs.size === 0;
  let firstBranch: string | null = null;
  if (!unpackOk) {
    for (const command of commands) report.push({ ref: command.ref, ok: false, reason: unpackDetail });
  } else {
    for (const command of commands) {
      const current = repo.refs.get(command.ref);
      if (command.newOid === ZERO_OID) {
        if (current === undefined) {
          report.push({ ref: command.ref, ok: true, reason: '' });
        } else if (command.oldOid === ZERO_OID || command.oldOid === current) {
          repo.refs.delete(command.ref);
          repo.version += 1;
          report.push({ ref: command.ref, ok: true, reason: '' });
        } else {
          report.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        }
        continue;
      }
      if (!store.hasObject(repo, command.newOid)) {
        report.push({ ref: command.ref, ok: false, reason: 'object not found' });
        continue;
      }
      if (current === undefined) {
        if (command.oldOid !== ZERO_OID) {
          report.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
          continue;
        }
        repo.refs.set(command.ref, command.newOid);
        repo.version += 1;
        if (firstBranch === null && command.ref.startsWith('refs/heads/')) {
          firstBranch = command.ref.slice('refs/heads/'.length);
        }
        report.push({ ref: command.ref, ok: true, reason: '' });
        continue;
      }
      if (command.oldOid !== current) {
        report.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
      if (command.newOid === current) {
        report.push({ ref: command.ref, ok: true, reason: '' });
        continue;
      }
      if (!isDescendant(repo, command.newOid, current)) {
        report.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
      repo.refs.set(command.ref, command.newOid);
      repo.version += 1;
      report.push({ ref: command.ref, ok: true, reason: '' });
    }
  }
  if (wasUnborn && firstBranch !== null) repo.defaultBranch = firstBranch;

  const reportLines: string[] = [unpackOk ? 'unpack ok\n' : `unpack ${unpackDetail}\n`];
  for (const entry of report) {
    reportLines.push(entry.ok ? `ok ${entry.ref}\n` : `ng ${entry.ref} ${entry.reason}\n`);
  }
  const parts: Buffer[] = [];
  for (const line of reportLines) parts.push(pktLine(Buffer.concat([Buffer.from([1]), pktLine(line)])));
  parts.push(pktLine(Buffer.concat([Buffer.from([1]), Buffer.from('0000', 'ascii')])));
  parts.push(Buffer.from('0000', 'ascii'));
  sendBytes(store, res, 200, Buffer.concat(parts), RECEIVE_RESULT);
}

// ---------------------------------------------------------------- shared helpers for other surfaces

/** The commit history reachable from `ref` (tip first), newest first. */
export function listCommits(repo: Repo, ref: string | undefined): Array<{ sha: string; commit: ReturnType<typeof parseCommit> }> {
  let tip: string | undefined;
  if (ref === undefined || ref === '') tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  else if (ref.startsWith('refs/')) tip = repo.refs.get(ref);
  else {
    tip = repo.refs.get(`refs/heads/${ref}`);
    if (tip === undefined && repo.objects.get(ref)?.type === 'commit') tip = ref;
  }
  if (tip === undefined) return [];
  const peeled = peelToCommit(repo, tip);
  if (peeled === undefined) return [];
  const seen = new Set<string>();
  const out: Array<{ sha: string; commit: ReturnType<typeof parseCommit> }> = [];
  const queue: string[] = [peeled];
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    const commit = parseCommit(object.data);
    out.push({ sha: oid, commit });
    for (const parent of commit.parents) queue.push(parent);
  }
  return out;
}

/** The tree oid of a commit, or null. */
export function commitTree(repo: Repo, oid: string): string | null {
  const object = repo.objects.get(oid);
  if (object === undefined || object.type !== 'commit') return null;
  return parseCommit(object.data).tree;
}

/** Whether a ref name is a branch ref. */
export function isBranchRef(ref: string): boolean {
  return ref.startsWith('refs/heads/');
}

/** The tag target's commit oid, for a tag object (or the oid itself). */
export function tagTargetCommit(repo: Repo, oid: string): string | undefined {
  return peelToCommit(repo, oid);
}

export { parseTree };
