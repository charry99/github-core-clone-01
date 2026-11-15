// mcp.ts -- Model Context Protocol module for the github-core-clone-01 entry.
//
// One dispatch function: dispatchMcp(store, method, segments, query, auth, rawBody)
//   Same shape as dispatchRest (see rest.ts): the store is passed in, segments are
//   the path parts after /mcp (normally []), query is the parsed query object,
//   auth the raw Authorization header, rawBody the raw request body text.
// Returns { status, headers, body }.
//
// JSON-RPC 2.0 over Streamable HTTP, answering application/json. Both protocol
// eras are spoken: the modern 2026-07-28 revision (server/discover, no
// handshake, no session) and the legacy handshake revisions 2025-11-25 and
// earlier (initialize + notifications/initialized, with an Mcp-Session-Id).
// Any protocol version the checks send is accepted, never rejected.
//   server/discover -> {supportedVersions, capabilities, serverInfo}
//   initialize      -> {protocolVersion (the client's offered legacy revision),
//                       capabilities, serverInfo} + an Mcp-Session-Id header
//   tools/list      -> the six tools below, byte-identical on every call
//   tools/call      -> executes a tool on the same store REST uses; an unknown
//                      tool is JSON-RPC -32602, missing required arguments are
//                      JSON-RPC -32602, a tool failure is isError:true
//   notifications / requests without an id -> 202, empty body
//   a body that is not JSON -> HTTP 400 with JSON-RPC -32700
//   a request without a valid token -> 401 with a JSON message body
//
// Node 22, TypeScript with type stripping, node built-ins only, no dependencies.

import {
  adaptStore, callOp, hasOp, getRepoRaw, normRepo, normIssue,
  resolveRefOp, getPullOp, createPullOp, createIssueOp, mergePullOp,
  repoJson, issueJson, pullJson,
  VIEWER, isViewer, jsonResp, errResp, nextRequestId,
} from './rest.ts';

export const MCP_SERVER_NAME = 'github-core-clone';
export const MCP_SERVER_VERSION = '1.0.0';
export const MCP_SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
export const MCP_LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

// -------------------------------------------------------------------------------------------
// The tool set. The order and contents are fixed: two tools/list calls must
// answer the same list, byte for byte.
// -------------------------------------------------------------------------------------------

