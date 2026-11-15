// graphql.ts -- GitHub GraphQL v4 module for the github-core-clone-01 entry.
//
// One dispatch function: dispatchGraphQL(store, method, segments, query, auth, rawBody)
//   Same shape as dispatchRest (see rest.ts): the store is passed in, segments are
//   the path parts after /api/graphql (normally []), query is the parsed query
//   object, auth the raw Authorization header, rawBody the raw request body text.
// Returns { status, headers, body }.
//
// Implements exactly the documents gh and github-mcp-server send (see
// kit/sdk/conformance/checks-graphql.ts): viewer, repository (+ issues / pull
// requests / issue / pullRequest), node(id:), __type introspection, the
// create/close/merge/addComment mutations, cursor pagination on issues, and
// GitHub's operation batching (a JSON array of operations in one body).
// Unknown fields and malformed documents answer HTTP 200 with an errors array;
// an unknown repository answers data.repository = null with no errors; a
// request without a valid token is 401 with a JSON message body.
// Global ids are opaque base64 of "Kind:ref" and stable across reads.
//
// Node 22, TypeScript with type stripping, node built-ins only, no dependencies.

import {
  adaptStore, callOp, hasOp, getRepoRaw, normRepo, normIssue, normPull,
  resolveRefOp, readCommitOp, listBranchesOp, listPullFilesOp, pullConflicts, getPullOp,
  listPullsOp, createPullOp, createIssueOp, mergePullOp, putFileOp, mergeableOf,
  VIEWER, FIXED_DATE, globalId, decodeGlobalId, stableId, isViewer,
  jsonResp, errResp,
} from './rest.ts';

// -------------------------------------------------------------------------------------------
// Schema tables: field sets for validation and __type introspection.
// -------------------------------------------------------------------------------------------

