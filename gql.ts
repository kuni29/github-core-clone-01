// gql.ts: the GraphQL v4 surface. A small parser and executor covering the document shapes the
// suite sends (operations with variables, aliases, inline fragments and spreads, input objects,
// enums and lists, batched operations, introspection of the types the checks name, and the five
// mutations). It executes against the same store as REST and git, in forge.ts.

import {
  VIEWER,
  branchTip,
  createIssueRec,
  diffTrees,
  getRepo,
  listRepos,
  mergeBaseOid,
  mergePullRequest,
  newCommentId,
  pullMergeable,
  treeOfCommit,
  type IssueRec,
  type RepoRec,
} from './forge.ts';

// ---------------------------------------------------------------- global ids

export function globalId(kind: string, ...parts: Array<string | number>): string {
  return Buffer.from([kind, ...parts.map(String)].join(':'), 'utf8').toString('base64url');
}

export function decodeGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const parts = text.split(':');
    if (parts.length < 2) return null;
    return { kind: parts[0]!, parts: parts.slice(1) };
  } catch {
    return null;
  }
}

export function repoGlobalId(repo: RepoRec): string {
  return globalId('Repository', repo.id);
}

export function issueGlobalId(repo: RepoRec, issue: IssueRec): string {
  return globalId(issue.kind === 'pull' ? 'PullRequest' : 'Issue', repo.id, issue.number);
}

function repoById(id: number): RepoRec | null {
  for (const repo of listRepos()) if (repo.id === id) return repo;
  return null;
}