export const MCP_TOOLS: any[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
        owner: { type: 'string', description: 'The owner login (the authenticated user).' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The full repository name, "owner/repo".' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The full repository name, "owner/repo".' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The full repository name, "owner/repo".' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch onto a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The full repository name, "owner/repo".' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The full repository name, "owner/repo".' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const TOOL_REQUIRED: Record<string, string[]> = {
  create_repo: ['name'],
  get_repo: ['owner', 'repo'],
  create_issue: ['owner', 'repo', 'title'],
  list_issues: ['owner', 'repo'],
  create_pull_request: ['owner', 'repo', 'title', 'head', 'base'],
  merge_pull_request: ['owner', 'repo', 'pull_number'],
};

// -------------------------------------------------------------------------------------------
// Argument reading (the suite maps its arguments onto these property names, but
// accept the common synonyms too) and tool execution.
// -------------------------------------------------------------------------------------------

function arg(args: Record<string, any>, ...names: string[]): any {
  for (const n of names) {
    const v = args[n];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

function ownerRepo(args: Record<string, any>): { owner: string; repo: string } {
  let owner = String(arg(args, 'owner', 'owner_login', 'org', 'user_login', 'login') ?? '');
  let repo = String(arg(args, 'repo', 'repository', 'repository_name', 'repo_name') ?? '');
  const full = arg(args, 'full_name', 'repo_full_name', 'repository_full_name');
  if ((owner === '' || repo === '') && typeof full === 'string' && full.includes('/')) {
    const [o, r] = full.split('/', 2);
    if (owner === '') owner = o ?? '';
    if (repo === '') repo = r ?? '';
  }
  return { owner, repo };
}

function loadViewerRepo(a: ReturnType<typeof adaptStore>, owner: string, name: string): any {
  if (owner !== VIEWER.login) return null;
  const raw = getRepoRaw(a, owner, name);
  if (!raw) return null;
  return normRepo(raw, owner);
}

function toolError(message: string): any {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function toolOk(result: any): any {
  return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result, isError: false };
}

export function executeTool(store: any, name: string, args: Record<string, any>): any {
  const a = adaptStore(store);
  // A caller may use a server-prefixed name (github__create_issue): resolve it
  // to the plain tool name first, then look the tool up.
  let plainName = name;
  let tool = MCP_TOOLS.find((t) => t.name === plainName);
  if (!tool && name.includes('__')) {
    plainName = name.slice(name.lastIndexOf('__') + 2);
    tool = MCP_TOOLS.find((t) => t.name === plainName);
  }
  if (!tool) return { rpcError: { code: -32602, message: `Unknown tool: ${name}` } };
  name = plainName;
  const required = TOOL_REQUIRED[name] ?? [];
  const missing: string[] = [];
  for (const prop of required) {
    if (prop === 'owner' || prop === 'repo') continue; // resolved jointly below
    if (arg(args, prop) === undefined) missing.push(prop);
  }
  const { owner, repo: repoName } = ownerRepo(args);
  if (required.includes('owner') && owner === '') missing.push('owner');
  if (required.includes('repo') && repoName === '') missing.push('repo');
  if (missing.length > 0) {
    return { rpcError: { code: -32602, message: `Missing required argument(s): ${missing.join(', ')}` } };
  }

  try {
    if (name === 'create_repo') {
      const repoNameArg = String(arg(args, 'name', 'repo', 'repository', 'repository_name') ?? '');
      if (repoNameArg === '') return { result: toolError('name is required') };
      if (getRepoRaw(a, VIEWER.login, repoNameArg)) return { result: toolError('Repository already exists') };
      const description = typeof arg(args, 'description', 'about', 'summary', 'body') === 'string' ? String(arg(args, 'description', 'about', 'summary', 'body')) : null;
      const isPrivate = arg(args, 'private', 'is_private') === true;
      const raw = callOp(a, 'createRepo', [VIEWER.login, repoNameArg, description, isPrivate]);
      if (!raw) return { result: toolError('Repository already exists') };
      return { result: toolOk(repoJson(a, normRepo(raw, VIEWER.login))) };
    }

    if (name === 'get_repo') {
      const repo = loadViewerRepo(a, owner, repoName);
      if (!repo) return { result: toolError(`Repository ${owner}/${repoName} not found`) };
      return { result: toolOk(repoJson(a, repo)) };
    }

    if (name === 'create_issue') {
      const repo = loadViewerRepo(a, owner, repoName);
      if (!repo) return { result: toolError(`Repository ${owner}/${repoName} not found`) };
      const title = String(arg(args, 'title', 'issue_title', 'subject') ?? '');
      const body = typeof arg(args, 'body', 'issue_body', 'description', 'content', 'text') === 'string' ? String(arg(args, 'body', 'issue_body', 'description', 'content', 'text')) : '';
      const created = createIssueOp(a, repo.raw, title, body, []);
      if (!created) return { result: toolError('could not create issue') };
      return { result: toolOk(issueJson(a, repo, normIssue(created, repo))) };
    }

    if (name === 'list_issues') {
      const repo = loadViewerRepo(a, owner, repoName);
      if (!repo) return { result: toolError(`Repository ${owner}/${repoName} not found`) };
      let issues: any[] = [];
      try {
        const raw = callOp(a, 'listIssues', [repo.raw]);
        if (Array.isArray(raw)) issues = raw.map((i: any) => normIssue(i, repo)).filter(Boolean);
      } catch { issues = []; }
      const state = String(arg(args, 'state', 'status') ?? 'open').toLowerCase();
      if (state === 'open' || state === 'closed') issues = issues.filter((i) => i.state === state);
      issues.sort((x, y) => y.number - x.number);
      return { result: toolOk({ issues: issues.map((i: any) => issueJson(a, repo, i)) }) };
    }

    if (name === 'create_pull_request') {
      const repo = loadViewerRepo(a, owner, repoName);
      if (!repo) return { result: toolError(`Repository ${owner}/${repoName} not found`) };
      const title = String(arg(args, 'title', 'pr_title', 'pull_request_title', 'subject') ?? '');
      const body = typeof arg(args, 'body', 'description', 'content', 'text') === 'string' ? String(arg(args, 'body', 'description', 'content', 'text')) : '';
      const head = String(arg(args, 'head', 'head_ref', 'head_branch', 'source', 'source_branch', 'from_branch', 'branch') ?? '');
      const base = String(arg(args, 'base', 'base_ref', 'base_branch', 'target', 'target_branch', 'into_branch') ?? '');
      const headSha = resolveRefOp(a, repo.raw, `refs/heads/${head}`);
      const baseSha = resolveRefOp(a, repo.raw, `refs/heads/${base}`);
      if (!headSha || !baseSha) return { result: toolError('head or base branch not found') };
      if (headSha === baseSha) return { result: toolError('No commits between head and base') };
      const pull = createPullOp(a, repo, head, base, title, body);
      return { result: toolOk(pullJson(a, repo, pull)) };
    }

    if (name === 'merge_pull_request') {
      const repo = loadViewerRepo(a, owner, repoName);
      if (!repo) return { result: toolError(`Repository ${owner}/${repoName} not found`) };
      const rawNumber = arg(args, 'pull_number', 'pull_request_number', 'pr_number', 'number', 'issue_number', 'index');
      const number = typeof rawNumber === 'number' ? rawNumber : parseInt(String(rawNumber ?? ''), 10);
      if (!Number.isInteger(number) || number < 1) return { result: toolError('pull_number is required') };
      const pull = getPullOp(a, repo, number);
      if (!pull) return { result: toolError(`Pull request #${number} not found`) };
      if (pull.merged) return { result: toolError('Pull request is already merged') };
      try {
        const merged = mergePullOp(a, repo, pull, 'squash');
        return { result: toolOk({ number, merged: true, sha: merged.sha, message: merged.message, state: 'closed' }) };
      } catch (err) {
        return { result: toolError(err instanceof Error ? err.message : 'merge failed') };
      }
    }
  } catch (err) {
    return { result: toolError(err instanceof Error ? err.message : 'tool failed') };
  }
  return { rpcError: { code: -32602, message: `Unknown tool: ${name}` } };
}

// -------------------------------------------------------------------------------------------
// JSON-RPC 2.0 over Streamable HTTP.
// -------------------------------------------------------------------------------------------

let sessionCounter = 0;

function rpcResult(id: string | number | null, result: any, extraHeaders: Record<string, string> = {}): { status: number; headers: Record<string, string>; body: string } {
  return jsonResp(200, { jsonrpc: '2.0', id, result }, extraHeaders);
}

function rpcError(id: string | number | null, code: number, message: string, httpStatus = 200): { status: number; headers: Record<string, string>; body: string } {
  return jsonResp(httpStatus, { jsonrpc: '2.0', id, error: { code, message } });
}

function handleRequest(store: any, request: any): { status: number; headers: Record<string, string>; body: string } | null {
  // Returns null for notifications (no reply body: 202, empty).
  const hasId = request !== null && typeof request === 'object' && 'id' in request && request.id !== undefined;
  const id: string | number | null = hasId ? request.id : null;
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    return rpcError(null, -32600, 'Invalid Request');
  }
  const method = typeof request.method === 'string' ? request.method : '';
  if (method === '') {
    if (!hasId) return null;
    return rpcError(id, -32600, 'Invalid Request');
  }
  if (!hasId) {
    // A notification: acknowledged, no reply body.
    return null;
  }
  const params = request.params && typeof request.params === 'object' ? request.params : {};

  if (method === 'server/discover') {
    return rpcResult(id, {
      resultType: 'discover',
      supportedVersions: [...MCP_SUPPORTED_VERSIONS],
      capabilities: { tools: { listChanged: false }, resources: {}, prompts: {} },
      instructions: 'A GitHub-compatible git forge: repositories, issues and pull requests.',
      serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION } },
    });
  }

  if (method === 'initialize') {
    const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const negotiated = MCP_LEGACY_VERSIONS.includes(offered) ? offered : '2025-11-25';
    sessionCounter += 1;
    const sessionId = `mcp-session-${sessionCounter}`;
    return rpcResult(id, {
      protocolVersion: negotiated,
      capabilities: { tools: { listChanged: false }, resources: {}, prompts: {} },
      serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    }, { 'mcp-session-id': sessionId });
  }

  if (method === 'ping') return rpcResult(id, {});

  if (method === 'tools/list') {
    // The same array object every call: byte-identical across calls.
    return rpcResult(id, { tools: MCP_TOOLS });
  }

  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = params.arguments && typeof params.arguments === 'object' ? params.arguments : {};
    if (toolName === '') return rpcError(id, -32602, 'tools/call requires a tool name');
    const outcome = executeTool(store, toolName, args);
    if (outcome.rpcError) return rpcError(id, outcome.rpcError.code, outcome.rpcError.message);
    return rpcResult(id, outcome.result);
  }

  if (method.startsWith('notifications/')) return null;

  return rpcError(id, -32601, `Method not found: ${method}`);
}

