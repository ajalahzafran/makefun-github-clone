// REST v3 (`/api/v3`): repositories, refs, branches, commits, contents,
// labels, issues, comments and pull requests, over the shared store.
// Every reply is `application/json` with a non-empty `X-GitHub-Request-Id`;
// errors are JSON `{message}`; unknown routes are JSON 404s.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  buildCommit,
  buildTreeFromFlat,
  diffTrees,
  findMergeConflicts,
  flattenTree,
  mergeBase,
  parseTree,
  threeWayMerge,
  type FlatEntry,
} from './gitcore.ts';
import { listCommits as gitListCommits, commitTree } from './githttp.ts';
import {
  ownerLogin,
  repoGlobalId,
  issueGlobalId,
  pullGlobalId,
  commentGlobalId,
  userGlobalId,
  type Issue,
  type IssueComment,
  type PullRequest,
  type Repo,
  type Store,
} from './store.ts';
import { VIEWER } from './scenario.ts';
import { LogicalClock, ZERO_OID, isOid, fromBase64, toBase64, isRecord, queryInt } from './util.ts';
import { sendJson, sendError, readBody } from './respond.ts';

/** `http://<host>` for this request, for absolute `url` fields. */
function originOf(req: IncomingMessage): string {
  const host = req.headers.host ?? '127.0.0.1';
  return `http://${host}`;
}

/** A deterministic creation timestamp for a repo (base epoch + its sequence). */
function repoTime(repo: Repo): string {
  return LogicalClock.iso(1_735_689_600 + repo.createdSeq);
}

// ---------------------------------------------------------------- shapes

function userJson(req: IncomingMessage): Record<string, unknown> {
  const origin = originOf(req);
  return {
    login: VIEWER.login,
    id: VIEWER.id,
    node_id: userGlobalId(VIEWER.login),
    avatar_url: '',
    gravatar_id: '',
    url: `${origin}/api/v3/users/${VIEWER.login}`,
    html_url: `https://github.com/${VIEWER.login}`,
    type: 'User',
    site_admin: false,
    name: VIEWER.name,
    email: VIEWER.email,
  };
}