// ---------------------------------------------------------------- tokenizer

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'spread' }
  | { kind: 'eof' };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < source.length) {
    const c = source[i]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || c === '﻿') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (c === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread' });
      i += 3;
      continue;
    }
    if ('!$():=@[]{}|&'.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      if (source.slice(i, i + 3) === '"""') {
        const end = source.indexOf('"""', i + 3);
        const raw = end < 0 ? source.slice(i + 3) : source.slice(i + 3, end);
        tokens.push({ kind: 'string', value: raw });
        i = end < 0 ? source.length : end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\') {
          const esc = source[j + 1]!;
          if (esc === 'n') value += '\n';
          else if (esc === 't') value += '\t';
          else if (esc === 'r') value += '\r';
          else if (esc === 'b') value += '\b';
          else if (esc === 'f') value += '\f';
          else if (esc === '/') value += '/';
          else if (esc === '\\') value += '\\';
          else if (esc === '"') value += '"';
          else if (esc === 'u') {
            value += String.fromCharCode(parseInt(source.slice(j + 2, j + 6), 16));
            j += 4;
          } else value += esc;
          j += 2;
        } else {
          value += source[j]!;
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < source.length && isNameChar(source[j]!)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      while (j < source.length && /[0-9.eE+-]/.test(source[j]!)) j += 1;
      const text = source.slice(i, j);
      if (/[.eE]/.test(text)) tokens.push({ kind: 'float', value: parseFloat(text) });
      else tokens.push({ kind: 'int', value: parseInt(text, 10) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)} in GraphQL document`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

// ---------------------------------------------------------------- parser

type Value =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: Value[] }
  | { kind: 'object'; fields: Array<{ name: string; value: Value }> };

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: Value }>;
  selectionSet: SelectionNode[] | null;
}

type SelectionNode =
  | FieldNode
  | { kind: 'spread'; name: string }
  | { kind: 'inline'; typeCondition: string | null; selectionSet: SelectionNode[] };

interface OperationNode {
  operation: 'query' | 'mutation';
  name: string | null;
  variableDefaults: Map<string, Value>;
  selectionSet: SelectionNode[];
}

interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, { typeCondition: string | null; selectionSet: SelectionNode[] }>;
}

class Parser {
  private tokens: Token[];
  private pos = 0;

  constructor(source: string) {
    this.tokens = tokenize(source);
  }

  private peek(): Token {
    return this.tokens[this.pos]!;
  }

  private next(): Token {
    const token = this.tokens[this.pos]!;
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected '${value}' in GraphQL document`);
  }

  private atPunct(value: string): boolean {
    const token = this.peek();
    return token.kind === 'punct' && token.value === value;
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name in GraphQL document');
    return token.value;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, { typeCondition: string | null; selectionSet: SelectionNode[] }>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ operation: 'query', name: null, variableDefaults: new Map(), selectionSet: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription')) {
        this.next();
        const operation = token.value === 'mutation' ? 'mutation' : 'query';
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.expectName();
        const variableDefaults = new Map<string, Value>();
        if (this.atPunct('(')) {
          this.next();
          while (!this.atPunct(')')) {
            this.expectPunct('$');
            const varName = this.expectName();
            this.expectPunct(':');
            this.parseType();
            if (this.atPunct('=')) {
              this.next();
              variableDefaults.set(varName, this.parseValue());
            }
            if (this.atPunct('@')) this.parseDirectives();
          }
          this.next();
        }
        if (this.atPunct('@')) this.parseDirectives();
        operations.push({ operation, name, variableDefaults, selectionSet: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const fragName = this.expectName();
        const onToken = this.next();
        if (onToken.kind !== 'name' || onToken.value !== 'on') throw new Error('fragment without on');
        const typeCondition = this.expectName();
        if (this.atPunct('@')) this.parseDirectives();
        fragments.set(fragName, { typeCondition, selectionSet: this.parseSelectionSet() });
        continue;
      }
      throw new Error('unexpected token in GraphQL document');
    }
    return { operations, fragments };
  }

  private parseType(): void {
    if (this.atPunct('[')) {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.atPunct('!')) this.next();
  }

  private parseDirectives(): void {
    while (this.atPunct('@')) {
      this.next();
      this.expectName();
      if (this.atPunct('(')) {
        this.next();
        while (!this.atPunct(')')) {
          this.expectName();
          this.expectPunct(':');
          this.parseValue();
        }
        this.next();
      }
    }
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.atPunct('}')) {
      const token = this.peek();
      if (token.kind === 'spread') {
        this.next();
        if (this.peek().kind === 'name' && (this.peek() as { value: string }).value !== 'on') {
          const name = this.expectName();
          if (this.atPunct('@')) this.parseDirectives();
          selections.push({ kind: 'spread', name });
        } else {
          let typeCondition: string | null = null;
          if (this.peek().kind === 'name') {
            this.next(); // 'on'
            typeCondition = this.expectName();
          }
          if (this.atPunct('@')) this.parseDirectives();
          selections.push({ kind: 'inline', typeCondition, selectionSet: this.parseSelectionSet() });
        }
        continue;
      }
      const first = this.expectName();
      let alias: string | null = null;
      let name = first;
      if (this.atPunct(':')) {
        this.next();
        alias = first;
        name = this.expectName();
      }
      const args: Array<{ name: string; value: Value }> = [];
      if (this.atPunct('(')) {
        this.next();
        while (!this.atPunct(')')) {
          const argName = this.expectName();
          this.expectPunct(':');
          args.push({ name: argName, value: this.parseValue() });
        }
        this.next();
      }
      if (this.atPunct('@')) this.parseDirectives();
      let selectionSet: SelectionNode[] | null = null;
      if (this.atPunct('{')) selectionSet = this.parseSelectionSet();
      selections.push({ kind: 'field', alias, name, args, selectionSet });
    }
    this.next();
    return selections;
  }

  private parseValue(): Value {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'int') return { kind: 'int', value: token.value };
    if (token.kind === 'float') return { kind: 'float', value: token.value };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'punct' && token.value === '[') {
      const values: Value[] = [];
      while (!this.atPunct(']')) values.push(this.parseValue());
      this.next();
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: Value }> = [];
      while (!this.atPunct('}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.next();
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error('unexpected value in GraphQL document');
  }
}

// ---------------------------------------------------------------- execution

type GqlObject = { __typename: string; [key: string]: unknown };
type Resolver = (obj: GqlObject, args: Record<string, unknown>) => unknown;

class GqlFieldError extends Error {}

