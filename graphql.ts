// GraphQL v4 (`POST /api/graphql`): a small parser and executor for exactly
// the documents `gh` and `github-mcp-server` send — viewer, repository,
// issues, pull requests, the four mutations, introspection, `node(id:)` and
// batched operations. No schema library: the field sets are the ones the
// suite reads. Unknown fields are HTTP 200 with an `errors` array naming
// them; an unknown repository is `data.repository = null` with no errors.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { diffTrees } from './gitcore.ts';
import { commitTree } from './githttp.ts';
import { isMergeable, squashMergePull, finishMerge } from './rest.ts';
import {
  decodeGlobalId,
  issueGlobalId,
  pullGlobalId,
  commentGlobalId,
  repoGlobalId,
  userGlobalId,
  ownerLogin,
  type Issue,
  type PullRequest,
  type Repo,
  type Store,
} from './store.ts';
import { VIEWER } from './scenario.ts';
import { ZERO_OID, isRecord, fromBase64Url, toBase64Url } from './util.ts';
import { sendJson, sendError, readBody } from './respond.ts';

// ---------------------------------------------------------------- parser

type TokenKind = 'name' | 'int' | 'float' | 'string' | 'punct' | 'eof';

interface Token {
  kind: TokenKind;
  value: string;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (ch: string): boolean => /[A-Za-z_]/.test(ch);
  const isNameChar = (ch: string): boolean => /[A-Za-z0-9_]/.test(ch);
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === ';') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@|&'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (source.slice(i, i + 3) === '"""') {
        const end = source.indexOf('"""', i + 3);
        const text = end < 0 ? source.slice(i + 3) : source.slice(i + 3, end);
        tokens.push({ kind: 'string', value: text });
        i = end < 0 ? source.length : end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const esc = source[j + 1] as string;
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc === '"' ? '"' : esc === '\\' ? '\\' : esc === '/' ? '/' : esc;
          j += 2;
        } else {
          out += source[j] as string;
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      if (source[j] === '-') j += 1;
      let isFloat = false;
      while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      if (source[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (isNameStart(ch)) {
      let j = i;
      while (j < source.length && isNameChar(source[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  kind: 'field';
  name: string;
  alias: string | null;
  args: Array<{ name: string; value: ValueNode }>;
  selections: SelectionNode[];
}

interface FragmentNode {
  kind: 'fragment';
  typeCondition: string | null;
  selections: SelectionNode[];
}

type SelectionNode = FieldNode | FragmentNode;

interface Operation {
  kind: 'query' | 'mutation' | 'subscription';
  name: string | null;
  variables: Array<{ name: string; defaultValue: ValueNode | null }>;
  selections: SelectionNode[];
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos] as Token;
  }

  private next(): Token {
    const token = this.tokens[this.pos] as Token;
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new Error(`expected ${JSON.stringify(value)}, got ${JSON.stringify(token.value)}`);
    }
  }

  private expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'name' || (value !== undefined && token.value !== value)) {
      throw new Error(`expected name ${value ?? ''}, got ${JSON.stringify(token.value)}`);
    }
    return token.value;
  }

  parseDocument(): Operation[] {
    const operations: Operation[] = [];
    while (this.peek().kind !== 'eof') {
      operations.push(this.parseOperation());
    }
    return operations;
  }

  private parseOperation(): Operation {
    let kind: 'query' | 'mutation' | 'subscription' = 'query';
    let name: string | null = null;
    const token = this.peek();
    if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription')) {
      kind = this.next().value as 'query' | 'mutation' | 'subscription';
      if (this.peek().kind === 'name') name = this.next().value;
    } else if (token.kind === 'punct' && token.value === '{') {
      // Shorthand query.
    } else {
      throw new Error(`unexpected token ${JSON.stringify(token.value)} at operation start`);
    }
    const variables: Array<{ name: string; defaultValue: ValueNode | null }> = [];
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
        this.expectPunct('$');
        const varName = this.expectName();
        this.expectPunct(':');
        this.parseType();
        let defaultValue: ValueNode | null = null;
        if (this.peek().kind === 'punct' && this.peek().value === '=') {
          this.next();
          defaultValue = this.parseValue();
        }
        variables.push({ name: varName, defaultValue });
      }
      this.expectPunct(')');
    }
    // Directives, if any, are skipped: they do not change the answer.
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.expectName();
      if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseArguments();
    }
    const selections = this.parseSelectionSet();
    return { kind, name, variables, selections };
  }

  private parseType(): void {
    if (this.peek().kind === 'punct' && this.peek().value === '[') {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.peek().kind === 'punct' && this.peek().value === '!') this.next();
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      if (this.peek().kind === 'eof') throw new Error('unterminated selection set');
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    if (this.peek().kind === 'punct' && this.peek().value === '...') {
      this.next();
      let typeCondition: string | null = null;
      if (this.peek().kind === 'name' && this.peek().value === 'on') {
        this.next();
        typeCondition = this.expectName();
      } else if (this.peek().kind === 'name') {
        // A named fragment spread: not used by the suite's documents.
        this.next();
        return { kind: 'fragment', typeCondition: null, selections: [] };
      }
      while (this.peek().kind === 'punct' && this.peek().value === '@') {
        this.next();
        this.expectName();
        if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseArguments();
      }
      const selections = this.parseSelectionSet();
      return { kind: 'fragment', typeCondition, selections };
    }
    const first = this.expectName();
    let name = first;
    let alias: string | null = null;
    if (this.peek().kind === 'punct' && this.peek().value === ':') {
      this.next();
      alias = first;
      name = this.expectName();
    }
    let args: Array<{ name: string; value: ValueNode }> = [];
    if (this.peek().kind === 'punct' && this.peek().value === '(') args = this.parseArguments();
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.expectName();
      if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseArguments();
    }
    let selections: SelectionNode[] = [];
    if (this.peek().kind === 'punct' && this.peek().value === '{') selections = this.parseSelectionSet();
    return { kind: 'field', name, alias, args, selections };
  }

  private parseArguments(): Array<{ name: string; value: ValueNode }> {
    this.expectPunct('(');
    const args: Array<{ name: string; value: ValueNode }> = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args.push({ name, value: this.parseValue() });
    }
    this.expectPunct(')');
    return args;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'int') return { kind: 'int', value: Number(token.value) };
    if (token.kind === 'float') return { kind: 'float', value: Number(token.value) };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected value token ${JSON.stringify(token.value)}`);
  }
}

// ---------------------------------------------------------------- execution

interface ExecContext {
  store: Store;
  variables: Record<string, unknown>;
  errors: Array<{ message: string }>;
}

/** Resolve a value node against the operation's variables. */
function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable': {
      const value = variables[node.name];
      return value === undefined ? null : value;
    }
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((entry) => resolveValue(entry, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

function argOf(field: FieldNode, name: string, ctx: ExecContext): unknown {
  const arg = field.args.find((entry) => entry.name === name);
  if (arg === undefined) return undefined;
  return resolveValue(arg.value, ctx.variables);
}

function strArg(field: FieldNode, name: string, ctx: ExecContext): string | undefined {
  const value = argOf(field, name, ctx);
  return typeof value === 'string' ? value : undefined;
}

function intArg(field: FieldNode, name: string, ctx: ExecContext): number | undefined {
  const value = argOf(field, name, ctx);
  return typeof value === 'number' ? Math.trunc(value) : undefined;
}

// --- introspection data

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'closedAt', 'url', 'author', 'labels', 'comments'],
  PullRequest: ['id', 'number', 'title', 'body', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files', 'createdAt', 'updatedAt', 'closedAt', 'author'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'url', 'createdAt', 'updatedAt', 'isPrivate'],
  SearchType: [],
  Viewer: ['login'],
  User: ['login', 'id', 'name', 'email'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'CODE', 'COMMIT', 'MILESTONE', 'PROJECT', 'WIKI', 'PULL_REQUEST'],
};

const TYPE_KIND: Record<string, string> = {
  Issue: 'OBJECT',
  PullRequest: 'OBJECT',
  Repository: 'OBJECT',
  SearchType: 'ENUM',
  Viewer: 'OBJECT',
  User: 'OBJECT',
};

// --- shared resolvers

function resolveIssue(ctx: ExecContext, repo: Repo, issue: Issue, selections: SelectionNode[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      if (selection.typeCondition !== null && selection.typeCondition !== 'Issue') continue;
      Object.assign(out, resolveIssue(ctx, repo, issue, selection.selections));
      continue;
    }
    const key = selection.alias ?? selection.name;
    switch (selection.name) {
      case 'id':
        out[key] = issueGlobalId(repo.id, issue.number);
        break;
      case 'number':
        out[key] = issue.number;
        break;
      case 'title':
        out[key] = issue.title;
        break;
      case 'state':
        out[key] = issue.state === 'open' ? 'OPEN' : 'CLOSED';
        break;
      case 'body':
        out[key] = issue.body;
        break;
      default:
        ctx.errors.push({ message: `Cannot query field "${selection.name}" on type "Issue".` });
        out[key] = null;
    }
  }
  return out;
}

function resolvePull(ctx: ExecContext, repo: Repo, pull: PullRequest, selections: SelectionNode[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      if (selection.typeCondition !== null && selection.typeCondition !== 'PullRequest') continue;
      Object.assign(out, resolvePull(ctx, repo, pull, selection.selections));
      continue;
    }
    const key = selection.alias ?? selection.name;
    switch (selection.name) {
      case 'id':
        out[key] = pullGlobalId(repo.id, pull.number);
        break;
      case 'number':
        out[key] = pull.number;
        break;
      case 'headRefName':
        out[key] = pull.headRef;
        break;
      case 'baseRefName':
        out[key] = pull.baseRef;
        break;
      case 'mergeable':
        out[key] = pull.state === 'open' ? (isMergeable(ctx.store, repo, pull) ? 'MERGEABLE' : 'CONFLICTING') : 'UNKNOWN';
        break;
      case 'state':
        out[key] = pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
        break;
      case 'merged':
        out[key] = pull.merged;
        break;
      case 'title':
        out[key] = pull.title;
        break;
      case 'body':
        out[key] = pull.body;
        break;
      case 'files': {
        const first = intArg(selection, 'first', ctx) ?? 10;
        const headSha = ctx.store.pullHeadSha(repo, pull);
        const baseSha = ctx.store.pullBaseSha(repo, pull);
        const headTree = headSha === ZERO_OID ? ZERO_OID : (commitTree(repo, headSha) ?? ZERO_OID);
        const baseTree = baseSha === ZERO_OID ? ZERO_OID : (commitTree(repo, baseSha) ?? ZERO_OID);
        // The file fields are the selections inside `nodes`, not the
        // selections of `files` itself.
        const nodeSelections: SelectionNode[] = [];
        for (const sub of selection.selections) {
          if (sub.kind === 'field' && sub.name === 'nodes') nodeSelections.push(...sub.selections);
        }
        const files = diffTrees(repo, baseTree, headTree)
          .slice(0, Math.max(0, first))
          .map((change) => resolveFileNode(change.filename, nodeSelections));
        out[key] = { nodes: files };
        break;
      }
      default:
        ctx.errors.push({ message: `Cannot query field "${selection.name}" on type "PullRequest".` });
        out[key] = null;
    }
  }
  return out;
}

function resolveFileNode(path: string, selections: SelectionNode[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      Object.assign(out, resolveFileNode(path, selection.selections));
      continue;
    }
    const key = selection.alias ?? selection.name;
    if (selection.name === 'path') out[key] = path;
    else out[key] = null;
  }
  return out;
}

/** Issues sorted for a connection: CREATED_AT DESC (numbers descending), or creation order. */
function sortedIssues(repo: Repo, orderBy: unknown, states: unknown): Issue[] {
  let list = [...repo.issues];
  if (Array.isArray(states)) {
    const wanted = new Set(states.map((entry) => String(entry)));
    list = list.filter((issue) => wanted.has(issue.state === 'open' ? 'OPEN' : 'CLOSED'));
  }
  let direction = 'DESC';
  if (isRecord(orderBy) && typeof orderBy.direction === 'string') direction = orderBy.direction;
  list.sort((a, b) => {
    const byCreated = direction === 'DESC' ? b.createdSeq - a.createdSeq : a.createdSeq - b.createdSeq;
    if (byCreated !== 0) return byCreated;
    return direction === 'DESC' ? b.number - a.number : a.number - b.number;
  });
  return list;
}

function cursorFor(index: number): string {
  return toBase64Url(`issue-cursor:${index}`);
}

function indexOfCursor(after: string | undefined): number {
  if (after === undefined || after === '') return -1;
  const decoded = fromBase64Url(after);
  if (decoded === null) return -1;
  const match = /^issue-cursor:(\d+)$/.exec(decoded);
  return match === null ? -1 : Number(match[1]);
}

function resolveIssuesConnection(
  ctx: ExecContext,
  repo: Repo,
  field: FieldNode,
): Record<string, unknown> {
  const first = intArg(field, 'first', ctx);
  const after = strArg(field, 'after', ctx);
  const states = argOf(field, 'states', ctx);
  const orderBy = argOf(field, 'orderBy', ctx);
  const sorted = sortedIssues(repo, orderBy, states);
  const start = indexOfCursor(after) + 1;
  const window = sorted.slice(start, first === undefined ? undefined : start + Math.max(0, first));
  const nodeSelections = field.selections.flatMap((selection) =>
    selection.kind === 'field' && selection.name === 'nodes' ? selection.selections : [],
  );
  const resolvedNodes = window.map((issue) => resolveIssue(ctx, repo, issue, nodeSelections));
  const endIndex = window.length === 0 ? -1 : start + window.length - 1;
  const pageInfo: Record<string, unknown> = {};
  for (const selection of field.selections) {
    if (selection.kind === 'field' && selection.name === 'pageInfo') {
      for (const sub of selection.selections) {
        if (sub.kind !== 'field') continue;
        const key = sub.alias ?? sub.name;
        if (sub.name === 'hasNextPage') pageInfo[key] = endIndex + 1 < sorted.length;
        else if (sub.name === 'endCursor') pageInfo[key] = endIndex < 0 ? null : cursorFor(endIndex);
        else pageInfo[key] = null;
      }
    }
  }
  const out: Record<string, unknown> = {};
  for (const selection of field.selections) {
    if (selection.kind !== 'field') continue;
    const key = selection.alias ?? selection.name;
    if (selection.name === 'nodes') out[key] = resolvedNodes;
    else if (selection.name === 'pageInfo') out[key] = pageInfo;
    else if (selection.name === 'totalCount') out[key] = sorted.length;
    else out[key] = null;
  }
  return out;
}

function resolveRepository(ctx: ExecContext, repo: Repo, selections: SelectionNode[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      if (selection.typeCondition !== null && selection.typeCondition !== 'Repository') continue;
      Object.assign(out, resolveRepository(ctx, repo, selection.selections));
      continue;
    }
    const key = selection.alias ?? selection.name;
    switch (selection.name) {
      case 'id':
        out[key] = repoGlobalId(repo.id);
        break;
      case 'databaseId':
        out[key] = repo.id;
        break;
      case 'name':
        out[key] = repo.name;
        break;
      case 'nameWithOwner':
        out[key] = `${repo.owner}/${repo.name}`;
        break;
      case 'owner':
        out[key] = resolveUser(ctx, selection.selections);
        break;
      case 'defaultBranchRef': {
        const tip = ctx.store.defaultTip(repo);
        out[key] = tip === undefined ? null : { name: repo.defaultBranch };
        break;
      }
      case 'viewerPermission':
        out[key] = 'ADMIN';
        break;
      case 'hasIssuesEnabled':
        out[key] = true;
        break;
      case 'issue': {
        const number = intArg(selection, 'number', ctx);
        const issue = number === undefined ? undefined : ctx.store.getIssue(repo, number);
        out[key] = issue === undefined ? null : resolveIssue(ctx, repo, issue, selection.selections);
        break;
      }
      case 'issues':
        out[key] = resolveIssuesConnection(ctx, repo, selection);
        break;
      case 'pullRequests': {
        const first = intArg(selection, 'first', ctx) ?? 10;
        const nodeSelections = selection.selections.flatMap((entry) =>
          entry.kind === 'field' && entry.name === 'nodes' ? entry.selections : [],
        );
        const pulls = ctx.store.listPulls(repo, 'open').slice(0, Math.max(0, first));
        const nodes = pulls.map((pull) => resolvePull(ctx, repo, pull, nodeSelections));
        out[key] = { nodes };
        break;
      }
      case 'pullRequest': {
        const number = intArg(selection, 'number', ctx);
        const pull = number === undefined ? undefined : ctx.store.getPull(repo, number);
        out[key] = pull === undefined ? null : resolvePull(ctx, repo, pull, selection.selections);
        break;
      }
      default:
        ctx.errors.push({ message: `Cannot query field "${selection.name}" on type "Repository".` });
        out[key] = null;
    }
  }
  return out;
}

function resolveUser(ctx: ExecContext, selections: SelectionNode[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      Object.assign(out, resolveUser(ctx, selection.selections));
      continue;
    }
    const key = selection.alias ?? selection.name;
    switch (selection.name) {
      case 'login':
        out[key] = VIEWER.login;
        break;
      case 'id':
        out[key] = userGlobalId(VIEWER.login);
        break;
      case 'name':
        out[key] = VIEWER.name;
        break;
      case 'email':
        out[key] = VIEWER.email;
        break;
      default:
        ctx.errors.push({ message: `Cannot query field "${selection.name}" on type "User".` });
        out[key] = null;
    }
  }
  return out;
}

function resolveTypeIntrospection(ctx: ExecContext, field: FieldNode): Record<string, unknown> | null {
  const name = strArg(field, 'name', ctx);
  if (name === undefined) return null;
  const fields = TYPE_FIELDS[name];
  const enums = ENUM_VALUES[name];
  if (fields === undefined && enums === undefined) return null;
  const out: Record<string, unknown> = {};
  for (const selection of field.selections) {
    if (selection.kind === 'fragment') continue;
    const key = selection.alias ?? selection.name;
    if (selection.name === 'name') out[key] = name;
    else if (selection.name === 'kind') out[key] = TYPE_KIND[name] ?? 'OBJECT';
    else if (selection.name === 'fields') {
      const subSelections = selection.selections;
      out[key] = (fields ?? []).map((fieldName) => {
        const entry: Record<string, unknown> = {};
        for (const sub of subSelections) {
          if (sub.kind !== 'field') continue;
          const subKey = sub.alias ?? sub.name;
          entry[subKey] = sub.name === 'name' ? fieldName : null;
        }
        return entry;
      });
    } else if (selection.name === 'enumValues') {
      const subSelections = selection.selections;
      out[key] = (enums ?? []).map((value) => {
        const entry: Record<string, unknown> = {};
        for (const sub of subSelections) {
          if (sub.kind !== 'field') continue;
          const subKey = sub.alias ?? sub.name;
          entry[subKey] = sub.name === 'name' ? value : null;
        }
        return entry;
      });
    } else {
      out[key] = null;
    }
  }
  return out;
}

// --- mutations

function findRepoByGlobalId(ctx: ExecContext, globalId: unknown): Repo | null {
  if (typeof globalId !== 'string') return null;
  const decoded = decodeGlobalId(globalId);
  if (decoded === null || decoded.type !== 'Repository') return null;
  const id = Number(decoded.key);
  if (!Number.isInteger(id)) return null;
  return ctx.store.getRepoById(id) ?? null;
}

function findIssueByGlobalId(ctx: ExecContext, globalId: unknown): { repo: Repo; issue: Issue } | null {
  if (typeof globalId !== 'string') return null;
  const decoded = decodeGlobalId(globalId);
  if (decoded === null || decoded.type !== 'Issue') return null;
  const [repoId, number] = decoded.key.split(':');
  const repo = ctx.store.getRepoById(Number(repoId));
  if (repo === undefined) return null;
  const issue = ctx.store.getIssue(repo, Number(number));
  if (issue === undefined) return null;
  return { repo, issue };
}

function findPullByGlobalId(ctx: ExecContext, globalId: unknown): { repo: Repo; pull: PullRequest } | null {
  if (typeof globalId !== 'string') return null;
  const decoded = decodeGlobalId(globalId);
  if (decoded === null || decoded.type !== 'PullRequest') return null;
  const [repoId, number] = decoded.key.split(':');
  const repo = ctx.store.getRepoById(Number(repoId));
  if (repo === undefined) return null;
  const pull = ctx.store.getPull(repo, Number(number));
  if (pull === undefined) return null;
  return { repo, pull };
}

function executeMutation(ctx: ExecContext, field: FieldNode): Record<string, unknown> | null {
  const input = argOf(field, 'input', ctx);
  const inputRecord = isRecord(input) ? input : {};
  const selections = field.selections;
  switch (field.name) {
    case 'createIssue': {
      const repo = findRepoByGlobalId(ctx, inputRecord.repositoryId);
      const title = typeof inputRecord.title === 'string' ? inputRecord.title : '';
      const body = typeof inputRecord.body === 'string' ? inputRecord.body : '';
      if (repo === null || title === '') {
        ctx.errors.push({ message: 'createIssue: the repository or title is missing.' });
        return null;
      }
      const issue = ctx.store.createIssue(repo, title, body, []);
      return { issue: pickIssueFields(ctx, repo, issue, selections) };
    }
    case 'closeIssue': {
      const found = findIssueByGlobalId(ctx, inputRecord.issueId);
      if (found === null) {
        ctx.errors.push({ message: 'closeIssue: the issue does not exist.' });
        return null;
      }
      ctx.store.closeIssue(found.repo, found.issue);
      return { issue: pickIssueFields(ctx, found.repo, found.issue, selections) };
    }
    case 'createPullRequest': {
      const repo = findRepoByGlobalId(ctx, inputRecord.repositoryId);
      const head = typeof inputRecord.headRefName === 'string' ? inputRecord.headRefName : '';
      const base = typeof inputRecord.baseRefName === 'string' ? inputRecord.baseRefName : '';
      const title = typeof inputRecord.title === 'string' ? inputRecord.title : '';
      const body = typeof inputRecord.body === 'string' ? inputRecord.body : '';
      if (repo === null || head === '' || base === '' || title === '') {
        ctx.errors.push({ message: 'createPullRequest: the repository, branches or title are missing.' });
        return null;
      }
      if (ctx.store.branchTip(repo, head) === undefined || ctx.store.branchTip(repo, base) === undefined) {
        ctx.errors.push({ message: 'createPullRequest: the head or base branch does not exist.' });
        return null;
      }
      const pull = ctx.store.createPull(repo, title, body, head, base);
      return { pullRequest: pickPullFields(ctx, repo, pull, selections) };
    }
    case 'mergePullRequest': {
      const found = findPullByGlobalId(ctx, inputRecord.pullRequestId);
      if (found === null) {
        ctx.errors.push({ message: 'mergePullRequest: the pull request does not exist.' });
        return null;
      }
      const { repo, pull } = found;
      if (pull.state !== 'open') {
        ctx.errors.push({ message: 'mergePullRequest: the pull request is not open.' });
        return null;
      }
      const sha = squashMergePull(ctx.store, repo, pull);
      if (sha === null) {
        ctx.errors.push({ message: 'mergePullRequest: the pull request has merge conflicts.' });
        return null;
      }
      finishMerge(ctx.store, repo, pull, sha);
      return { pullRequest: pickPullFields(ctx, repo, pull, selections) };
    }
    case 'addComment': {
      const found = findIssueByGlobalId(ctx, inputRecord.subjectId);
      const body = typeof inputRecord.body === 'string' ? inputRecord.body : '';
      if (found === null || body === '') {
        ctx.errors.push({ message: 'addComment: the subject or body is missing.' });
        return null;
      }
      const comment = ctx.store.addComment(found.repo, found.issue, body);
      return { commentEdge: { node: { id: commentGlobalId(found.repo.id, found.issue.number, comment.id), body: comment.body } } };
    }
    default:
      ctx.errors.push({ message: `Cannot query field "${field.name}" on type "Mutation".` });
      return null;
  }
}

/** The sub-selections of a mutation payload field (e.g. `issue` in createIssue). */
function payloadSelections(selections: SelectionNode[], payloadName: string): SelectionNode[] {
  for (const selection of selections) {
    if (selection.kind === 'field' && selection.name === payloadName) return selection.selections;
  }
  return [];
}

function pickIssueFields(ctx: ExecContext, repo: Repo, issue: Issue, fieldSelections: SelectionNode[]): Record<string, unknown> {
  return resolveIssue(ctx, repo, issue, payloadSelections(fieldSelections, 'issue'));
}

function pickPullFields(ctx: ExecContext, repo: Repo, pull: PullRequest, fieldSelections: SelectionNode[]): Record<string, unknown> {
  return resolvePull(ctx, repo, pull, payloadSelections(fieldSelections, 'pullRequest'));
}

// --- root

function executeOperation(ctx: ExecContext, operation: Operation): { data: Record<string, unknown> | null; errors: Array<{ message: string }> } {
  const data: Record<string, unknown> = {};
  for (const selection of operation.selections) {
    if (selection.kind === 'fragment') {
      // A root fragment is not used by the suite's documents; ignore it.
      continue;
    }
    const key = selection.alias ?? selection.name;
    if (operation.kind === 'mutation') {
      data[key] = executeMutation(ctx, selection);
      continue;
    }
    switch (selection.name) {
      case 'viewer':
        data[key] = resolveViewer(ctx, selection.selections);
        break;
      case 'repository': {
        const owner = strArg(selection, 'owner', ctx);
        const name = strArg(selection, 'name', ctx);
        const repo = owner === ownerLogin() && name !== undefined ? ctx.store.getRepo(owner, name) : undefined;
        data[key] = repo === undefined ? null : resolveRepository(ctx, repo, selection.selections);
        break;
      }
      case 'node': {
        const id = strArg(selection, 'id', ctx);
        data[key] = resolveNode(ctx, id, selection.selections);
        break;
      }
      case '__type':
        data[key] = resolveTypeIntrospection(ctx, selection);
        break;
      default:
        ctx.errors.push({ message: `Cannot query field "${selection.name}" on type "Query".` });
        data[key] = null;
    }
  }
  return { data, errors: ctx.errors };
}

function resolveViewer(ctx: ExecContext, selections: SelectionNode[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      Object.assign(out, resolveViewer(ctx, selection.selections));
      continue;
    }
    const key = selection.alias ?? selection.name;
    if (selection.name === 'login') out[key] = VIEWER.login;
    else {
      ctx.errors.push({ message: `Cannot query field "${selection.name}" on type "Viewer".` });
      out[key] = null;
    }
  }
  return out;
}

function resolveNode(ctx: ExecContext, id: string | undefined, selections: SelectionNode[]): Record<string, unknown> | null {
  if (id === undefined) return null;
  const decoded = decodeGlobalId(id);
  if (decoded === null) return null;
  if (decoded.type === 'Repository') {
    const repo = ctx.store.getRepoById(Number(decoded.key));
    if (repo === undefined) return null;
    return resolveRepository(ctx, repo, selections);
  }
  if (decoded.type === 'Issue') {
    const found = findIssueByGlobalId(ctx, id);
    if (found === null) return null;
    return resolveIssue(ctx, found.repo, found.issue, selections);
  }
  if (decoded.type === 'PullRequest') {
    const found = findPullByGlobalId(ctx, id);
    if (found === null) return null;
    return resolvePull(ctx, found.repo, found.pull, selections);
  }
  return null;
}

// ---------------------------------------------------------------- HTTP

export async function handleGraphql(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.method !== 'POST') {
    sendError(store, res, 405, 'GraphQL requires POST');
    return;
  }
  let raw: Buffer;
  try {
    raw = await readBody(req);
  } catch {
    sendError(store, res, 400, 'could not read the request body');
    return;
  }
  let body: unknown;
  try {
    body = JSON.parse(raw.toString('utf8')) as unknown;
  } catch {
    sendError(store, res, 400, 'the request body is not valid JSON');
    return;
  }
  const operations = Array.isArray(body) ? body : [body];
  const results = operations.map((entry) => executeOne(store, entry));
  sendJson(store, res, 200, Array.isArray(body) ? results : results[0]);
}

function executeOne(store: Store, entry: unknown): Record<string, unknown> {
  if (!isRecord(entry) || typeof entry.query !== 'string') {
    return { data: null, errors: [{ message: 'the request needs a query string.' }] };
  }
  const variables = isRecord(entry.variables) ? (entry.variables as Record<string, unknown>) : {};
  let parsed: Operation[];
  try {
    parsed = new Parser(tokenize(entry.query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'the query could not be parsed.' }] };
  }
  const operation = parsed.find((candidate) => entry.operationName === undefined || candidate.name === entry.operationName) ?? parsed[0];
  if (operation === undefined) {
    return { data: null, errors: [{ message: 'the document holds no operation.' }] };
  }
  const ctx: ExecContext = { store, variables, errors: [] };
  const { data, errors } = executeOperation(ctx, operation);
  if (errors.length > 0) return { data, errors };
  return { data };
}