function repoJson(req: IncomingMessage, repo: Repo): Record<string, unknown> {
  const origin = originOf(req);
  const stamp = repoTime(repo);
  return {
    id: repo.id,
    node_id: repoGlobalId(repo.id),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(req),
    private: repo.isPrivate,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: stamp,
    updated_at: stamp,
    pushed_at: stamp,
    git_url: `git://github.com/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@github.com:${repo.owner}/${repo.name}.git`,
    clone_url: `https://github.com/${repo.owner}/${repo.name}.git`,
    homepage: '',
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: false,
    has_downloads: true,
    has_wiki: false,
    has_pages: false,
    forks_count: 0,
    open_issues_count: repo.issues.filter((issue) => issue.state === 'open').length,
    license: null,
    topics: [],
    default_branch: repo.defaultBranch,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

function labelJson(label: { name: string; color: string; description: string }): Record<string, unknown> {
  return { name: label.name, color: label.color, description: label.description };
}

function issueJson(req: IncomingMessage, repo: Repo, issue: Issue): Record<string, unknown> {
  const origin = originOf(req);
  return {
    id: issue.id,
    node_id: issueGlobalId(repo.id, issue.number),
    url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels
      .map((name) => repo.labels.get(name))
      .filter((label) => label !== undefined)
      .map((label) => labelJson(label as { name: string; color: string; description: string })),
    user: userJson(req),
    assignee: null,
    assignees: [],
    locked: false,
    comments: issue.commentCount,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    author_association: 'OWNER',
  };
}

function commentJson(req: IncomingMessage, repo: Repo, comment: IssueComment): Record<string, unknown> {
  const origin = originOf(req);
  return {
    id: comment.id,
    node_id: commentGlobalId(repo.id, comment.issueNumber, comment.id),
    url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/issues/comments/${comment.id}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${comment.issueNumber}#issuecomment-${comment.id}`,
    body: comment.body,
    user: userJson(req),
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    author_association: 'OWNER',
  };
}

function pullJson(req: IncomingMessage, store: Store, repo: Repo, pull: PullRequest): Record<string, unknown> {
  const origin = originOf(req);
  const headSha = store.pullHeadSha(repo, pull);
  const baseSha = store.pullBaseSha(repo, pull);
  const mergeable = pull.state === 'open' ? isMergeable(store, repo, pull) : false;
  const refJson = (ref: string, sha: string): Record<string, unknown> => ({
    label: `${repo.owner}:${ref}`,
    ref,
    sha,
    user: userJson(req),
    repo: repoJson(req, repo),
  });
  return {
    id: pull.id,
    node_id: pullGlobalId(repo.id, pull.number),
    url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    locked: false,
    draft: false,
    merged: pull.merged,
    mergeable,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: refJson(pull.headRef, headSha),
    base: refJson(pull.baseRef, baseSha),
    user: userJson(req),
    assignee: null,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.closedAt,
    author_association: 'OWNER',
  };
}

/** Whether a pull request merges cleanly (no three-way conflict). */
export function isMergeable(store: Store, repo: Repo, pull: PullRequest): boolean {
  const headSha = store.pullHeadSha(repo, pull);
  const baseSha = store.pullBaseSha(repo, pull);
  if (headSha === ZERO_OID || baseSha === ZERO_OID) return false;
  const base = mergeBase(repo, headSha, baseSha);
  return findMergeConflicts(repo, baseSha, headSha, base).length === 0;
}

// ---------------------------------------------------------------- plumbing

interface RestContext {
  store: Store;
  req: IncomingMessage;
  res: ServerResponse;
  segments: string[];
  query: Map<string, string>;
  body: unknown;
}

/** The repository at /repos/{owner}/{name}, or a 404 when it is not the viewer's. */
function repoOr404(ctx: RestContext, owner: string, name: string): Repo | null {
  if (owner !== ownerLogin()) {
    sendError(ctx.store, ctx.res, 404, 'Not Found');
    return null;
  }
  const repo = ctx.store.getRepo(owner, name);
  if (repo === undefined) {
    sendError(ctx.store, ctx.res, 404, 'Not Found');
    return null;
  }
  return repo;
}

/** Parse a JSON request body; 400 on malformed JSON, null when there is none. */
async function readJsonBody(ctx: RestContext): Promise<unknown> {
  const raw = await readBody(ctx.req);
  if (raw.length === 0) return null;
  const parsed = JSON.parse(raw.toString('utf8')) as unknown;
  return parsed;
}

/** Paginate a list by ?per_page=&page=, with a Link header when more pages follow. */
function paginate<T>(
  ctx: RestContext,
  items: readonly T[],
  basePath: string,
): { page: T[]; link: string | null } {
  const perPage = Math.min(100, queryInt(ctx.query, 'per_page', 30));
  const page = Math.max(1, queryInt(ctx.query, 'page', 1));
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  let link: string | null = null;
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  if (page < totalPages) {
    const origin = originOf(ctx.req);
    const next = `${origin}${basePath}?per_page=${perPage}&page=${page + 1}`;
    const last = `${origin}${basePath}?per_page=${perPage}&page=${totalPages}`;
    link = `<${next}>; rel="next", <${last}>; rel="last"`;
  }
  return { page: [...slice], link };
}

function sendPage<T>(ctx: RestContext, items: readonly T[], basePath: string): void {
  const { page, link } = paginate(ctx, items, basePath);
  const headers: Record<string, string> = {};
  if (link !== null) headers.link = link;
  sendJson(ctx.store, ctx.res, 200, page, headers);
}

// ---------------------------------------------------------------- contents

/** The tree (flattened) at a branch tip, or an empty map for an unborn ref. */
function treeAtTip(store: Store, repo: Repo, tip: string | undefined): Map<string, FlatEntry> {
  if (tip === undefined) return new Map();
  const treeOid = commitTree(repo, tip);
  if (treeOid === null) return new Map();
  return flattenTree(repo, treeOid);
}

/** The identity server-created commits carry: the token owner. */
function serverIdentity(): string {
  return `${VIEWER.name} <${VIEWER.email}>`;
}

/** Create a commit on `branch` from a flat tree, and move the branch to it. */
function commitFlatTree(
  store: Store,
  repo: Repo,
  branch: string,
  flat: Map<string, FlatEntry>,
  message: string,
  baseTip: string | undefined,
): string {
  const treeOid = buildTreeFromFlat(store, repo, flat);
  const parents = baseTip === undefined ? [] : [baseTip];
  const timestamp = store.clock.tick();
  const commit = buildCommit({
    tree: treeOid,
    parents,
    message,
    author: serverIdentity(),
    committer: serverIdentity(),
    timestamp,
  });
  const commitOid = store.putObject(repo, 'commit', commit);
  store.setRef(repo, `refs/heads/${branch}`, commitOid);
  return commitOid;
}

interface ContentsTarget {
  repo: Repo;
  branch: string;
  tip: string | undefined;
  path: string;
}

/** Resolve a contents path's repo, branch and tip from the route and body. */
function contentsTarget(
  ctx: RestContext,
  owner: string,
  name: string,
  pathSegments: string[],
  bodyBranch: string | undefined,
  queryRef: string | undefined,
): ContentsTarget | null {
  const repo = repoOr404(ctx, owner, name);
  if (repo === null) return null;
  const branch = bodyBranch ?? queryRef ?? repo.defaultBranch;
  let tip = storeBranchTip(ctx.store, repo, branch);
  if (tip === undefined && queryRef !== undefined && isOid(queryRef)) tip = queryRef;
  return { repo, branch, tip, path: pathSegments.join('/') };
}

function storeBranchTip(store: Store, repo: Repo, branch: string): string | undefined {
  if (branch.startsWith('refs/heads/')) return store.getRef(repo, branch);
  return store.branchTip(repo, branch);
}

async function putContents(ctx: RestContext, owner: string, name: string, pathSegments: string[]): Promise<void> {
  const body = isRecord(ctx.body) ? ctx.body : {};
  const message = typeof body.message === 'string' && body.message !== '' ? body.message : 'update file';
  const contentB64 = typeof body.content === 'string' ? body.content : '';
  const content = fromBase64(contentB64);
  if (content === null) {
    sendError(ctx.store, ctx.res, 422, 'content is not valid base64');
    return;
  }
  const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : undefined;
  const target = contentsTarget(ctx, owner, name, pathSegments, branch, ctx.query.get('ref'));
  if (target === null) return;
  const { repo } = target;
  // A named branch that does not exist starts from the default branch tip.
  let baseTip = target.tip;
  if (baseTip === undefined && target.branch !== repo.defaultBranch) {
    baseTip = storeBranchTip(ctx.store, repo, repo.defaultBranch);
  }
  const flat = treeAtTip(ctx.store, repo, baseTip);
  const existing = flat.get(target.path);
  const sha = typeof body.sha === 'string' ? body.sha : undefined;
  if (sha !== undefined) {
    if (existing === undefined || existing.oid !== sha) {
      sendError(ctx.store, ctx.res, 409, 'the file has changed since the given sha');
      return;
    }
  }
  const isCreate = existing === undefined;
  const blobOid = ctx.store.putObject(repo, 'blob', content);
  flat.set(target.path, { oid: blobOid, mode: existing?.mode ?? '100644' });
  const commitOid = commitFlatTree(ctx.store, repo, target.branch, flat, message, baseTip);
  const file = {
    name: target.path.split('/').pop() ?? target.path,
    path: target.path,
    sha: blobOid,
    size: content.length,
    type: 'file',
    encoding: 'base64',
    content: toBase64(content),
  };
  sendJson(ctx.store, ctx.res, isCreate ? 201 : 200, {
    content: file,
    commit: { sha: commitOid, message },
  });
}

function getContents(ctx: RestContext, owner: string, name: string, pathSegments: string[]): void {
  const target = contentsTarget(ctx, owner, name, pathSegments, undefined, ctx.query.get('ref'));
  if (target === null) return;
  const { repo } = target;
  const flat = treeAtTip(ctx.store, repo, target.tip);
  if (target.path === '') {
    // The root directory: its top-level entries.
    const entries = rootEntries(repo, target.tip);
    sendJson(ctx.store, ctx.res, 200, entries);
    return;
  }
  const file = flat.get(target.path);
  if (file !== undefined) {
    const blob = repo.objects.get(file.oid);
    const data = blob === undefined ? Buffer.alloc(0) : blob.data;
    sendJson(ctx.store, ctx.res, 200, {
      name: target.path.split('/').pop() ?? target.path,
      path: target.path,
      sha: file.oid,
      size: data.length,
      type: 'file',
      encoding: 'base64',
      content: toBase64(data),
    });
    return;
  }
  // A directory: entries directly below it.
  const prefix = `${target.path}/`;
  const children = new Map<string, { name: string; path: string; sha: string; type: 'file' | 'dir'; size?: number }>();
  for (const [path, entry] of flat) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash < 0) {
      const blob = repo.objects.get(entry.oid);
      children.set(rest, { name: rest, path, sha: entry.oid, type: 'file', size: blob?.data.length ?? 0 });
    } else {
      const dirName = rest.slice(0, slash);
      if (!children.has(dirName)) {
        const childPath = `${target.path}/${dirName}`;
        const dirTree = dirTreeOid(repo, target.tip, childPath);
        children.set(dirName, { name: dirName, path: childPath, sha: dirTree ?? '', type: 'dir' });
      }
    }
  }
  if (children.size === 0) {
    sendError(ctx.store, ctx.res, 404, 'Not Found');
    return;
  }
  sendJson(ctx.store, ctx.res, 200, [...children.values()].sort((a, b) => (a.name < b.name ? -1 : 1)));
}