const userObject = (): GqlObject => ({ __typename: 'User' });
const repoObject = (repo: RepoRec): GqlObject => ({ __typename: 'Repository', repo });
const issueObject = (repo: RepoRec, issue: IssueRec): GqlObject => ({ __typename: 'Issue', repo, issue });
const pullObject = (repo: RepoRec, issue: IssueRec): GqlObject => ({ __typename: 'PullRequest', repo, issue });

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64url');
}

function numberFromCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match ? parseInt(match[1]!, 10) : null;
  } catch {
    return null;
  }
}

interface ConnectionSpec<T> {
  items: T[];
  wrap: (item: T) => GqlObject;
  numberOf: (item: T) => number;
  typeName: string;
  edgeTypeName: string;
}

function connection<T>(spec: ConnectionSpec<T>, args: Record<string, unknown>): GqlObject {
  const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : 100;
  let start = 0;
  const after = numberFromCursor(args.after);
  if (after !== null) {
    const index = spec.items.findIndex((item) => spec.numberOf(item) === after);
    if (index >= 0) start = index + 1;
  }
  const page = spec.items.slice(start, start + first);
  const nodes = page.map(spec.wrap);
  const edges = page.map((item) => ({ __typename: spec.edgeTypeName, node: spec.wrap(item), cursor: cursorFor(spec.numberOf(item)) }));
  return {
    __typename: spec.typeName,
    _nodes: nodes,
    _edges: edges,
    _pageInfo: {
      __typename: 'PageInfo',
      hasNextPage: start + page.length < spec.items.length,
      hasPreviousPage: start > 0,
      startCursor: page.length > 0 ? cursorFor(spec.numberOf(page[0]!)) : null,
      endCursor: page.length > 0 ? cursorFor(spec.numberOf(page[page.length - 1]!)) : null,
    },
    _totalCount: spec.items.length,
  };
}

function orderedIssues(repo: RepoRec, args: Record<string, unknown>): IssueRec[] {
  let items = [...repo.issues.values()].filter((issue) => issue.kind === 'issue');
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((s) => String(s).toLowerCase()));
    items = items.filter((issue) => wanted.has(issue.state));
  }
  const orderBy = (args.orderBy ?? null) as { direction?: string } | null;
  const direction = orderBy !== null && typeof orderBy === 'object' ? String(orderBy.direction ?? 'DESC').toUpperCase() : 'DESC';
  items.sort((a, b) => (direction === 'ASC' ? a.seq - b.seq || a.number - b.number : b.seq - a.seq || b.number - a.number));
  return items;
}

function orderedPulls(repo: RepoRec, args: Record<string, unknown>): IssueRec[] {
  let items = [...repo.issues.values()].filter((issue) => issue.kind === 'pull');
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((s) => String(s).toUpperCase()));
    items = items.filter((issue) => {
      const state = issue.merged ? 'MERGED' : issue.state.toUpperCase();
      return wanted.has(state) || (wanted.has('CLOSED') && issue.merged);
    });
  }
  items.sort((a, b) => b.seq - a.seq || b.number - a.number);
  return items;
}