const SCHEMA_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', 'search', '__type', '__schema'],
  User: ['login', 'id', 'name', 'email', 'databaseId', 'avatarUrl', 'url', 'createdAt', 'updatedAt'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'description', 'visibility', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'url', 'createdAt', 'updatedAt'],
  Ref: ['name', 'prefix', 'target'],
  GitObject: ['oid', 'abbreviatedOid'],
  Issue: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'author', 'createdAt', 'updatedAt', 'url', 'closedAt', 'comments'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PullRequest: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'files', 'author', 'createdAt', 'updatedAt', 'mergedAt', 'url'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestEdge: ['node', 'cursor'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFileEdge: ['node', 'cursor'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  Node: ['id'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues', 'inputFields', 'interfaces', 'possibleTypes'],
  __Field: ['name', 'description', 'args', 'type'],
  __EnumValue: ['name', 'description'],
  __InputValue: ['name', 'description', 'type', 'defaultValue'],
  __Schema: ['types', 'queryType', 'mutationType', 'description'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId'],
  IssueComment: ['id', 'body', 'author', 'createdAt', 'updatedAt'],
  IssueCommentEdge: ['node', 'cursor'],
  SearchResultConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  SearchResultEdge: ['node', 'cursor'],
};

const FIELD_TYPE: Record<string, Record<string, string>> = {
  Query: { viewer: 'User', repository: 'Repository', node: 'Node', search: 'SearchResultConnection', __type: '__Type', __schema: '__Schema' },
  Repository: { owner: 'User', defaultBranchRef: 'Ref', issue: 'Issue', issues: 'IssueConnection', pullRequest: 'PullRequest', pullRequests: 'PullRequestConnection' },
  Ref: { target: 'GitObject' },
  Issue: { author: 'User' },
  IssueConnection: { nodes: 'Issue', edges: 'IssueEdge', pageInfo: 'PageInfo' },
  IssueEdge: { node: 'Issue' },
  PullRequest: { author: 'User', files: 'PullRequestChangedFileConnection' },
  PullRequestConnection: { nodes: 'PullRequest', edges: 'PullRequestEdge', pageInfo: 'PageInfo' },
  PullRequestEdge: { node: 'PullRequest' },
  PullRequestChangedFileConnection: { nodes: 'PullRequestChangedFile', edges: 'PullRequestChangedFileEdge', pageInfo: 'PageInfo' },
  PullRequestChangedFileEdge: { node: 'PullRequestChangedFile' },
  __Type: { fields: '__Field', enumValues: '__EnumValue' },
  Mutation: { createIssue: 'CreateIssuePayload', closeIssue: 'CloseIssuePayload', createPullRequest: 'CreatePullRequestPayload', mergePullRequest: 'MergePullRequestPayload', addComment: 'AddCommentPayload' },
  CreateIssuePayload: { issue: 'Issue' },
  CloseIssuePayload: { issue: 'Issue' },
  CreatePullRequestPayload: { pullRequest: 'PullRequest' },
  MergePullRequestPayload: { pullRequest: 'PullRequest' },
  AddCommentPayload: { commentEdge: 'IssueCommentEdge' },
  IssueCommentEdge: { node: 'IssueComment' },
  IssueComment: { author: 'User' },
  SearchResultConnection: { nodes: 'Node', edges: 'SearchResultEdge', pageInfo: 'PageInfo' },
  SearchResultEdge: { node: 'Node' },
};

const TYPE_INFO: Record<string, { kind: string; fields?: string[]; enumValues?: string[] }> = {
  Issue: { kind: 'OBJECT', fields: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'author', 'createdAt', 'updatedAt', 'url', 'closedAt', 'comments', 'labels', 'authorAssociation'] },
  PullRequest: { kind: 'OBJECT', fields: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'files', 'author', 'createdAt', 'updatedAt', 'mergedAt', 'url'] },
  Repository: { kind: 'OBJECT', fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'description', 'visibility', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'url', 'createdAt', 'updatedAt'] },
  User: { kind: 'OBJECT', fields: ['login', 'id', 'name', 'email', 'databaseId', 'avatarUrl', 'url', 'createdAt', 'updatedAt'] },
  SearchType: { kind: 'ENUM', enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'MILESTONE', 'PROJECT'] },
  IssueState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  RepositoryPermission: { kind: 'ENUM', enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
  IssueOrderField: { kind: 'ENUM', enumValues: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  OrderDirection: { kind: 'ENUM', enumValues: ['ASC', 'DESC'] },
  PullRequestMergeMethod: { kind: 'ENUM', enumValues: ['MERGE', 'SQUASH', 'REBASE'] },
};

// -------------------------------------------------------------------------------------------
// A small GraphQL document parser (the subset gh and github-mcp-server send).
// -------------------------------------------------------------------------------------------

type Token = { kind: string; value: string };

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i] ?? '';
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '﻿') { i += 1; continue; }
    if (ch === '#') { while (i < src.length && src[i] !== '\n') i += 1; continue; }
    if (ch === '.' && src.slice(i, i + 3) === '...') { tokens.push({ kind: '...', value: '...' }); i += 3; continue; }
    if ('{}():[]!=$@'.includes(ch)) { tokens.push({ kind: ch, value: ch }); i += 1; continue; }
    if (ch === '"') {
      if (src.slice(i, i + 3) === '"""') {
        const end = src.indexOf('"""', i + 3);
        const text = end === -1 ? src.slice(i + 3) : src.slice(i + 3, end);
        tokens.push({ kind: 'String', value: text });
        i = end === -1 ? src.length : end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const esc = src[j + 1];
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else if (esc === 'u' && /^[0-9a-fA-F]{4}$/.test(src.slice(j + 2, j + 6))) { out += String.fromCharCode(parseInt(src.slice(j + 2, j + 6), 16)); j += 4; }
          else out += esc ?? '';
          j += 2;
        } else {
          out += src[j] ?? '';
          j += 1;
        }
      }
      tokens.push({ kind: 'String', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      if (src[j] === '-') j += 1;
      while (j < src.length && /[0-9]/.test(src[j] ?? '')) j += 1;
      let isFloat = false;
      if (src[j] === '.' && /[0-9]/.test(src[j + 1] ?? '')) {
        isFloat = true;
        j += 1;
        while (j < src.length && /[0-9]/.test(src[j] ?? '')) j += 1;
      }
      if (src[j] === 'e' || src[j] === 'E') {
        isFloat = true;
        j += 1;
        if (src[j] === '+' || src[j] === '-') j += 1;
        while (j < src.length && /[0-9]/.test(src[j] ?? '')) j += 1;
      }
      tokens.push({ kind: isFloat ? 'Float' : 'Int', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < src.length && /[_A-Za-z0-9]/.test(src[j] ?? '')) j += 1;
      tokens.push({ kind: 'Name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`Syntax Error: Unexpected character: ${ch}.`);
  }
  tokens.push({ kind: 'EOF', value: '' });
  return tokens;
}

interface Selection {
  kind: 'field' | 'fragment';
  alias?: string;
  name?: string;
  args?: Record<string, any>;
  selections?: Selection[];
  typeCondition?: string;
}

interface Operation {
  type: string;
  name?: string;
  varDefs?: Record<string, any>;
  selections: Selection[];
}

class Parser {
  tokens: Token[];
  pos: number;
  constructor(tokens: Token[]) { this.tokens = tokens; this.pos = 0; }
  peek(): Token { return this.tokens[this.pos] ?? { kind: 'EOF', value: '' }; }
  next(): Token { const t = this.peek(); this.pos += 1; return t; }
  expect(kind: string): Token {
    const t = this.next();
    if (t.kind !== kind) throw new Error(`Syntax Error: Expected "${kind}", found "${t.kind}" (${t.value}).`);
    return t;
  }
  expectName(value?: string): string {
    const t = this.next();
    if (t.kind !== 'Name') throw new Error(`Syntax Error: Expected Name, found "${t.kind}".`);
    if (value !== undefined && t.value !== value) throw new Error(`Syntax Error: Expected "${value}", found "${t.value}".`);
    return t.value;
  }
  skipIgnored(): void { /* the tokenizer already dropped whitespace and comments */ }

  parseDocument(): { operations: Operation[] } {
    const operations: Operation[] = [];
    while (this.peek().kind !== 'EOF') {
      const t = this.peek();
      if (t.kind === '{') {
        operations.push({ type: 'query', selections: this.parseSelectionSet() });
      } else if (t.kind === 'Name' && (t.value === 'query' || t.value === 'mutation' || t.value === 'subscription')) {
        const type = this.next().value;
        let name: string | undefined;
        if (this.peek().kind === 'Name') name = this.next().value;
        let varDefs: Record<string, any> | undefined;
        if (this.peek().kind === '(') varDefs = this.parseVarDefs();
        operations.push({ type, name, varDefs, selections: this.parseSelectionSet() });
      } else if (t.kind === 'Name' && t.value === 'fragment') {
        // Named fragments are not sent by the checks; skip the definition.
        this.next();
        this.expectName();
        if (this.peek().value === 'on') this.next();
        this.expectName();
        this.parseSelectionSet();
      } else {
        throw new Error(`Syntax Error: Unexpected ${t.kind} "${t.value}".`);
      }
    }
    if (operations.length === 0) throw new Error('Syntax Error: Expected an operation.');
    return { operations };
  }

  parseVarDefs(): Record<string, any> {
    const defs: Record<string, any> = {};
    this.expect('(');
    while (this.peek().kind !== ')') {
      this.expect('$');
      const name = this.expectName();
      this.expect(':');
      this.parseType();
      if (this.peek().kind === '=') { this.next(); this.parseValue(true); }
      defs[name] = true;
    }
    this.expect(')');
    return defs;
  }

  parseType(): void {
    if (this.peek().kind === '[') {
      this.next();
      this.parseType();
      this.expect(']');
    } else {
      this.expectName();
    }
    if (this.peek().kind === '!') this.next();
  }

  parseSelectionSet(): Selection[] {
    this.expect('{');
    const sels: Selection[] = [];
    while (this.peek().kind !== '}') {
      if (this.peek().kind === 'EOF') throw new Error('Syntax Error: Unterminated selection set.');
      sels.push(this.parseSelection());
    }
    this.expect('}');
    return sels;
  }

  parseSelection(): Selection {
    if (this.peek().kind === '...') {
      this.next();
      if (this.peek().kind === 'Name' && this.peek().value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        return { kind: 'fragment', typeCondition, selections: this.parseSelectionSet() };
      }
      // A named fragment spread: parse and drop it (not sent by the checks).
      this.expectName();
      return { kind: 'fragment', selections: [] };
    }
    let alias: string | undefined;
    let name = this.expectName();
    if (this.peek().kind === ':') {
      this.next();
      alias = name;
      name = this.expectName();
    }
    let args: Record<string, any> | undefined;
    if (this.peek().kind === '(') args = this.parseArguments();
    // Directives (@...) are not sent by the checks; skip them if present.
    while (this.peek().kind === '@') {
      this.next();
      this.expectName();
      if (this.peek().kind === '(') this.parseArguments();
    }
    let selections: Selection[] | undefined;
    if (this.peek().kind === '{') selections = this.parseSelectionSet();
    return { kind: 'field', alias, name, args, selections };
  }

  parseArguments(): Record<string, any> {
    const args: Record<string, any> = {};
    this.expect('(');
    while (this.peek().kind !== ')') {
      const name = this.expectName();
      this.expect(':');
      args[name] = this.parseValue(false);
    }
    this.expect(')');
    return args;
  }

  parseValue(isConst: boolean): any {
    const t = this.peek();
    if (t.kind === '$') {
      if (isConst) throw new Error('Syntax Error: Variable in constant position.');
      this.next();
      return { __var: this.expectName() };
    }
    if (t.kind === 'Int') { this.next(); return parseInt(t.value, 10); }
    if (t.kind === 'Float') { this.next(); return parseFloat(t.value); }
    if (t.kind === 'String') { this.next(); return t.value; }
    if (t.kind === 'Name') {
      this.next();
      if (t.value === 'true') return true;
      if (t.value === 'false') return false;
      if (t.value === 'null') return null;
      return { __enum: t.value };
    }
    if (t.kind === '[') {
      this.next();
      const list: any[] = [];
      while (this.peek().kind !== ']') list.push(this.parseValue(isConst));
      this.expect(']');
      return list;
    }
    if (t.kind === '{') {
      this.next();
      const obj: Record<string, any> = {};
      while (this.peek().kind !== '}') {
        const name = this.expectName();
        this.expect(':');
        obj[name] = this.parseValue(isConst);
      }
      this.expect('}');
      return obj;
    }
    throw new Error(`Syntax Error: Unexpected ${t.kind} "${t.value}".`);
  }
}

export function parseDocument(src: string): { operations: Operation[] } {
  return new Parser(tokenize(src)).parseDocument();
}

/** Resolve variables, enums and nested values in a parsed argument value. */
export function resolveValue(value: any, variables: Record<string, any>): any {
  if (value !== null && typeof value === 'object') {
    if (typeof value.__var === 'string') return variables[value.__var];
    if (typeof value.__enum === 'string') return value.__enum;
    if (Array.isArray(value)) return value.map((v) => resolveValue(v, variables));
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(value)) out[k] = resolveValue(v, variables);
    return out;
  }
  return value;
}

export function resolveArgs(args: Record<string, any> | undefined, variables: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  if (!args) return out;
  for (const [k, v] of Object.entries(args)) out[k] = resolveValue(v, variables);
  return out;
}

// -------------------------------------------------------------------------------------------
// Validation: unknown fields (and unknown fragment types) become GraphQL errors.
// -------------------------------------------------------------------------------------------

export function validateSelections(type: string, selections: Selection[], errors: { message: string }[]): void {
  const fields = SCHEMA_FIELDS[type];
  if (!fields) {
    errors.push({ message: `Unknown type "${type}".` });
    return;
  }
  for (const sel of selections) {
    if (sel.kind === 'fragment') {
      if (sel.typeCondition) {
        if (!SCHEMA_FIELDS[sel.typeCondition]) {
          errors.push({ message: `Unknown type "${sel.typeCondition}".` });
          continue;
        }
        validateSelections(sel.typeCondition, sel.selections ?? [], errors);
      }
      continue;
    }
    const name = sel.name ?? '';
    if (name === '__typename') {
      if (sel.selections) validateSelections(type, sel.selections, errors);
      continue;
    }
    if (!fields.includes(name)) {
      errors.push({ message: `Cannot query field "${name}" on type "${type}".` });
      continue;
    }
    const childType = (FIELD_TYPE[type] ?? {})[name];
    if (childType && sel.selections) validateSelections(childType, sel.selections, errors);
    else if (sel.selections) {
      // A sub-selection on a scalar: GraphQL would reject it; report it the same way.
      errors.push({ message: `Field "${name}" of type "${type}" must not have a sub selection.` });
    }
  }
}

// -------------------------------------------------------------------------------------------
// Node builders and resolvers.
// -------------------------------------------------------------------------------------------

interface Ctx {
  a: ReturnType<typeof adaptStore>;
  errors: { message: string }[];
}

function userNode(login: string): any {
  const id = login === VIEWER.login ? VIEWER.id : stableId(`user:${login}`);
  return {
    __type: 'User', login, id: globalId('User', login), databaseId: id,
    name: login === VIEWER.login ? VIEWER.name : login,
    email: `${login}@example.invalid`, avatarUrl: '', url: `https://example.invalid/${login}`,
    createdAt: FIXED_DATE, updatedAt: FIXED_DATE,
  };
}

function loadViewerRepo(ctx: Ctx, owner: string, name: string): any {
  if (owner !== VIEWER.login) return null;
  const raw = getRepoRaw(ctx.a, owner, name);
  if (!raw) return null;
  return normRepo(raw, owner);
}

function repoNode(ctx: Ctx, repo: any): any {
  let branches: { name: string; sha: string }[] = [];
  try {
    branches = listBranchesOp(ctx.a, repo.raw);
  } catch { branches = []; }
  const defaultTip = branches.find((b) => b.name === repo.defaultBranch)?.sha ?? '';
  return {
    __type: 'Repository',
    id: globalId('Repository', `${repo.owner}/${repo.name}`),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    owner: userNode(repo.owner),
    description: repo.description ?? '',
    visibility: repo.isPrivate ? 'PRIVATE' : 'PUBLIC',
    defaultBranchRef: defaultTip !== '' ? { __type: 'Ref', name: repo.defaultBranch, prefix: 'refs/heads/', target: { __type: 'GitObject', oid: defaultTip, abbreviatedOid: defaultTip.slice(0, 7) } } : null,
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    url: `https://example.invalid/${repo.owner}/${repo.name}`,
    createdAt: repo.createdAt,
    updatedAt: repo.updatedAt,
    _repo: repo,
    _branches: branches,
  };
}

function issueNode(ctx: Ctx, repo: any, issue: any): any {
  return {
    __type: 'Issue',
    id: globalId('Issue', `${repo.owner}/${repo.name}#${issue.number}`),
    databaseId: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body ?? '',
    state: issue.state === 'closed' ? 'CLOSED' : 'OPEN',
    author: userNode(VIEWER.login),
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
    closedAt: issue.state === 'closed' ? (issue.closedAt ?? issue.updatedAt) : null,
    comments: { __type: 'IssueConnection', nodes: [], edges: [], pageInfo: { __type: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null }, totalCount: 0 },
    _repo: repo,
    _issue: issue,
  };
}

function pullNode(ctx: Ctx, repo: any, pull: any): any {
  let mergeable = 'UNKNOWN';
  try {
    if (pull.merged) mergeable = 'MERGEABLE';
    else {
      const m = mergeableOf(ctx.a, repo.raw, pull);
      mergeable = m === true ? 'MERGEABLE' : (m === false ? 'CONFLICTING' : 'UNKNOWN');
    }
  } catch { mergeable = 'UNKNOWN'; }
  const state = pull.merged ? 'MERGED' : (pull.state === 'closed' ? 'CLOSED' : 'OPEN');
  return {
    __type: 'PullRequest',
    id: globalId('PullRequest', `${repo.owner}/${repo.name}#${pull.number}`),
    databaseId: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body ?? '',
    state,
    merged: pull.merged === true,
    mergeable,
    headRefName: pull.head.ref,
    baseRefName: pull.base.ref,
    headRefOid: pull.head.sha,
    baseRefOid: pull.base.sha,
    author: userNode(VIEWER.login),
    createdAt: pull.createdAt,
    updatedAt: pull.updatedAt,
    mergedAt: pull.merged ? (pull.mergedAt ?? pull.updatedAt) : null,
    url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`,
    _repo: repo,
    _pull: pull,
  };
}

function cursorFor(kind: string, value: string | number): string {
  return Buffer.from(`cursor:${kind}:${value}`, 'utf8').toString('base64');
}

function pageConnection(type: string, edgeType: string, nodes: any[], args: Record<string, any>, cursorOf: (n: any) => string): any {
  let start = 0;
  if (typeof args.after === 'string' && args.after !== '') {
    const idx = nodes.findIndex((n) => cursorOf(n) === args.after);
    if (idx >= 0) start = idx + 1;
  }
  const first = typeof args.first === 'number' && args.first >= 0 ? args.first : nodes.length;
  const page = nodes.slice(start, start + first);
  const hasNextPage = start + first < nodes.length;
  return {
    __type: type,
    nodes: page,
    edges: page.map((n) => ({ __type: edgeType, node: n, cursor: cursorOf(n) })),
    pageInfo: {
      __type: 'PageInfo',
      hasNextPage,
      hasPreviousPage: start > 0,
      startCursor: page.length > 0 ? cursorOf(page[0]) : null,
      endCursor: page.length > 0 ? cursorOf(page[page.length - 1]) : null,
    },
    totalCount: nodes.length,
  };
}

function issuesConnection(ctx: Ctx, repo: any, args: Record<string, any>): any {
  let issues: any[] = [];
  try {
    const raw = callOp(ctx.a, 'listIssues', [repo.raw]);
    if (Array.isArray(raw)) issues = raw.map((i: any) => normIssue(i, repo)).filter(Boolean);
  } catch { issues = []; }
  if (Array.isArray(args.states) && args.states.length > 0) {
    const wanted = new Set(args.states.map((s: any) => String(s).toUpperCase()));
    issues = issues.filter((i) => wanted.has(i.state === 'closed' ? 'CLOSED' : 'OPEN'));
  }
  const orderBy = args.orderBy && typeof args.orderBy === 'object' ? args.orderBy : null;
  if (orderBy) {
    const dir = String(orderBy.direction ?? 'DESC').toUpperCase() === 'ASC' ? 1 : -1;
    issues.sort((x, y) => (x.number - y.number) * dir);
  } else {
    issues.sort((x, y) => x.number - y.number);
  }
  const nodes = issues.map((i) => issueNode(ctx, repo, i));
  return pageConnection('IssueConnection', 'IssueEdge', nodes, args, (n) => cursorFor('issue', n.number));
}

function pullsConnection(ctx: Ctx, repo: any, args: Record<string, any>): any {
  let pulls = listPullsOp(ctx.a, repo);
  if (Array.isArray(args.states) && args.states.length > 0) {
    const wanted = new Set(args.states.map((s: any) => String(s).toUpperCase()));
    pulls = pulls.filter((p) => wanted.has(p.merged ? 'MERGED' : (p.state === 'closed' ? 'CLOSED' : 'OPEN')));
  }
  pulls.sort((x, y) => x.number - y.number);
  const nodes = pulls.map((p) => pullNode(ctx, repo, p));
  return pageConnection('PullRequestConnection', 'PullRequestEdge', nodes, args, (n) => cursorFor('pull', n.number));
}

function filesConnection(ctx: Ctx, repo: any, pull: any, args: Record<string, any>): any {
  const files = listPullFilesOp(ctx.a, repo.raw, pull);
  const nodes = files.map((f) => ({
    __type: 'PullRequestChangedFile',
    path: f.filename,
    additions: f.additions,
    deletions: f.deletions,
    changeType: f.status === 'added' ? 'ADDED' : (f.status === 'removed' ? 'REMOVED' : 'MODIFIED'),
  }));
  return pageConnection('PullRequestChangedFileConnection', 'PullRequestChangedFileEdge', nodes, args, (n) => cursorFor('file', n.path));
}

function typeNode(name: string): any {
  const info = TYPE_INFO[name];
  if (!info) return null;
  const fields = info.fields ? info.fields.map((f) => ({ __type: '__Field', name: f, description: '' })) : null;
  const enumValues = info.enumValues ? info.enumValues.map((v) => ({ __type: '__EnumValue', name: v, description: '' })) : null;
  return {
    __type: '__Type', name, kind: info.kind, description: '',
    fields, enumValues, inputFields: null, interfaces: [], possibleTypes: null,
  };
}

/** Resolve one field of a node; returns the raw value (another node, a
 *  connection, a scalar, or null). Errors are recorded on ctx and yield null. */
function resolveField(ctx: Ctx, type: string, node: any, field: string, args: Record<string, any>): any {
  if (field === '__typename') return type;
  if (type === 'Query') {
    if (field === 'viewer') return userNode(VIEWER.login);
    if (field === 'repository') {
      const repo = loadViewerRepo(ctx, String(args.owner ?? ''), String(args.name ?? ''));
      return repo ? repoNode(ctx, repo) : null;
    }
    if (field === 'node') {
      const decoded = decodeGlobalId(args.id);
      if (!decoded) return null;
      if (decoded.kind === 'Repository') {
        const [owner, name] = decoded.ref.split('/');
        const repo = loadViewerRepo(ctx, owner ?? '', name ?? '');
        return repo ? repoNode(ctx, repo) : null;
      }
      if (decoded.kind === 'Issue') {
        const m = /^(.*)\/([^/]+)#(\d+)$/.exec(decoded.ref);
        if (!m) return null;
        const repo = loadViewerRepo(ctx, m[1] ?? '', m[2] ?? '');
        if (!repo) return null;
        let raw: any = null;
        try { raw = callOp(ctx.a, 'getIssue', [repo.raw, Number(m[3])]); } catch { raw = null; }
        if (!raw) {
          try {
            const list = callOp(ctx.a, 'listIssues', [repo.raw]);
            if (Array.isArray(list)) raw = list.find((i: any) => (i.number ?? i.id) === Number(m[3])) ?? null;
          } catch { raw = null; }
        }
        if (!raw) return null;
        const issue = normIssue(raw, repo);
        return issue ? issueNode(ctx, repo, issue) : null;
      }
      if (decoded.kind === 'PullRequest') {
        const m = /^(.*)\/([^/]+)#(\d+)$/.exec(decoded.ref);
        if (!m) return null;
        const repo = loadViewerRepo(ctx, m[1] ?? '', m[2] ?? '');
        if (!repo) return null;
        const pull = getPullOp(ctx.a, repo, Number(m[3]));
        return pull ? pullNode(ctx, repo, pull) : null;
      }
      return null;
    }
    if (field === '__type') return typeNode(String(args.name ?? ''));
    if (field === '__schema') return { __type: '__Schema', types: [], queryType: { __type: '__Type', name: 'Query', kind: 'OBJECT' }, mutationType: { __type: '__Type', name: 'Mutation', kind: 'OBJECT' }, description: '' };
    if (field === 'search') {
      const q = String(args.query ?? '').toLowerCase();
      let repos: any[] = [];
      try {
        const raw = callOp(ctx.a, 'listRepos', [VIEWER.login]);
        if (Array.isArray(raw)) repos = raw.map((r: any) => normRepo(r, VIEWER.login)).filter(Boolean);
      } catch { repos = []; }
      const matched = repos.filter((r: any) => q === '' || r.name.toLowerCase().includes(q) || `${r.owner}/${r.name}`.toLowerCase().includes(q));
      const nodes = matched.map((r: any) => repoNode(ctx, r));
      return pageConnection('SearchResultConnection', 'SearchResultEdge', nodes, args, (n) => cursorFor('repo', n.nameWithOwner));
    }
    return null;
  }
  if (type === 'Repository') {
    const repo = node._repo;
    if (field === 'issue') {
      const n = Number(args.number);
      if (!Number.isInteger(n)) return null;
      let raw: any = null;
      try { raw = callOp(ctx.a, 'getIssue', [repo.raw, n]); } catch { raw = null; }
      if (!raw) return null;
      return issueNode(ctx, repo, normIssue(raw, repo));
    }
    if (field === 'issues') return issuesConnection(ctx, repo, args);
    if (field === 'pullRequest') {
      const n = Number(args.number);
      if (!Number.isInteger(n)) return null;
      const pull = getPullOp(ctx.a, repo, n);
      return pull ? pullNode(ctx, repo, pull) : null;
    }
    if (field === 'pullRequests') return pullsConnection(ctx, repo, args);
    return node[field] ?? null;
  }
  if (type === 'PullRequest') {
    if (field === 'files') return filesConnection(ctx, node._repo, node._pull, args);
    return node[field] ?? null;
  }
  if (type === 'Mutation') {
    if (field === 'createIssue') {
      const input = (args.input ?? {}) as Record<string, any>;
      const decoded = decodeGlobalId(input.repositoryId);
      if (!decoded || decoded.kind !== 'Repository') {
        ctx.errors.push({ message: 'createIssue: repositoryId does not name a repository.' });
        return null;
      }
      const [owner, name] = decoded.ref.split('/');
      const repo = loadViewerRepo(ctx, owner ?? '', name ?? '');
      if (!repo) {
        ctx.errors.push({ message: 'createIssue: repository not found.' });
        return null;
      }
      const created = createIssueOp(ctx.a, repo.raw, String(input.title ?? ''), typeof input.body === 'string' ? input.body : '', []);
      return { __type: 'CreateIssuePayload', issue: issueNode(ctx, repo, normIssue(created, repo)), clientMutationId: input.clientMutationId ?? null };
    }
    if (field === 'closeIssue') {
      const input = (args.input ?? {}) as Record<string, any>;
      const decoded = decodeGlobalId(input.issueId);
      if (!decoded || decoded.kind !== 'Issue') {
        ctx.errors.push({ message: 'closeIssue: issueId does not name an issue.' });
        return null;
      }
      const m = /^(.*)\/([^/]+)#(\d+)$/.exec(decoded.ref);
      if (!m) {
        ctx.errors.push({ message: 'closeIssue: issueId does not name an issue.' });
        return null;
      }
      const repo = loadViewerRepo(ctx, m[1] ?? '', m[2] ?? '');
      if (!repo) {
        ctx.errors.push({ message: 'closeIssue: repository not found.' });
        return null;
      }
      const updated = callOp(ctx.a, 'updateIssue', [repo.raw, Number(m[3]), { state: 'closed' }]);
      return { __type: 'CloseIssuePayload', issue: issueNode(ctx, repo, normIssue(updated, repo)), clientMutationId: input.clientMutationId ?? null };
    }
    if (field === 'createPullRequest') {
      const input = (args.input ?? {}) as Record<string, any>;
      const decoded = decodeGlobalId(input.repositoryId);
      if (!decoded || decoded.kind !== 'Repository') {
        ctx.errors.push({ message: 'createPullRequest: repositoryId does not name a repository.' });
        return null;
      }
      const [owner, name] = decoded.ref.split('/');
      const repo = loadViewerRepo(ctx, owner ?? '', name ?? '');
      if (!repo) {
        ctx.errors.push({ message: 'createPullRequest: repository not found.' });
        return null;
      }
      const head = String(input.headRefName ?? '');
      const base = String(input.baseRefName ?? repo.defaultBranch);
      const headSha = resolveRefOp(ctx.a, repo.raw, `refs/heads/${head}`);
      const baseSha = resolveRefOp(ctx.a, repo.raw, `refs/heads/${base}`);
      if (!headSha || !baseSha) {
        ctx.errors.push({ message: 'createPullRequest: head or base branch not found.' });
        return null;
      }
      const pull = createPullOp(ctx.a, repo, head, base, String(input.title ?? ''), typeof input.body === 'string' ? input.body : '');
      return { __type: 'CreatePullRequestPayload', pullRequest: pullNode(ctx, repo, pull), clientMutationId: input.clientMutationId ?? null };
    }
    if (field === 'mergePullRequest') {
      const input = (args.input ?? {}) as Record<string, any>;
      const decoded = decodeGlobalId(input.pullRequestId);
      if (!decoded || decoded.kind !== 'PullRequest') {
        ctx.errors.push({ message: 'mergePullRequest: pullRequestId does not name a pull request.' });
        return null;
      }
      const m = /^(.*)\/([^/]+)#(\d+)$/.exec(decoded.ref);
      if (!m) {
        ctx.errors.push({ message: 'mergePullRequest: pullRequestId does not name a pull request.' });
        return null;
      }
      const repo = loadViewerRepo(ctx, m[1] ?? '', m[2] ?? '');
      if (!repo) {
        ctx.errors.push({ message: 'mergePullRequest: repository not found.' });
        return null;
      }
      const pull = getPullOp(ctx.a, repo, Number(m[3]));
      if (!pull) {
        ctx.errors.push({ message: 'mergePullRequest: pull request not found.' });
        return null;
      }
      if (pull.merged) {
        ctx.errors.push({ message: 'mergePullRequest: pull request is already merged.' });
        return null;
      }
      try {
        mergePullOp(ctx.a, repo, pull, 'squash');
      } catch (err) {
        ctx.errors.push({ message: err instanceof Error ? err.message : 'merge failed' });
        return null;
      }
      const merged = getPullOp(ctx.a, repo, Number(m[3]));
      return { __type: 'MergePullRequestPayload', pullRequest: merged ? pullNode(ctx, repo, merged) : pullNode(ctx, repo, { ...pull, merged: true, state: 'closed' }), clientMutationId: input.clientMutationId ?? null };
    }
    if (field === 'addComment') {
      const input = (args.input ?? {}) as Record<string, any>;
      const decoded = decodeGlobalId(input.subjectId);
      if (!decoded || decoded.kind !== 'Issue') {
        ctx.errors.push({ message: 'addComment: subjectId does not name an issue.' });
        return null;
      }
      const m = /^(.*)\/([^/]+)#(\d+)$/.exec(decoded.ref);
      if (!m) {
        ctx.errors.push({ message: 'addComment: subjectId does not name an issue.' });
        return null;
      }
      const repo = loadViewerRepo(ctx, m[1] ?? '', m[2] ?? '');
      if (!repo) {
        ctx.errors.push({ message: 'addComment: repository not found.' });
        return null;
      }
      const created = callOp(ctx.a, 'addComment', [repo.raw, Number(m[3]), String(input.body ?? '')]);
      const commentId = typeof created?.id === 'number' ? created.id : stableId(`${repo.owner}/${repo.name}#${m[3]}:comment:${String(input.body ?? '').length}`);
      const node = {
        __type: 'IssueComment', id: globalId('IssueComment', `${repo.owner}/${repo.name}#${m[3]}:${commentId}`),
        body: String(input.body ?? ''), author: userNode(VIEWER.login), createdAt: FIXED_DATE, updatedAt: FIXED_DATE,
      };
      return { __type: 'AddCommentPayload', commentEdge: { __type: 'IssueCommentEdge', node, cursor: cursorFor('comment', commentId) }, clientMutationId: input.clientMutationId ?? null };
    }
    return null;
  }
  return node[field] ?? null;
}

/** Project a node's requested selections into the response object. */
function project(ctx: Ctx, type: string, node: any, selections: Selection[], variables: Record<string, any>): any {
  if (node === null || node === undefined) return null;
  const out: Record<string, any> = {};
  for (const sel of selections) {
    if (sel.kind === 'fragment') {
      if (sel.typeCondition) {
        if (sel.typeCondition !== type && sel.typeCondition !== 'Node') continue;
        const inner = project(ctx, sel.typeCondition === 'Node' ? type : sel.typeCondition, node, sel.selections ?? [], variables);
        Object.assign(out, inner);
      }
      continue;
    }
    const field = sel.name ?? '';
    const key = sel.alias ?? field;
    const args = resolveArgs(sel.args, variables);
    if (field === '__typename') { out[key] = type; continue; }
    const value = resolveField(ctx, type, node, field, args);
    if (value === null || value === undefined) { out[key] = null; continue; }
    if (sel.selections) {
      const childType = (FIELD_TYPE[type] ?? {})[field];
      if (Array.isArray(value)) {
        out[key] = value.map((v) => project(ctx, childType ?? type, v, sel.selections ?? [], variables));
      } else if (typeof value === 'object' && value.__type) {
        out[key] = project(ctx, value.__type, value, sel.selections ?? [], variables);
      } else if (typeof value === 'object' && childType) {
        out[key] = project(ctx, childType, value, sel.selections ?? [], variables);
      } else {
        out[key] = value;
      }
    } else {
      out[key] = value;
    }
  }
  return out;
}

// -------------------------------------------------------------------------------------------
// One operation, then dispatch.
// -------------------------------------------------------------------------------------------

export function executeOperation(store: any, op: Operation, variables: Record<string, any>): { data: any; errors: { message: string }[] } {
  const ctx: Ctx = { a: adaptStore(store), errors: [] };
  const rootType = op.type === 'mutation' ? 'Mutation' : 'Query';
  const validationErrors: { message: string }[] = [];
  validateSelections(rootType, op.selections, validationErrors);
  if (validationErrors.length > 0) return { data: null, errors: validationErrors };
  try {
    const data = project(ctx, rootType, {}, op.selections, variables);
    return { data, errors: ctx.errors };
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'execution failed' }] };
  }
}