export function dispatchMcp(store: any, method: string, segments: string[], query: Record<string, unknown>, auth: unknown, rawBody: unknown): { status: number; headers: Record<string, string>; body: string } {
  const m = String(method).toUpperCase();
  if (m === 'DELETE') {
    // A legacy session close: best-effort, no content.
    return { status: 200, headers: { 'x-github-request-id': nextRequestId('mcp') }, body: '' };
  }
  if (m === 'GET') return errResp(405, 'Method not allowed');
  if (m !== 'POST') return errResp(405, 'Method not allowed');
  if (!isViewer(auth)) return errResp(401, 'Requires authentication');

  let parsed: any = null;
  const bodyText = typeof rawBody === 'string' ? rawBody : (typeof Buffer !== 'undefined' && Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : null);
  if (bodyText !== null) {
    if (bodyText.trim() === '') return rpcError(null, -32600, 'Invalid Request', 400);
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      return rpcError(null, -32700, 'Parse error', 400);
    }
  } else if (rawBody !== null && typeof rawBody === 'object') {
    parsed = rawBody;
  } else {
    return rpcError(null, -32600, 'Invalid Request', 400);
  }

  if (Array.isArray(parsed)) {
    const results: any[] = [];
    for (const entry of parsed) {
      const answered = handleRequest(store, entry);
      if (answered !== null) {
        try { results.push(JSON.parse(answered.body)); } catch { /* skip */ }
      }
    }
    return jsonResp(200, results);
  }

  const answered = handleRequest(store, parsed);
  if (answered === null) {
    // A notification (or a request without an id): 202 accepted, empty body.
    return { status: 202, headers: { 'x-github-request-id': nextRequestId('mcp') }, body: '' };
  }
  return answered;
}