function pullFiles(repo: RepoRec, issue: IssueRec): Array<{ path: string; additions: number; deletions: number }> {
  const baseTip = branchTip(repo, issue.baseRef);
  const headTip = branchTip(repo, issue.headRef);
  if (baseTip === null || headTip === null) return [];
  const base = mergeBaseOid(baseTip, headTip);
  const baseTree = base === null ? null : treeOfCommit(base);
  return diffTrees(baseTree, treeOfCommit(headTip)).map((diff) => ({ path: diff.filename, additions: diff.additions, deletions: diff.deletions }));
}

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', 'rateLimit'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['login', 'id', 'name', 'email', 'url'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'description', 'isPrivate', 'owner', 'defaultBranchRef',
    'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'url',
  ],
  Ref: ['name', 'prefix', 'target'],
  Commit: ['oid', 'message', 'tree'],
  Issue: ['id', 'number', 'title', 'state', 'body', 'author', 'url', 'repository'],
  PullRequest: [
    'id', 'number', 'title', 'state', 'body', 'merged', 'mergeable', 'headRefName', 'baseRefName',
    'files', 'author', 'url', 'repository', 'mergeCommit',
  ],
  PullRequestChangedFile: ['path', 'additions', 'deletions'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PullRequestEdge: ['node', 'cursor'],
  PullRequestChangedFileEdge: ['node', 'cursor'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  IssueComment: ['id', 'body', 'author'],
  IssueCommentEdge: ['node', 'cursor'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues', 'possibleTypes', 'inputFields', 'ofType', 'interfaces'],
  __Field: ['name', 'description', 'args', 'type', 'isDeprecated', 'deprecationReason'],
  __EnumValue: ['name', 'description', 'isDeprecated', 'deprecationReason'],
  __InputValue: ['name', 'description', 'type', 'defaultValue'],
};

const ENUM_TYPES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  PullRequestOrderField: ['CREATED_AT', 'UPDATED_AT'],
  MergePullRequestMethod: ['MERGE', 'SQUASH', 'REBASE'],
};

function typeObject(name: string): GqlObject | null {
  if (Object.prototype.hasOwnProperty.call(ENUM_TYPES, name)) {
    return { __typename: '__Type', _name: name, _kind: 'ENUM', _fields: null, _enums: ENUM_TYPES[name]! };
  }
  if (Object.prototype.hasOwnProperty.call(TYPE_FIELDS, name)) {
    return { __typename: '__Type', _name: name, _kind: 'OBJECT', _fields: TYPE_FIELDS[name]!, _enums: null };
  }
  return null;
}

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: () => userObject(),
    repository: (_obj, args) => {
      if (String(args.owner ?? '') !== VIEWER.login) return null;
      const repo = getRepo(String(args.name ?? ''));
      return repo === undefined ? null : repoObject(repo);
    },
    node: (_obj, args) => {
      const decoded = decodeGlobalId(String(args.id ?? ''));
      if (decoded === null) return null;
      if (decoded.kind === 'Repository') {
        const repo = repoById(parseInt(decoded.parts[0]!, 10));
        return repo === null ? null : repoObject(repo);
      }
      if (decoded.kind === 'Issue' || decoded.kind === 'PullRequest') {
        const repo = repoById(parseInt(decoded.parts[0]!, 10));
        if (repo === null) return null;
        const issue = repo.issues.get(parseInt(decoded.parts[1]!, 10));
        if (issue === undefined) return null;
        return issue.kind === 'pull' ? pullObject(repo, issue) : issueObject(repo, issue);
      }
      if (decoded.kind === 'User') return userObject();
      return null;
    },
    rateLimit: () => ({ __typename: 'RateLimit', limit: 5000, cost: 1, remaining: 5000, resetAt: '2025-01-01T00:00:00Z' }),
  },
  Mutation: {
    createIssue: (_obj, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
      const repo = decoded !== null && decoded.kind === 'Repository' ? repoById(parseInt(decoded.parts[0]!, 10)) : null;
      if (repo === null) throw new GqlFieldError('repository not found for createIssue');
      const issue = createIssueRec(repo, { kind: 'issue', title: String(input.title ?? ''), body: String(input.body ?? '') });
      return { __typename: 'CreateIssuePayload', issue: issueObject(repo, issue), clientMutationId: input.clientMutationId ?? null };
    },
    closeIssue: (_obj, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(String(input.issueId ?? ''));
      const repo = decoded !== null ? repoById(parseInt(decoded.parts[0]!, 10)) : null;
      const issue = repo !== null && decoded !== null ? repo.issues.get(parseInt(decoded.parts[1]!, 10)) : undefined;
      if (repo === null || issue === undefined) throw new GqlFieldError('issue not found for closeIssue');
      issue.state = 'closed';
      issue.rev += 1;
      return { __typename: 'CloseIssuePayload', issue: issueObject(repo, issue), clientMutationId: input.clientMutationId ?? null };
    },
    createPullRequest: (_obj, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
      const repo = decoded !== null && decoded.kind === 'Repository' ? repoById(parseInt(decoded.parts[0]!, 10)) : null;
      if (repo === null) throw new GqlFieldError('repository not found for createPullRequest');
      const headRef = String(input.headRefName ?? '');
      const baseRef = String(input.baseRefName ?? '');
      if (branchTip(repo, headRef) === null || branchTip(repo, baseRef) === null) {
        throw new GqlFieldError(`head or base branch not found for createPullRequest (${baseRef} <- ${headRef})`);
      }
      const pull = createIssueRec(repo, {
        kind: 'pull',
        title: String(input.title ?? ''),
        body: String(input.body ?? ''),
        headRef,
        baseRef,
      });
      return { __typename: 'CreatePullRequestPayload', pullRequest: pullObject(repo, pull), clientMutationId: input.clientMutationId ?? null };
    },
    mergePullRequest: (_obj, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(String(input.pullRequestId ?? ''));
      const repo = decoded !== null ? repoById(parseInt(decoded.parts[0]!, 10)) : null;
      const issue = repo !== null && decoded !== null ? repo.issues.get(parseInt(decoded.parts[1]!, 10)) : undefined;
      if (repo === null || issue === undefined || issue.kind !== 'pull') throw new GqlFieldError('pull request not found for mergePullRequest');
      if (!issue.merged) {
        const outcome = mergePullRequest(repo, issue);
        if (!outcome.ok) throw new GqlFieldError(`pull request ${issue.number} cannot be merged (${outcome.reason})`);
      }
      return { __typename: 'MergePullRequestPayload', pullRequest: pullObject(repo, issue), clientMutationId: input.clientMutationId ?? null };
    },
    addComment: (_obj, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(String(input.subjectId ?? ''));
      const repo = decoded !== null ? repoById(parseInt(decoded.parts[0]!, 10)) : null;
      const issue = repo !== null && decoded !== null ? repo.issues.get(parseInt(decoded.parts[1]!, 10)) : undefined;
      if (repo === null || issue === undefined) throw new GqlFieldError('subject not found for addComment');
      const comment = { id: newCommentId(), body: String(input.body ?? '') };
      issue.comments.push(comment);
      issue.rev += 1;
      const node: GqlObject = { __typename: 'IssueComment', repo, issue, comment };
      return {
        __typename: 'AddCommentPayload',
        commentEdge: { __typename: 'IssueCommentEdge', node, cursor: globalId('Comment', repo.id, issue.number, comment.id) },
        clientMutationId: input.clientMutationId ?? null,
      };
    },
  },
  User: {
    login: () => VIEWER.login,
    id: () => globalId('User', VIEWER.id),
    name: () => VIEWER.name,
    email: () => VIEWER.email,
    url: () => `https://github.example/${VIEWER.login}`,
  },
  Repository: {
    id: (obj) => repoGlobalId(obj.repo as RepoRec),
    databaseId: (obj) => (obj.repo as RepoRec).id,
    name: (obj) => (obj.repo as RepoRec).name,
    nameWithOwner: (obj) => `${VIEWER.login}/${(obj.repo as RepoRec).name}`,
    description: (obj) => (obj.repo as RepoRec).description,
    isPrivate: (obj) => (obj.repo as RepoRec).isPrivate,
    owner: () => userObject(),
    defaultBranchRef: (obj) => {
      const repo = obj.repo as RepoRec;
      const tip = branchTip(repo, repo.defaultBranch);
      if (tip === null) return null;
      return { __typename: 'Ref', repo, name: repo.defaultBranch, target: tip };
    },
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    url: (obj) => `https://github.example/${VIEWER.login}/${(obj.repo as RepoRec).name}`,
    issue: (obj, args) => {
      const repo = obj.repo as RepoRec;
      const issue = repo.issues.get(Number(args.number));
      if (issue === undefined || issue.kind !== 'issue') return null;
      return issueObject(repo, issue);
    },
    issues: (obj, args) => {
      const repo = obj.repo as RepoRec;
      return connection({
        items: orderedIssues(repo, args),
        wrap: (issue) => issueObject(repo, issue),
        numberOf: (issue) => issue.number,
        typeName: 'IssueConnection',
        edgeTypeName: 'IssueEdge',
      }, args);
    },
    pullRequest: (obj, args) => {
      const repo = obj.repo as RepoRec;
      const issue = repo.issues.get(Number(args.number));
      if (issue === undefined || issue.kind !== 'pull') return null;
      return pullObject(repo, issue);
    },
    pullRequests: (obj, args) => {
      const repo = obj.repo as RepoRec;
      return connection({
        items: orderedPulls(repo, args),
        wrap: (issue) => pullObject(repo, issue),
        numberOf: (issue) => issue.number,
        typeName: 'PullRequestConnection',
        edgeTypeName: 'PullRequestEdge',
      }, args);
    },
  },
  Ref: {
    name: (obj) => obj.name as string,
    prefix: () => 'refs/heads/',
    target: (obj) => ({ __typename: 'Commit', oid: obj.target as string }),
  },
  Commit: {
    oid: (obj) => obj.oid as string,
    message: () => '',
    tree: () => null,
  },
  Issue: {
    id: (obj) => issueGlobalId(obj.repo as RepoRec, obj.issue as IssueRec),
    number: (obj) => (obj.issue as IssueRec).number,
    title: (obj) => (obj.issue as IssueRec).title,
    state: (obj) => ((obj.issue as IssueRec).state === 'open' ? 'OPEN' : 'CLOSED'),
    body: (obj) => (obj.issue as IssueRec).body,
    author: () => userObject(),
    url: (obj) => `https://github.example/${VIEWER.login}/${(obj.repo as RepoRec).name}/issues/${(obj.issue as IssueRec).number}`,
    repository: (obj) => repoObject(obj.repo as RepoRec),
  },
  PullRequest: {
    id: (obj) => issueGlobalId(obj.repo as RepoRec, obj.issue as IssueRec),
    number: (obj) => (obj.issue as IssueRec).number,
    title: (obj) => (obj.issue as IssueRec).title,
    state: (obj) => {
      const issue = obj.issue as IssueRec;
      return issue.merged ? 'MERGED' : issue.state === 'open' ? 'OPEN' : 'CLOSED';
    },
    body: (obj) => (obj.issue as IssueRec).body,
    merged: (obj) => (obj.issue as IssueRec).merged,
    mergeable: (obj) => pullMergeable(obj.repo as RepoRec, obj.issue as IssueRec),
    headRefName: (obj) => (obj.issue as IssueRec).headRef,
    baseRefName: (obj) => (obj.issue as IssueRec).baseRef,
    author: () => userObject(),
    url: (obj) => `https://github.example/${VIEWER.login}/${(obj.repo as RepoRec).name}/pull/${(obj.issue as IssueRec).number}`,
    repository: (obj) => repoObject(obj.repo as RepoRec),
    mergeCommit: (obj) => {
      const issue = obj.issue as IssueRec;
      return issue.mergeCommitSha === null ? null : { __typename: 'Commit', oid: issue.mergeCommitSha };
    },
    files: (obj, args) => {
      const repo = obj.repo as RepoRec;
      const issue = obj.issue as IssueRec;
      const files = pullFiles(repo, issue);
      return connection({
        items: files.map((file, index) => ({ ...file, index })),
        wrap: (file) => ({ __typename: 'PullRequestChangedFile', path: file.path, additions: file.additions, deletions: file.deletions }),
        numberOf: (file) => file.index + 1,
        typeName: 'PullRequestChangedFileConnection',
        edgeTypeName: 'PullRequestChangedFileEdge',
      }, args);
    },
  },
  PullRequestChangedFile: {
    path: (obj) => obj.path as string,
    additions: (obj) => obj.additions as number,
    deletions: (obj) => obj.deletions as number,
  },
  IssueConnection: connectionResolvers(),
  PullRequestConnection: connectionResolvers(),
  PullRequestChangedFileConnection: connectionResolvers(),
  IssueEdge: edgeResolvers(),
  PullRequestEdge: edgeResolvers(),
  PullRequestChangedFileEdge: edgeResolvers(),
  PageInfo: {
    hasNextPage: (obj) => obj.hasNextPage as boolean,
    hasPreviousPage: (obj) => obj.hasPreviousPage as boolean,
    startCursor: (obj) => obj.startCursor as string | null,
    endCursor: (obj) => obj.endCursor as string | null,
  },
  IssueComment: {
    id: (obj) => {
      const repo = obj.repo as RepoRec;
      const issue = obj.issue as IssueRec;
      const comment = obj.comment as { id: number; body: string };
      return globalId('Comment', repo.id, issue.number, comment.id);
    },
    body: (obj) => (obj.comment as { body: string }).body,
    author: () => userObject(),
  },
  IssueCommentEdge: {
    node: (obj) => obj.node as GqlObject,
    cursor: (obj) => obj.cursor as string,
  },
  CreateIssuePayload: {
    issue: (obj) => obj.issue as GqlObject,
    clientMutationId: (obj) => obj.clientMutationId as string | null,
  },
  CloseIssuePayload: {
    issue: (obj) => obj.issue as GqlObject,
    clientMutationId: (obj) => obj.clientMutationId as string | null,
  },
  CreatePullRequestPayload: {
    pullRequest: (obj) => obj.pullRequest as GqlObject,
    clientMutationId: (obj) => obj.clientMutationId as string | null,
  },
  MergePullRequestPayload: {
    pullRequest: (obj) => obj.pullRequest as GqlObject,
    clientMutationId: (obj) => obj.clientMutationId as string | null,
  },
  AddCommentPayload: {
    commentEdge: (obj) => obj.commentEdge as GqlObject,
    clientMutationId: (obj) => obj.clientMutationId as string | null,
  },
  __Type: {
    name: (obj) => obj._name as string,
    kind: (obj) => obj._kind as string,
    description: () => null,
    fields: (obj) => {
      const fields = obj._fields as string[] | null;
      if (fields === null) return null;
      return fields.map((name) => ({
        __typename: '__Field',
        name,
        description: null,
        args: [],
        type: { __typename: '__Type', _name: 'String', _kind: 'SCALAR', _fields: null, _enums: null },
        isDeprecated: false,
        deprecationReason: null,
      }));
    },
    enumValues: (obj) => {
      const values = obj._enums as string[] | null;
      if (values === null) return null;
      return values.map((name) => ({ __typename: '__EnumValue', name, description: null, isDeprecated: false, deprecationReason: null }));
    },
    possibleTypes: () => null,
    inputFields: () => null,
    ofType: () => null,
    interfaces: () => [],
  },
  __Field: {
    name: (obj) => obj.name as string,
    description: () => null,
    args: () => [],
    type: (obj) => obj.type as GqlObject,
    isDeprecated: () => false,
    deprecationReason: () => null,
  },
  __EnumValue: {
    name: (obj) => obj.name as string,
    description: () => null,
    isDeprecated: () => false,
    deprecationReason: () => null,
  },
  RateLimit: {
    limit: (obj) => obj.limit as number,
    cost: (obj) => obj.cost as number,
    remaining: (obj) => obj.remaining as number,
    resetAt: (obj) => obj.resetAt as string,
  },
};

