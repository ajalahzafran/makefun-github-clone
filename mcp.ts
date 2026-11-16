// MCP (`POST /mcp`): JSON-RPC 2.0 over Streamable HTTP, revision 2026-07-28
// (`server/discover`, no handshake) with a legacy `initialize` fallback.
// Six tools over the same store REST uses. Unknown tools answer -32602 or
// -32601, never HTTP 500; a non-JSON body is HTTP 400 with -32700; a call
// without the bearer token is 401 (checked by the router, before this runs).

import type { IncomingMessage, ServerResponse } from 'node:http';
import { squashMergePull, finishMerge } from './rest.ts';
import {
  ownerLogin,
  repoGlobalId,
  issueGlobalId,
  pullGlobalId,
  type Repo,
  type Store,
} from './store.ts';
import { isRecord } from './util.ts';
import { sendJson, readBody } from './respond.ts';

const SERVER_NAME = 'forge';
const SERVER_VERSION = '1.0.0';
const PROTOCOL_VERSION = '2026-07-28';

interface ToolDef {
  name: string;
  description: string;
  properties: Record<string, { type: string; description: string }>;
  required: string[];
}

const TOOLS: readonly ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    properties: {
      name: { type: 'string', description: 'The repository name.' },
      description: { type: 'string', description: 'A short description of the repository.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
    },
    required: ['name'],
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The issue title.' },
      body: { type: 'string', description: 'The issue body.' },
    },
    required: ['owner', 'repo', 'title'],
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      state: { type: 'string', description: 'Filter by state: open, closed or all.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The pull request title.' },
      head: { type: 'string', description: 'The head branch name.' },
      base: { type: 'string', description: 'The base branch name.' },
      body: { type: 'string', description: 'The pull request body.' },
    },
    required: ['owner', 'repo', 'title', 'head', 'base'],
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      pull_number: { type: 'integer', description: 'The pull request number.' },
    },
    required: ['owner', 'repo', 'pull_number'],
  },
];

function toolListResult(): Record<string, unknown> {
  return {
    tools: TOOLS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: { type: 'object', properties: tool.properties, required: tool.required },
    })),
  };
}

function repoResult(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: repoGlobalId(repo.id),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
  };
}

function toolResult(value: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
    isError: false,
  };
}

function toolError(message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: message }],
    structuredContent: { error: message },
    isError: true,
  };
}

function findRepo(store: Store, owner: unknown, repo: unknown): Repo | null {
  if (typeof owner !== 'string' || typeof repo !== 'string') return null;
  if (owner !== ownerLogin()) return null;
  return store.getRepo(owner, repo) ?? null;
}