/** The tree oid of a directory path at a tip, or null. */
function dirTreeOid(repo: Repo, tip: string | undefined, dirPath: string): string | null {
  if (tip === undefined) return null;
  const treeOid = commitTree(repo, tip);
  if (treeOid === null) return null;
  let current = treeOid;
  for (const segment of dirPath.split('/')) {
    const object = repo.objects.get(current);
    if (object === undefined || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((candidate) => candidate.name === segment && candidate.mode === '40000');
    if (entry === undefined) return null;
    current = entry.oid;
  }
  return current;
}

/** The root directory's entries at a tip. */
function rootEntries(repo: Repo, tip: string | undefined): Array<Record<string, unknown>> {
  if (tip === undefined) return [];
  const treeOid = commitTree(repo, tip);
  if (treeOid === null) return [];
  const object = repo.objects.get(treeOid);
  if (object === undefined || object.type !== 'tree') return [];
  return parseTree(object.data).map((entry) => {
    const isDir = entry.mode === '40000';
    const blob = isDir ? undefined : repo.objects.get(entry.oid);
    return {
      name: entry.name,
      path: entry.name,
      sha: entry.oid,
      type: isDir ? 'dir' : 'file',
      ...(isDir ? {} : { size: blob?.data.length ?? 0 }),
    };
  });
}

async function deleteContents(ctx: RestContext, owner: string, name: string, pathSegments: string[]): Promise<void> {
  const body = isRecord(ctx.body) ? ctx.body : {};
  const message = typeof body.message === 'string' && body.message !== '' ? body.message : 'delete file';
  const sha = typeof body.sha === 'string' ? body.sha : undefined;
  const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : undefined;
  const target = contentsTarget(ctx, owner, name, pathSegments, branch, ctx.query.get('ref'));
  if (target === null) return;
  const { repo } = target;
  const flat = treeAtTip(ctx.store, repo, target.tip);
  const existing = flat.get(target.path);
  if (existing === undefined) {
    sendError(ctx.store, ctx.res, 404, 'Not Found');
    return;
  }
  if (sha !== undefined && existing.oid !== sha) {
    sendError(ctx.store, ctx.res, 409, 'the file has changed since the given sha');
    return;
  }
  flat.delete(target.path);
  const commitOid = commitFlatTree(ctx.store, repo, target.branch, flat, message, target.tip);
  sendJson(ctx.store, ctx.res, 200, { commit: { sha: commitOid, message }, content: null });
}

// ---------------------------------------------------------------- merge

/** Squash-merge an open pull request; returns the merge commit oid or null on conflict. */
export function squashMergePull(store: Store, repo: Repo, pull: PullRequest): string | null {
  const headSha = store.pullHeadSha(repo, pull);
  const baseSha = store.pullBaseSha(repo, pull);
  if (headSha === ZERO_OID || baseSha === ZERO_OID) return null;
  if (headSha === baseSha) return null;
  const base = mergeBase(repo, headSha, baseSha);
  const outcome = threeWayMerge(store, repo, baseSha, headSha, base);
  if (outcome.conflict || outcome.treeOid === null) return null;
  const timestamp = store.clock.tick();
  const message = pull.body !== '' ? `${pull.title}\n\n${pull.body}` : pull.title;
  const commit = buildCommit({
    tree: outcome.treeOid,
    parents: [baseSha],
    message,
    author: serverIdentity(),
    committer: serverIdentity(),
    timestamp,
  });
  const commitOid = store.putObject(repo, 'commit', commit);
  store.setRef(repo, `refs/heads/${pull.baseRef}`, commitOid);
  return commitOid;
}

/** Mark a pull request merged with a squash commit (shared by REST and GraphQL). */
export function finishMerge(store: Store, repo: Repo, pull: PullRequest, sha: string): void {
  const now = store.clock.tickIso();
  pull.merged = true;
  pull.mergedAt = now;
  pull.mergeCommitSha = sha;
  pull.state = 'closed';
  pull.closedAt = now;
  pull.updatedAt = now;
}

// ---------------------------------------------------------------- router

export async function handleRest(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  segments: string[],
  query: Map<string, string>,
): Promise<void> {
  const method = req.method ?? 'GET';
  const ctx: RestContext = { store, req, res, segments, query, body: null };

  // The API root.
  if (segments.length === 0 && method === 'GET') {
    sendJson(store, res, 200, {
      current_user_url: '/api/v3/user',
      current_user_repositories_url: '/api/v3/user/repos',
      rate_limit_url: '/api/v3/rate_limit',
      repository_url: '/api/v3/repos/{owner}/{repo}',
    }, { 'x-oauth-scopes': 'repo, read:org' });
    return;
  }

  // Bodies are JSON; a malformed one is a 400.
  if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
    try {
      ctx.body = await readJsonBody(ctx);
    } catch {
      sendError(store, res, 400, 'the request body is not valid JSON');
      return;
    }
  }

  const [first, second, third] = segments;

  if (first === 'meta' && method === 'GET') {
    sendJson(store, res, 200, { installed_version: '1.0.0' });
    return;
  }

  if (first === 'user' && method === 'GET' && segments.length === 1) {
    sendJson(store, res, 200, userJson(req));
    return;
  }

  if (first === 'user' && second === 'repos') {
    if (method === 'GET') {
      sendPage(ctx, store.listRepos(ownerLogin()).map((repo) => repoJson(req, repo)), '/api/v3/user/repos');
      return;
    }
    if (method === 'POST') {
      const body = isRecord(ctx.body) ? ctx.body : {};
      const name = typeof body.name === 'string' ? body.name : '';
      if (name === '' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) {
        sendError(store, res, 422, 'name is required');
        return;
      }
      const repo = store.createRepo(name, body.private === true, typeof body.description === 'string' ? body.description : '');
      if (repo === null) {
        sendError(store, res, 422, 'name already exists on this account');
        return;
      }
      sendJson(store, res, 201, repoJson(req, repo));
      return;
    }
  }

  if (first === 'repos' && second !== undefined && third !== undefined) {
    const owner = second;
    const name = third;
    const rest = segments.slice(3);

    if (rest.length === 0) {
      if (method === 'GET') {
        const repo = repoOr404(ctx, owner, name);
        if (repo !== null) sendJson(store, res, 200, repoJson(req, repo));
        return;
      }
      if (method === 'PATCH') {
        const repo = repoOr404(ctx, owner, name);
        if (repo === null) return;
        const body = isRecord(ctx.body) ? ctx.body : {};
        if (typeof body.description === 'string') repo.description = body.description;
        if (typeof body.default_branch === 'string' && body.default_branch !== '') repo.defaultBranch = body.default_branch;
        sendJson(store, res, 200, repoJson(req, repo));
        return;
      }
      if (method === 'DELETE') {
        if (owner !== ownerLogin() || store.getRepo(owner, name) === undefined) {
          sendError(store, res, 404, 'Not Found');
          return;
        }
        store.deleteRepo(owner, name);
        res.writeHead(204, { 'x-github-request-id': store.nextRequestId() });
        res.end();
        return;
      }
    }

    if (rest[0] === 'branches' && method === 'GET') {
      const repo = repoOr404(ctx, owner, name);
      if (repo === null) return;
      if (rest.length === 1) {
        const branches = [...repo.refs.keys()]
          .filter((ref) => ref.startsWith('refs/heads/'))
          .sort()
          .map((ref) => ({
            name: ref.slice('refs/heads/'.length),
            commit: { sha: repo.refs.get(ref) as string },
            protected: false,
          }));
        sendJson(store, res, 200, branches);
        return;
      }
      const branch = rest.slice(1).join('/');
      const tip = repo.refs.get(`refs/heads/${branch}`);
      if (tip === undefined) {
        sendError(store, res, 404, 'Not Found');
        return;
      }
      sendJson(store, res, 200, { name: branch, commit: { sha: tip }, protected: false });
      return;
    }

    if (rest[0] === 'commits' && method === 'GET') {
      const repo = repoOr404(ctx, owner, name);
      if (repo === null) return;
      const sha = query.get('sha');
      const commits = gitListCommits(repo, sha);
      const items = commits.map(({ sha: oid, commit }) => ({
        sha: oid,
        commit: {
          // Git stores the message newline-terminated; GitHub's API
          // returns it without the trailing newline(s).
          message: commit.message.replace(/\n+$/, ''),
          author: parseIdentity(commit.author),
          committer: parseIdentity(commit.committer),
          tree: { sha: commit.tree },
        },
        parents: commit.parents.map((parent) => ({ sha: parent })),
        author: { login: VIEWER.login },
        committer: { login: VIEWER.login },
      }));
      sendPage(ctx, items, `/api/v3/repos/${owner}/${name}/commits`);
      return;
    }

    if (rest[0] === 'contents') {
      const pathSegments = rest.slice(1);
      if (method === 'GET') {
        getContents(ctx, owner, name, pathSegments);
        return;
      }
      if (method === 'PUT') {
        await putContents(ctx, owner, name, pathSegments);
        return;
      }
      if (method === 'DELETE') {
        await deleteContents(ctx, owner, name, pathSegments);
        return;
      }
    }

    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (method === 'POST' && rest.length === 2) {
        const repo = repoOr404(ctx, owner, name);
        if (repo === null) return;
        const body = isRecord(ctx.body) ? ctx.body : {};
        const ref = typeof body.ref === 'string' ? body.ref : '';
        const sha = typeof body.sha === 'string' ? body.sha : '';
        if (!ref.startsWith('refs/') || !isOid(sha)) {
          sendError(store, res, 422, 'ref and sha are required');
          return;
        }
        if (repo.refs.has(ref)) {
          sendError(store, res, 422, 'ref already exists');
          return;
        }
        const object = repo.objects.get(sha);
        if (object === undefined) {
          sendError(store, res, 422, 'sha does not exist');
          return;
        }
        store.setRef(repo, ref, sha);
        sendJson(store, res, 201, { ref, object: { sha, type: object.type } });
        return;
      }
      if (method === 'GET') {
        const repo = repoOr404(ctx, owner, name);
        if (repo === null) return;
        const ref = `refs/${rest.slice(2).join('/')}`;
        const tip = repo.refs.get(ref);
        if (tip === undefined) {
          sendError(store, res, 404, 'Not Found');
          return;
        }
        const object = repo.objects.get(tip);
        sendJson(store, res, 200, { ref, object: { sha: tip, type: object?.type ?? 'commit' } });
        return;
      }
    }

    if (rest[0] === 'labels') {
      const repo = repoOr404(ctx, owner, name);
      if (repo === null) return;
      if (method === 'GET') {
        sendJson(store, res, 200, store.listLabels(repo).map(labelJson));
        return;
      }
      if (method === 'POST') {
        const body = isRecord(ctx.body) ? ctx.body : {};
        const labelName = typeof body.name === 'string' ? body.name : '';
        const color = typeof body.color === 'string' && body.color !== '' ? body.color : 'ededed';
        if (labelName === '') {
          sendError(store, res, 422, 'name is required');
          return;
        }
        if (repo.labels.has(labelName)) {
          sendError(store, res, 422, 'label already exists');
          return;
        }
        const label = store.createLabel(repo, labelName, color, typeof body.description === 'string' ? body.description : '');
        sendJson(store, res, 201, labelJson(label));
        return;
      }
    }

    if (rest[0] === 'issues') {
      const repo = repoOr404(ctx, owner, name);
      if (repo === null) return;
      if (rest.length === 1) {
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          const direction = query.get('direction') === 'asc' ? 'asc' : 'desc';
          const list = store.listIssues(repo, state, direction).map((issue) => issueJson(req, repo, issue));
          sendPage(ctx, list, `/api/v3/repos/${owner}/${name}/issues`);
          return;
        }
        if (method === 'POST') {
          const body = isRecord(ctx.body) ? ctx.body : {};
          const title = typeof body.title === 'string' ? body.title : '';
          const issueBody = typeof body.body === 'string' ? body.body : '';
          if (title === '') {
            sendError(store, res, 422, 'title is required');
            return;
          }
          const labels = Array.isArray(body.labels) ? body.labels.filter((entry): entry is string => typeof entry === 'string') : [];
          for (const label of labels) {
            if (!repo.labels.has(label)) {
              sendError(store, res, 422, `label ${label} does not exist`);
              return;
            }
          }
          const issue = store.createIssue(repo, title, issueBody, labels);
          sendJson(store, res, 201, issueJson(req, repo, issue));
          return;
        }
      }
      const number = Number(rest[1]);
      if (!Number.isInteger(number) || number < 1) {
        sendError(store, res, 404, 'Not Found');
        return;
      }
      if (rest.length === 2) {
        const issue = store.getIssue(repo, number);
        if (issue === undefined) {
          sendError(store, res, 404, 'Not Found');
          return;
        }
        if (method === 'GET') {
          sendJson(store, res, 200, issueJson(req, repo, issue));
          return;
        }
        if (method === 'PATCH') {
          const body = isRecord(ctx.body) ? ctx.body : {};
          if (typeof body.title === 'string') issue.title = body.title;
          if (typeof body.body === 'string') issue.body = body.body;
          if (body.state === 'closed') store.closeIssue(repo, issue);
          else if (body.state === 'open') store.reopenIssue(repo, issue);
          if (Array.isArray(body.labels)) {
            const labels = body.labels.filter((entry): entry is string => typeof entry === 'string');
            for (const label of labels) {
              if (!repo.labels.has(label)) {
                sendError(store, res, 422, `label ${label} does not exist`);
                return;
              }
            }
            issue.labels = labels;
          }
          issue.updatedAt = store.clock.tickIso();
          sendJson(store, res, 200, issueJson(req, repo, issue));
          return;
        }
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        const issue = store.getIssue(repo, number);
        if (issue === undefined) {
          sendError(store, res, 404, 'Not Found');
          return;
        }
        if (method === 'GET') {
          sendJson(store, res, 200, store.listComments(repo, number).map((comment) => commentJson(req, repo, comment)));
          return;
        }
        if (method === 'POST') {
          const body = isRecord(ctx.body) ? ctx.body : {};
          const commentBody = typeof body.body === 'string' ? body.body : '';
          if (commentBody === '') {
            sendError(store, res, 422, 'body is required');
            return;
          }
          const comment = store.addComment(repo, issue, commentBody);
          sendJson(store, res, 201, commentJson(req, repo, comment));
          return;
        }
      }
    }

    if (rest[0] === 'pulls') {
      const repo = repoOr404(ctx, owner, name);
      if (repo === null) return;
      if (rest.length === 1) {
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          const list = store.listPulls(repo, state).map((pull) => pullJson(req, store, repo, pull));
          sendPage(ctx, list, `/api/v3/repos/${owner}/${name}/pulls`);
          return;
        }
        if (method === 'POST') {
          const body = isRecord(ctx.body) ? ctx.body : {};
          const title = typeof body.title === 'string' ? body.title : '';
          const pullBody = typeof body.body === 'string' ? body.body : '';
          const head = stripOwnerPrefix(typeof body.head === 'string' ? body.head : '');
          const base = stripOwnerPrefix(typeof body.base === 'string' ? body.base : '');
          if (title === '' || head === '' || base === '') {
            sendError(store, res, 422, 'title, head and base are required');
            return;
          }
          if (store.branchTip(repo, head) === undefined) {
            sendError(store, res, 422, `head branch ${head} does not exist`);
            return;
          }
          if (store.branchTip(repo, base) === undefined) {
            sendError(store, res, 422, `base branch ${base} does not exist`);
            return;
          }
          const pull = store.createPull(repo, title, pullBody, head, base);
          sendJson(store, res, 201, pullJson(req, store, repo, pull));
          return;
        }
      }
      const number = Number(rest[1]);
      if (!Number.isInteger(number) || number < 1) {
        sendError(store, res, 404, 'Not Found');
        return;
      }
      const pull = store.getPull(repo, number);
      if (rest.length === 2) {
        if (pull === undefined) {
          sendError(store, res, 404, 'Not Found');
          return;
        }
        if (method === 'GET') {
          sendJson(store, res, 200, pullJson(req, store, repo, pull));
          return;
        }
      }
      if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
        if (pull === undefined) {
          sendError(store, res, 404, 'Not Found');
          return;
        }
        const headSha = store.pullHeadSha(repo, pull);
        const baseSha = store.pullBaseSha(repo, pull);
        const headTree = headSha === ZERO_OID ? ZERO_OID : (commitTree(repo, headSha) ?? ZERO_OID);
        const baseTree = baseSha === ZERO_OID ? ZERO_OID : (commitTree(repo, baseSha) ?? ZERO_OID);
        const files = diffTrees(repo, baseTree, headTree).map((change) => ({
          filename: change.filename,
          status: change.status,
          additions: change.additions,
          deletions: change.deletions,
          changes: change.changes,
        }));
        sendJson(store, res, 200, files);
        return;
      }
      if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
        if (pull === undefined) {
          sendError(store, res, 404, 'Not Found');
          return;
        }
        if (pull.state !== 'open') {
          sendError(store, res, 405, 'the pull request is already closed');
          return;
        }
        const sha = squashMergePull(store, repo, pull);
        if (sha === null) {
          sendError(store, res, 405, 'the pull request has merge conflicts');
          return;
        }
        finishMerge(store, repo, pull, sha);
        sendJson(store, res, 200, { sha, merged: true, message: 'Pull request successfully merged' });
        return;
      }
    }
  }

  sendError(store, res, 404, 'Not Found');
}

/** `owner:branch` → `branch` (GitHub accepts both spellings for head/base). */
function stripOwnerPrefix(value: string): string {
  const colon = value.indexOf(':');
  return colon >= 0 ? value.slice(colon + 1) : value;
}

/** Parse a commit identity line `Name <email> <epoch> +0000` into its parts. */
function parseIdentity(line: string): { name: string; email: string; date: string } {
  const match = /^(.*) <(.*)> (\d+) \+0000$/.exec(line);
  if (match === null) return { name: line, email: '', date: LogicalClock.iso(1_735_689_600) };
  const [, name, email, epoch] = match as unknown as [string, string, string, string];
  return { name: name ?? '', email: email ?? '', date: LogicalClock.iso(Number(epoch)) };
}