function connectionResolvers(): Record<string, Resolver> {
  return {
    nodes: (obj) => obj._nodes as GqlObject[],
    edges: (obj) => obj._edges as GqlObject[],
    pageInfo: (obj) => obj._pageInfo as GqlObject,
    totalCount: (obj) => obj._totalCount as number,
  };
}

function edgeResolvers(): Record<string, Resolver> {
  return {
    node: (obj) => obj.node as GqlObject,
    cursor: (obj) => obj.cursor as string,
  };
}

// RateLimit is introspectable through Query.rateLimit; register its fields for the unknown-field rule.
TYPE_FIELDS.RateLimit = ['limit', 'cost', 'remaining', 'resetAt', 'used', 'nodeCount'];

interface ExecContext {
  variables: Record<string, unknown>;
  fragments: Map<string, { typeCondition: string | null; selectionSet: SelectionNode[] }>;
  errors: Array<{ message: string }>;
}

function resolveValue(value: Value, ctx: ExecContext): unknown {
  switch (value.kind) {
    case 'variable':
      return ctx.variables[value.name] ?? null;
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
    case 'enum':
      return value.value;
    case 'null':
      return null;
    case 'list':
      return value.values.map((entry) => resolveValue(entry, ctx));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of value.fields) out[field.name] = resolveValue(field.value, ctx);
      return out;
    }
  }
}

