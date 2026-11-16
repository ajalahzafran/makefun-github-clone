// The forge's store: one in-memory model shared by git smart HTTP, REST v3,
// GraphQL and MCP. A fresh process starts empty; a trial runs one process, so
// nothing needs to survive a restart. All ids are counters, all timestamps
// come from the logical clock — no wall clock, no randomness.

import { LogicalClock, ZERO_OID, isOid, sha1Hex, toBase64, fromBase64 } from './util.ts';
import { VIEWER } from './scenario.ts';

export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjectType;
  data: Buffer;
}

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface Issue {
  id: number;
  number: number;
  repoId: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  commentCount: number;
}

export interface IssueComment {
  id: number;
  issueNumber: number;
  repoId: number;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface PullRequest {
  id: number;
  number: number;
  repoId: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  /** The head/base tip at creation (fallback when the branch is gone). */
  headShaAtCreate: string;
  baseShaAtCreate: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  createdSeq: number;
  /** Object id → object. Objects are per-repo and stored verbatim. */
  objects: Map<string, GitObject>;
  /** Ref name → tip oid. */
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Issue[];
  comments: IssueComment[];
  pulls: PullRequest[];
  issueSeq: number;
  pullSeq: number;
  /** Bumped on any object or ref change; pack caches key on it. */
  version: number;
}

/** The login the shop token names. */
export function ownerLogin(): string {
  return VIEWER.login;
}

/** The token owner's numeric user id (the scenario viewer's). */
export function ownerId(): number {
  return VIEWER.id;
}

/** An opaque Relay-style global id: base64 of `Type:key` (never the bare id). */
export function globalId(type: string, key: string): string {
  return toBase64(`${type}:${key}`);
}

export function repoGlobalId(repoId: number): string {
  return globalId('Repository', String(repoId));
}

export function issueGlobalId(repoId: number, number: number): string {
  return globalId('Issue', `${repoId}:${number}`);
}

export function pullGlobalId(repoId: number, number: number): string {
  return globalId('PullRequest', `${repoId}:${number}`);
}

export function commentGlobalId(repoId: number, issueNumber: number, commentId: number): string {
  return globalId('IssueComment', `${repoId}:${issueNumber}:${commentId}`);
}

export function userGlobalId(login: string): string {
  return globalId('User', login);
}

/** Decode a global id made by globalId; null when it is not one. */
export function decodeGlobalId(id: string): { type: string; key: string } | null {
  const decoded = fromBase64(id);
  if (decoded === null) return null;
  const text = decoded.toString('utf8');
  const colon = text.indexOf(':');
  if (colon <= 0) return null;
  const type = text.slice(0, colon);
  const key = text.slice(colon + 1);
  if (type === '' || key === '') return null;
  return { type, key };
}

/** The object id of `<type> <size>\0<content>`. */
export function hashObject(type: ObjectType, data: Buffer | Uint8Array): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([header, Buffer.from(data)]));
}

export class Store {
  readonly clock = new LogicalClock();
  private readonly reposByKey = new Map<string, Repo>();
  private readonly reposById = new Map<number, Repo>();
  private repoSeq = 0;
  private issueIdSeq = 0;
  private commentIdSeq = 0;
  private pullIdSeq = 0;
  private seq = 0;
  private requestSeq = 0;
  /** Memoized pack bytes, keyed by repo + version + want set + depth. */
  readonly packCache = new Map<string, Buffer>();

  /** The next value of the store's creation-order counter. */
  nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  /** The next request id (`req-<n>`) for the X-GitHub-Request-Id header. */
  nextRequestId(): string {
    this.requestSeq += 1;
    return `req-${this.requestSeq}`;
  }

  // ---------------------------------------------------------- repositories