function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const def = TOOLS.find((tool) => tool.name === name);
  if (def === undefined) return toolError(`unknown tool: ${name}`);
  for (const required of def.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      return toolError(`missing required argument: ${required}`);
    }
  }
  switch (name) {
    case 'create_repo': {
      const repoName = String(args.name);
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(repoName)) return toolError('name is required');
      const repo = store.createRepo(
        repoName,
        args.private === true,
        typeof args.description === 'string' ? args.description : '',
      );
      if (repo === null) return toolError('name already exists on this account');
      return toolResult(repoResult(repo));
    }
    case 'get_repo': {
      const repo = findRepo(store, args.owner, args.repo);
      if (repo === null) return toolError('Not Found');
      return toolResult(repoResult(repo));
    }
    case 'create_issue': {
      const repo = findRepo(store, args.owner, args.repo);
      if (repo === null) return toolError('Not Found');
      const title = String(args.title);
      const body = typeof args.body === 'string' ? args.body : '';
      const issue = store.createIssue(repo, title, body, []);
      return toolResult({
        id: issue.id,
        node_id: issueGlobalId(repo.id, issue.number),
        number: issue.number,
        title: issue.title,
        body: issue.body,
        state: issue.state,
        labels: [],
        url: `/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
      });
    }
    case 'list_issues': {
      const repo = findRepo(store, args.owner, args.repo);
      if (repo === null) return toolError('Not Found');
      const state = typeof args.state === 'string' ? args.state.toLowerCase() : 'open';
      const list = store.listIssues(repo, state === 'all' ? 'all' : state, 'desc').map((issue) => ({
        id: issue.id,
        node_id: issueGlobalId(repo.id, issue.number),
        number: issue.number,
        title: issue.title,
        body: issue.body,
        state: issue.state,
        labels: issue.labels,
      }));
      return toolResult(list);
    }
    case 'create_pull_request': {
      const repo = findRepo(store, args.owner, args.repo);
      if (repo === null) return toolError('Not Found');
      const head = String(args.head);
      const base = String(args.base);
      if (store.branchTip(repo, head) === undefined) return toolError(`head branch ${head} does not exist`);
      if (store.branchTip(repo, base) === undefined) return toolError(`base branch ${base} does not exist`);
      const pull = store.createPull(repo, String(args.title), typeof args.body === 'string' ? args.body : '', head, base);
      return toolResult({
        id: pull.id,
        node_id: pullGlobalId(repo.id, pull.number),
        number: pull.number,
        title: pull.title,
        body: pull.body,
        state: pull.state,
        head: { ref: pull.headRef, sha: store.pullHeadSha(repo, pull) },
        base: { ref: pull.baseRef, sha: store.pullBaseSha(repo, pull) },
        merged: pull.merged,
      });
    }
    case 'merge_pull_request': {
      const repo = findRepo(store, args.owner, args.repo);
      if (repo === null) return toolError('Not Found');
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number(args.pull_number);
      const pull = store.getPull(repo, number);
      if (pull === undefined) return toolError('Not Found');
      if (pull.state !== 'open') return toolError('the pull request is already closed');
      const sha = squashMergePull(store, repo, pull);
      if (sha === null) return toolError('the pull request has merge conflicts');
      finishMerge(store, repo, pull, sha);
      return toolResult({ number: pull.number, merged: true, sha, state: pull.state });
    }
    default:
      return toolError(`unknown tool: ${name}`);
  }
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function handleOne(store: Store, request: unknown): Record<string, unknown> | null {
  if (!isRecord(request)) return rpcError(null, -32600, 'Invalid Request');
  const id = request.id ?? null;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = isRecord(request.params) ? request.params : {};
  const isNotification = request.id === undefined;
  if (method === '') return rpcError(id, -32600, 'Invalid Request');
  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    return null; // A notification gets no JSON-RPC response (HTTP 202, empty body).
  }
  if (isNotification) return null;
  switch (method) {
    case 'server/discover':
      return rpcResult(id, {
        supportedVersions: [PROTOCOL_VERSION],
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
      });
    case 'initialize': {
      const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_VERSION;
      return rpcResult(id, {
        protocolVersion: offered,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, toolListResult());
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = isRecord(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
      if (name === '') return rpcError(id, -32602, 'tools/call needs a tool name');
      if (TOOLS.every((tool) => tool.name !== name)) {
        return rpcError(id, -32602, `unknown tool: ${name}`);
      }
      return rpcResult(id, callTool(store, name, args));
    }
    default:
      return rpcError(id, -32601, `method not found: ${method}`);
  }
}

export async function handleMcp(store: Store, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method === 'DELETE') {
    res.writeHead(204, { 'x-github-request-id': store.nextRequestId() });
    res.end();
    return;
  }
  if (req.method !== 'POST') {
    sendJson(store, res, 405, { message: 'MCP requires POST' });
    return;
  }
  let raw: Buffer;
  try {
    raw = await readBody(req);
  } catch {
    sendJson(store, res, 400, rpcError(null, -32700, 'Parse error'));
    return;
  }
  let body: unknown;
  try {
    body = JSON.parse(raw.toString('utf8')) as unknown;
  } catch {
    sendJson(store, res, 400, rpcError(null, -32700, 'Parse error'));
    return;
  }
  if (Array.isArray(body)) {
    const results = body.map((entry) => handleOne(store, entry)).filter((entry) => entry !== null);
    sendJson(store, res, 200, results);
    return;
  }
  const result = handleOne(store, body);
  if (result === null) {
    res.writeHead(202, { 'x-github-request-id': store.nextRequestId() });
    res.end();
    return;
  }
  sendJson(store, res, 200, result);
}