function executeSelectionSet(typeName: string, obj: GqlObject, selections: SelectionNode[], ctx: ExecContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'spread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment !== undefined && (fragment.typeCondition === null || fragment.typeCondition === typeName)) {
        Object.assign(out, executeSelectionSet(typeName, obj, fragment.selectionSet, ctx));
      }
      continue;
    }
    if (selection.kind === 'inline') {
      if (selection.typeCondition === null || selection.typeCondition === typeName) {
        Object.assign(out, executeSelectionSet(typeName, obj, selection.selectionSet, ctx));
      }
      continue;
    }
    const key = selection.alias ?? selection.name;
    if (selection.name === '__typename') {
      out[key] = typeName;
      continue;
    }
    if (selection.name === '__type' && typeName === 'Query') {
      const args = argsOf(selection, ctx);
      const found = typeObject(String(args.name ?? ''));
      out[key] = found === null ? null : completeValue(found, selection, ctx);
      continue;
    }
    if (selection.name === '__schema' && typeName === 'Query') {
      out[key] = null;
      continue;
    }
    const fields = TYPE_FIELDS[typeName];
    const resolver = RESOLVERS[typeName]?.[selection.name];
    if (fields === undefined || !fields.includes(selection.name) || resolver === undefined) {
      ctx.errors.push({ message: `Field '${selection.name}' doesn't exist on type '${typeName}'` });
      out[key] = null;
      continue;
    }
    let value: unknown;
    try {
      value = resolver(obj, argsOf(selection, ctx));
    } catch (error) {
      if (error instanceof GqlFieldError) {
        ctx.errors.push({ message: error.message });
        out[key] = null;
        continue;
      }
      throw error;
    }
    out[key] = completeValue(value, selection, ctx);
  }
  return out;
}