  private key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.reposByKey.get(this.key(owner, name));
  }

  getRepoById(id: number): Repo | undefined {
    return this.reposById.get(id);
  }

  /** Every repository owned by `owner`, in creation order. */
  listRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.reposByKey.values()) {
      if (repo.owner === owner) out.push(repo);
    }
    out.sort((a, b) => a.createdSeq - b.createdSeq);
    return out;
  }

  /** Create a repository; returns null when the name already exists. */
  createRepo(name: string, isPrivate: boolean, description: string): Repo | null {
    if (this.reposByKey.has(this.key(VIEWER.login, name))) return null;
    this.repoSeq += 1;
    const repo: Repo = {
      id: this.repoSeq,
      owner: VIEWER.login,
      name,
      description,
      isPrivate,
      defaultBranch: 'main',
      createdSeq: this.nextSeq(),
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: [],
      comments: [],
      pulls: [],
      issueSeq: 0,
      pullSeq: 0,
      version: 0,
    };
    this.reposByKey.set(this.key(repo.owner, repo.name), repo);
    this.reposById.set(repo.id, repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    const repo = this.reposByKey.get(this.key(owner, name));
    if (repo === undefined) return false;
    this.reposByKey.delete(this.key(owner, name));
    this.reposById.delete(repo.id);
    return true;
  }

  // ---------------------------------------------------------- git objects

  putObject(repo: Repo, type: ObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) {
      repo.objects.set(oid, { type, data });
      repo.version += 1;
    }
    return oid;
  }

  getObject(repo: Repo, oid: string): GitObject | undefined {
    if (!isOid(oid)) return undefined;
    return repo.objects.get(oid);
  }

  hasObject(repo: Repo, oid: string): boolean {
    return repo.objects.has(oid);
  }

  // ---------------------------------------------------------- refs

  getRef(repo: Repo, ref: string): string | undefined {
    return repo.refs.get(ref);
  }

  setRef(repo: Repo, ref: string, oid: string): void {
    repo.refs.set(ref, oid);
    repo.version += 1;
  }

  deleteRef(repo: Repo, ref: string): boolean {
    const deleted = repo.refs.delete(ref);
    if (deleted) repo.version += 1;
    return deleted;
  }

  /** The tip of `refs/heads/<branch>`, or undefined when the branch is absent. */
  branchTip(repo: Repo, branch: string): string | undefined {
    return repo.refs.get(`refs/heads/${branch}`);
  }

  /** The default branch's tip, or undefined for an unborn repository. */
  defaultTip(repo: Repo): string | undefined {
    return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  }

  /** The oid HEAD resolves to, or the zero oid for an unborn repository. */
  headOid(repo: Repo): string {
    return this.defaultTip(repo) ?? ZERO_OID;
  }

  // ---------------------------------------------------------- labels

  createLabel(repo: Repo, name: string, color: string, description = ''): Label {
    const label: Label = { name, color, description };
    repo.labels.set(name, label);
    return label;
  }

  getLabel(repo: Repo, name: string): Label | undefined {
    return repo.labels.get(name);
  }

  listLabels(repo: Repo): Label[] {
    return [...repo.labels.values()];
  }

  // ---------------------------------------------------------- issues

  createIssue(repo: Repo, title: string, body: string, labels: string[]): Issue {
    this.issueIdSeq += 1;
    repo.issueSeq += 1;
    const now = this.clock.tickIso();
    const issue: Issue = {
      id: this.issueIdSeq,
      number: repo.issueSeq,
      repoId: repo.id,
      title,
      body,
      state: 'open',
      labels: [...labels],
      createdSeq: this.nextSeq(),
      createdAt: now,
      updatedAt: now,
      closedAt: null,
      commentCount: 0,
    };
    repo.issues.push(issue);
    return issue;
  }

  getIssue(repo: Repo, number: number): Issue | undefined {
    return repo.issues.find((issue) => issue.number === number);
  }

  /** Issues filtered by state and ordered by creation (asc or desc). */
  listIssues(repo: Repo, state: string, direction: 'asc' | 'desc'): Issue[] {
    const wanted = state === 'all' ? null : state;
    const list = repo.issues.filter((issue) => wanted === null || issue.state === wanted);
    list.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
    return list;
  }

  closeIssue(repo: Repo, issue: Issue): Issue {
    if (issue.state !== 'closed') {
      issue.state = 'closed';
      issue.closedAt = this.clock.tickIso();
      issue.updatedAt = issue.closedAt;
    }
    return issue;
  }

  reopenIssue(repo: Repo, issue: Issue): Issue {
    if (issue.state !== 'open') {
      issue.state = 'open';
      issue.closedAt = null;
      issue.updatedAt = this.clock.tickIso();
    }
    return issue;
  }

  addComment(repo: Repo, issue: Issue, body: string): IssueComment {
    this.commentIdSeq += 1;
    const now = this.clock.tickIso();
    const comment: IssueComment = {
      id: this.commentIdSeq,
      issueNumber: issue.number,
      repoId: repo.id,
      body,
      createdAt: now,
      updatedAt: now,
    };
    repo.comments.push(comment);
    issue.commentCount += 1;
    issue.updatedAt = now;
    return comment;
  }

  listComments(repo: Repo, issueNumber: number): IssueComment[] {
    return repo.comments.filter((comment) => comment.issueNumber === issueNumber);
  }

  // ---------------------------------------------------------- pull requests

  createPull(repo: Repo, title: string, body: string, headRef: string, baseRef: string): PullRequest {
    this.pullIdSeq += 1;
    repo.pullSeq += 1;
    const now = this.clock.tickIso();
    const pull: PullRequest = {
      id: this.pullIdSeq,
      number: repo.pullSeq,
      repoId: repo.id,
      title,
      body,
      state: 'open',
      headRef,
      baseRef,
      headShaAtCreate: this.branchTip(repo, headRef) ?? ZERO_OID,
      baseShaAtCreate: this.branchTip(repo, baseRef) ?? ZERO_OID,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      createdSeq: this.nextSeq(),
      createdAt: now,
      updatedAt: now,
      closedAt: null,
    };
    repo.pulls.push(pull);
    return pull;
  }

  getPull(repo: Repo, number: number): PullRequest | undefined {
    return repo.pulls.find((pull) => pull.number === number);
  }

  /** Pull requests filtered by state ('open', 'closed', 'all'), newest first. */
  listPulls(repo: Repo, state: string): PullRequest[] {
    const list = state === 'all' ? [...repo.pulls] : repo.pulls.filter((pull) => pull.state === state);
    list.sort((a, b) => b.createdSeq - a.createdSeq);
    return list;
  }

  /** The current head tip of a pull request (the branch tip, or the creation tip). */
  pullHeadSha(repo: Repo, pull: PullRequest): string {
    return this.branchTip(repo, pull.headRef) ?? pull.headShaAtCreate;
  }

  /** The current base tip of a pull request (the branch tip, or the creation tip). */
  pullBaseSha(repo: Repo, pull: PullRequest): string {
    return this.branchTip(repo, pull.baseRef) ?? pull.baseShaAtCreate;
  }
}