export function dispatchGraphQL(store: any, method: string, segments: string[], query: Record<string, unknown>, auth: unknown, rawBody: unknown): { status: number; headers: Record<string, string>; body: string } {
  const m = String(method).toUpperCase();
  if (m !== 'POST') return errResp(405, 'Method not allowed');
  if (!isViewer(auth)) return errResp(401, 'Requires authentication');
  let parsed: any = null;
  const bodyText = typeof rawBody === 'string' ? rawBody : (typeof Buffer !== 'undefined' && Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : null);
  if (bodyText !== null && bodyText.trim() !== '') {
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      return errResp(400, 'Problems parsing JSON');
    }
  } else if (rawBody !== null && typeof rawBody === 'object' && !Buffer.isBuffer(rawBody)) {
    parsed = rawBody;
  }
  if (parsed === null || parsed === undefined) return jsonResp(200, { data: null, errors: [{ message: 'Must provide query string.' }] });
  const runOne = (entry: any): any => {
    if (!entry || typeof entry !== 'object' || typeof entry.query !== 'string') {
      return { data: null, errors: [{ message: 'Must provide query string.' }] };
    }
    let doc: { operations: Operation[] };
    try {
      doc = parseDocument(entry.query);
    } catch (err) {
      return { data: null, errors: [{ message: err instanceof Error ? err.message : 'Syntax Error' }] };
    }
    const variables = entry.variables && typeof entry.variables === 'object' ? entry.variables : {};
    let op = doc.operations[0];
    if (typeof entry.operationName === 'string' && entry.operationName !== '') {
      op = doc.operations.find((o) => o.name === entry.operationName) ?? op;
    }
    if (!op) return { data: null, errors: [{ message: 'Must provide an operation.' }] };
    try {
      return executeOperation(store, op, variables);
    } catch (err) {
      return { data: null, errors: [{ message: err instanceof Error ? err.message : 'execution failed' }] };
    }
  };
  if (Array.isArray(parsed)) {
    return jsonResp(200, parsed.map(runOne));
  }
  return jsonResp(200, runOne(parsed));
}