function argsOf(field: FieldNode, ctx: ExecContext): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const arg of field.args) args[arg.name] = resolveValue(arg.value, ctx);
  return args;
}

function completeValue(value: unknown, field: FieldNode, ctx: ExecContext): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((entry) => completeValue(entry, field, ctx));
  if (typeof value === 'object') {
    const gqlObj = value as GqlObject;
    if (typeof gqlObj.__typename === 'string') {
      if (field.selectionSet === null) return {};
      return executeSelectionSet(gqlObj.__typename, gqlObj, field.selectionSet, ctx);
    }
    return value;
  }
  return value;
}

/** Execute one operation document (already JSON-decoded) and return the GraphQL response body. */
export function executeGraphQL(body: { query?: unknown; variables?: unknown; operationName?: unknown }): Record<string, unknown> {
  const query = typeof body.query === 'string' ? body.query : '';
  let document: DocumentNode;
  try {
    document = new Parser(query).parseDocument();
  } catch (error) {
    return { errors: [{ message: error instanceof Error ? error.message : String(error) }] };
  }
  if (document.operations.length === 0) return { errors: [{ message: 'no operation in document' }] };
  let operation = document.operations[0]!;
  if (typeof body.operationName === 'string' && body.operationName !== '') {
    const named = document.operations.find((op) => op.name === body.operationName);
    if (named !== undefined) operation = named;
  }
  const variables: Record<string, unknown> = {};
  for (const [name, value] of operation.variableDefaults) {
    const ctxless: ExecContext = { variables: {}, fragments: document.fragments, errors: [] };
    variables[name] = resolveValue(value, ctxless);
  }
  if (typeof body.variables === 'object' && body.variables !== null && !Array.isArray(body.variables)) {
    Object.assign(variables, body.variables as Record<string, unknown>);
  }
  const ctx: ExecContext = { variables, fragments: document.fragments, errors: [] };
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelectionSet(rootType, { __typename: rootType }, operation.selectionSet, ctx);
  const payload: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) payload.errors = ctx.errors;
  return payload;
}

/** A GraphQL request body may be one operation or a batch (an array): answer in order. */
export function handleGraphQLBody(body: unknown): unknown {
  if (Array.isArray(body)) {
    return body.map((entry) => executeGraphQL((entry ?? {}) as { query?: unknown; variables?: unknown; operationName?: unknown }));
  }
  return executeGraphQL((body ?? {}) as { query?: unknown; variables?: unknown; operationName?: unknown });
}
