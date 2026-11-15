// rest.ts -- GitHub REST v3 module for the github-core-clone-01 entry.
//
// One dispatch function: dispatchRest(store, method, segments, query, auth, rawBody)
//   store    : the in-memory store object session 1 builds (createStore() with no args).
//   method   : HTTP method, e.g. 'GET'.
//   segments : path parts after the /api/v3 prefix, e.g. ['repos','adaiversen','x','issues'].
//   query    : parsed query object, values are strings (or arrays; the first wins).
//   auth     : the raw Authorization header value (or null/undefined).
//   rawBody  : the raw request body text (or '' when there is none).
// Returns { status, headers, body } where body is a string (JSON, or '' for 204).
//
// Store contract this module builds against (see build-spec/task-02). The store's
// methods are found by name from a short candidate list, so a differently-named
// method with the same meaning still works. Every store method below takes the
// RAW repository record the store itself returned (from getRepo/createRepo) as
// its first argument, then plain positional arguments:
//   createRepo(owner, name, description, isPrivate) -> repo record (throws on duplicate)
//   getRepo(owner, name) -> repo record | null
//   listRepos(ownerLogin) -> repo records in creation order
//   deleteRepo(owner, name) -> void
//   putObject(repo, kind, data: Buffer) -> oid | getObject(repo, oid) -> {kind, data} | null
//   createBlob(repo, data) -> oid | createTree(repo, entries) -> oid
//   createCommit(repo, treeOid, parents: string[], message) -> oid
//   listRefs(repo) -> [{name, oid}] | setRef(repo, ref, oid) | deleteRef(repo, ref)
//   resolveRef(repo, refName) -> oid | null
//   putFile(repo, branch, path, data: Buffer, message) -> {commitSha, blobSha}
//   deleteFile(repo, branch, path, message) -> {commitSha}
//   readFile(repo, ref, path) -> {data: Buffer, oid} | null
//   readDir(repo, ref, path) -> [{name, path, type, sha, size}] | null
//   listBranches(repo) -> [{name, sha}] | listCommits(repo, ref) -> commits, newest first
//   createIssue(repo, title, body, labels: string[]) -> issue
//   listIssues(repo) -> issues in creation order | getIssue(repo, n) -> issue | null
//   updateIssue(repo, n, patch) -> issue
//   addComment(repo, n, body) -> comment | listComments(repo, n) -> comments
//   createLabel(repo, name, color?) -> label (throws on duplicate) | listLabels(repo)
//   createPull(repo, head, base, title, body) -> pull
//   getPull(repo, n) -> pull | null | listPulls(repo) -> pulls in creation order
//   listPullFiles(repo, n) -> [{filename, status, additions, deletions, changes}]
//   mergePull(repo, n, method) -> {sha, merged, message}
// Where a high-level operation is missing, this module rebuilds it from the
// object/ref primitives (git object parsing lives below). Pull-request merge
// state the store cannot persist is kept in a per-store overlay map.
//
// Auth: the bearer token is read from process.env.MAKEFUN_SHOP_TOKEN. A request
// carrying exactly that token is the viewer. When the variable is unset (local
// runs), any non-empty bearer token counts as the viewer. No token, or a token
// that does not match when the variable is set, is unauthenticated (401).
//
// Node 22, TypeScript with type stripping, node built-ins only, no dependencies.

import { createHash } from 'node:crypto';

export const VIEWER = { login: 'adaiversen', id: 1000, name: 'ada iversen', email: 'adaiversen@example.invalid' };
export const TEAMMATE = { login: 'quinnkeller', id: 1001, name: 'quinn keller', email: 'quinnkeller@example.invalid' };
export const STRANGER = { login: 'olgabauer', id: 1002, name: 'olga bauer', email: 'olgabauer@example.invalid' };
export const ORG = { login: 'faint-meadow-org', id: 1003, name: 'faint meadow org', email: '' };
export const USERS: Record<string, { login: string; id: number; name: string; email: string; type: string }> = {
  adaiversen: { ...VIEWER, type: 'User' },
  quinnkeller: { ...TEAMMATE, type: 'User' },
  olgabauer: { ...STRANGER, type: 'User' },
  'faint-meadow-org': { ...ORG, type: 'Organization' },
};

export const FIXED_DATE = '2026-11-14T06:30:00Z';
export const FIXED_EPOCH = 1700000000;
export const AUTHOR_NAME = 'ada iversen';
export const AUTHOR_EMAIL = 'adaiversen@example.invalid';

// -------------------------------------------------------------------------------------------
// Small utilities
// -------------------------------------------------------------------------------------------

let requestCounter = 0;
export function nextRequestId(prefix: string): string {
  requestCounter += 1;
  return `${prefix}-${requestCounter}`;
}

export function tokenOf(auth: unknown): string | null {
  if (typeof auth !== 'string') return null;
  const m = /^Bearer\s+(.+)$/.exec(auth.trim());
  return m ? (m[1] ?? '').trim() || null : null;
}

export function isViewer(auth: unknown): boolean {
  const token = tokenOf(auth);
  if (token === null || token === '') return false;
  const expected = process.env.MAKEFUN_SHOP_TOKEN;
  if (expected !== undefined && expected !== '') return token === expected;
  return true;
}

export function stableId(seed: string): number {
  const hex = createHash('sha1').update(seed, 'utf8').digest('hex');
  return (parseInt(hex.slice(0, 8), 16) % 2147483646) + 1;
}

export function globalId(kind: string, ref: string): string {
  return Buffer.from(`${kind}:${ref}`, 'utf8').toString('base64');
}

export function decodeGlobalId(id: unknown): { kind: string; ref: string } | null {
  if (typeof id !== 'string' || id === '') return null;
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const i = text.indexOf(':');
    if (i <= 0) return null;
    return { kind: text.slice(0, i), ref: text.slice(i + 1) };
  } catch {
    return null;
  }
}

export function jsonResp(status: number, body: unknown, extraHeaders: Record<string, string> = {}): { status: number; headers: Record<string, string>; body: string } {
  const headers: Record<string, string> = {
    'content-type': 'application/json; charset=utf-8',
    'x-github-request-id': nextRequestId('rest'),
    'x-oauth-scopes': 'repo, read:org',
    ...extraHeaders,
  };
  return { status, headers, body: body === null || body === undefined ? '' : JSON.stringify(body) };
}

export function errResp(status: number, message: string, extraHeaders: Record<string, string> = {}): { status: number; headers: Record<string, string>; body: string } {
  return jsonResp(status, { message }, extraHeaders);
}

export function qstr(query: Record<string, unknown>, key: string, fallback: string): string {
  const v = query[key];
  if (typeof v === 'string') return v;
  if (Array.isArray(v) && typeof v[0] === 'string') return v[0] as string;
  return fallback;
}

export function qint(query: Record<string, unknown>, key: string, fallback: number): number {
  const n = parseInt(qstr(query, key, String(fallback)), 10);
  return Number.isFinite(n) ? n : fallback;
}

/** Paginate a list; returns the page and any Link header (relative URLs: the
 *  wiring layer must absolutize them against the request origin, because this
 *  dispatch never sees the origin). */
export function paginate<T>(items: readonly T[], query: Record<string, unknown>, basePath: string): { items: T[]; headers: Record<string, string> } {
  const perPage = Math.max(1, Math.min(100, qint(query, 'per_page', 30)));
  const page = Math.max(1, qint(query, 'page', 1));
  const total = items.length;
  const pages = Math.max(1, Math.ceil(total / perPage));
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  if (pages > 1) {
    const origin = typeof query['__origin'] === 'string' ? (query['__origin'] as string) : '';
    const u = (p: number): string => `${origin}${basePath}?per_page=${perPage}&page=${p}`;
    const links: string[] = [`<${u(1)}>; rel="first"`];
    if (page > 1) links.push(`<${u(page - 1)}>; rel="prev"`);
    if (page < pages) links.push(`<${u(page + 1)}>; rel="next"`);
    links.push(`<${u(pages)}>; rel="last"`);
    headers.link = links.join(', ');
  }
  return { items: slice, headers };
}

export function b64encode(data: Buffer): string {
  return data.toString('base64');
}

export function b64decode(text: string): Buffer {
  return Buffer.from(String(text).replace(/[\r\n\t ]+/g, ''), 'base64');
}

// -------------------------------------------------------------------------------------------
// Store adapter: find each operation by name from a candidate list.
// -------------------------------------------------------------------------------------------

type StoreFn = (...args: any[]) => any;

const OP_NAMES: Record<string, string[]> = {
  createRepo: ['createRepo', 'createRepository', 'create', 'addRepo'],
  getRepo: ['getRepo', 'getRepository', 'findRepo', 'findRepository', 'readRepo'],
  listRepos: ['listReposByOwner', 'listRepos', 'listRepositories', 'listReposForUser', 'reposFor', 'listUserRepos'],
  deleteRepo: ['deleteRepo', 'deleteRepository', 'removeRepo'],
  putObject: ['putObject', 'storeObject', 'writeObject', 'saveObject'],
  getObject: ['getObject', 'readObject', 'loadObject'],
  createBlob: ['createBlob', 'makeBlob', 'writeBlob', 'buildBlob'],
  createTree: ['createTree', 'makeTree', 'writeTree', 'buildTree'],
  createCommit: ['createCommit', 'makeCommit', 'writeCommit', 'buildCommit'],
  listRefs: ['listRefs', 'refs', 'getRefs'],
  setRef: ['setRef', 'updateRef', 'writeRef'],
  deleteRef: ['deleteRef', 'removeRef'],
  resolveRef: ['resolveRef', 'getRef', 'refToOid', 'lookupRef'],
  putFile: ['putFile', 'applyContentsChange', 'writeFile', 'createOrUpdateFile', 'upsertFile', 'putContents'],
  deleteFile: ['deleteFile', 'applyContentsDelete', 'removeFile', 'deleteContents'],
  readFile: ['readFile', 'getFile', 'readContents'],
  readDir: ['readDir', 'readDirectory', 'listDirectory', 'listDir', 'getDirectory'],
  readPathAtRef: ['readPathAtRef'],
  listBranches: ['listBranches', 'branches', 'getBranches'],
  listCommits: ['listCommits', 'commits', 'getCommits', 'listCommitsOnBranch'],
  createIssue: ['createIssue', 'addIssue', 'newIssue'],
  listIssues: ['listIssues', 'issues', 'getIssues'],
  getIssue: ['getIssue', 'findIssue', 'readIssue'],
  updateIssue: ['updateIssue', 'patchIssue', 'setIssue'],
  addComment: ['addComment', 'createComment', 'addIssueComment'],
  listComments: ['listComments', 'comments', 'getComments', 'listIssueComments'],
  createLabel: ['createLabel', 'addLabel'],
  listLabels: ['listLabels', 'labels', 'getLabels'],
  createPull: ['createPull', 'createPullRequest', 'addPull', 'newPull'],
  getPull: ['getPull', 'getPullRequest', 'findPull'],
  listPulls: ['listPulls', 'listPullRequests', 'pulls', 'getPulls'],
  listPullFiles: ['listPullFiles', 'pullFiles', 'getPullFiles', 'listChangedFiles'],
  checkPullMergeable: ['checkPullMergeable'],
  mergePull: ['mergePullSquash', 'mergePull', 'mergePullRequest', 'merge'],
};

export interface AdaptedStore {
  raw: any;
  fns: Record<string, StoreFn | null>;
}

export function adaptStore(store: any): AdaptedStore {
  const fns: Record<string, StoreFn | null> = {};
  for (const [key, names] of Object.entries(OP_NAMES)) {
    let fn: StoreFn | null = null;
    for (const n of names) {
      if (typeof store[n] === 'function') { fn = store[n].bind(store); break; }
    }
    fns[key] = fn;
  }
  return { raw: store, fns };
}

export function hasOp(a: AdaptedStore, key: string): boolean {
  return a.fns[key] !== null && a.fns[key] !== undefined;
}

export function callOp(a: AdaptedStore, key: string, args: any[]): any {
  const fn = a.fns[key];
  if (!fn) throw new Error(`store operation ${key} is not available`);
  return fn(...args);
}

// Per-store overlays, for state the store itself cannot persist (repo description
// patches, pull-request merge state and creation-time base/head shas).
const repoOverlays = new WeakMap<any, Map<string, Record<string, any>>>();
const pullOverlays = new WeakMap<any, Map<string, Record<string, any>>>();

export function repoOverlay(a: AdaptedStore): Map<string, Record<string, any>> {
  let m = repoOverlays.get(a.raw);
  if (!m) { m = new Map(); repoOverlays.set(a.raw, m); }
  return m;
}

export function pullOverlay(a: AdaptedStore): Map<string, Record<string, any>> {
  let m = pullOverlays.get(a.raw);
  if (!m) { m = new Map(); pullOverlays.set(a.raw, m); }
  return m;
}

export function pullKey(owner: string, name: string, number: number): string {
  return `${owner}/${name}#${number}`;
}

// -------------------------------------------------------------------------------------------
// Record normalizers (accept either camelCase or snake_case, object or string forms).
// -------------------------------------------------------------------------------------------

export function normRepo(r: any, ownerHint?: string): any {
  if (!r || typeof r !== 'object') return null;
  const full = typeof r.full_name === 'string' ? r.full_name : (typeof r.fullName === 'string' ? r.fullName : null);
  const owner = typeof r.owner === 'string' ? r.owner : (r.ownerLogin ?? r.owner?.login ?? (full ? full.split('/')[0] : ownerHint ?? VIEWER.login));
  const name = r.name ?? (full ? full.split('/').slice(1).join('/') : null) ?? r.repo ?? '';
  return {
    raw: r,
    owner,
    name,
    description: r.description ?? null,
    isPrivate: r.private ?? r.isPrivate ?? false,
    defaultBranch: r.defaultBranch ?? r.default_branch ?? 'main',
    id: typeof r.id === 'number' ? r.id : (typeof r.databaseId === 'number' ? r.databaseId : stableId(`${owner}/${name}`)),
    createdAt: r.createdAt ?? r.created_at ?? FIXED_DATE,
    updatedAt: r.updatedAt ?? r.updated_at ?? FIXED_DATE,
  };
}

export function normLabel(l: any): any {
  if (typeof l === 'string') return { name: l, color: 'ededed', id: stableId(`label:${l}`) };
  if (!l || typeof l !== 'object') return { name: String(l ?? ''), color: 'ededed', id: 0 };
  return {
    name: l.name ?? '',
    color: l.color ?? 'ededed',
    description: l.description ?? '',
    id: typeof l.id === 'number' ? l.id : stableId(`label:${l.name ?? ''}`),
  };
}

export function normIssue(r: any, repo: any): any {
  if (!r || typeof r !== 'object') return null;
  const number = typeof r.number === 'number' ? r.number : (typeof r.id === 'number' ? r.id : 0);
  const labels = Array.isArray(r.labels) ? r.labels.map(normLabel) : [];
  return {
    raw: r,
    number,
    title: r.title ?? '',
    body: r.body ?? '',
    state: String(r.state ?? 'open').toLowerCase(),
    labels,
    id: typeof r.id === 'number' ? r.id : stableId(`${repo.owner}/${repo.name}#issue-${number}`),
    createdAt: r.createdAt ?? r.created_at ?? FIXED_DATE,
    updatedAt: r.updatedAt ?? r.updated_at ?? FIXED_DATE,
    closedAt: r.closedAt ?? r.closed_at ?? null,
    user: r.user ?? { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    commentsCount: typeof r.comments === 'number' ? r.comments : (typeof r.commentsCount === 'number' ? r.commentsCount : undefined),
  };
}

export function normComment(r: any, repo: any, issueNumber: number, index: number): any {
  if (!r || typeof r !== 'object') return null;
  return {
    raw: r,
    id: typeof r.id === 'number' ? r.id : stableId(`${repo.owner}/${repo.name}#${issueNumber}:comment:${index}`),
    body: r.body ?? '',
    createdAt: r.createdAt ?? r.created_at ?? FIXED_DATE,
    updatedAt: r.updatedAt ?? r.updated_at ?? FIXED_DATE,
    user: r.user ?? { login: VIEWER.login, id: VIEWER.id, type: 'User' },
  };
}

function normRefSide(v: any): { ref: string; sha: string } {
  if (typeof v === 'string') return { ref: v, sha: '' };
  if (!v || typeof v !== 'object') return { ref: '', sha: '' };
  return {
    ref: v.ref ?? v.refName ?? v.branch ?? v.headRefName ?? v.name ?? '',
    sha: v.sha ?? v.oid ?? v.headSha ?? '',
  };
}

export function normPull(r: any, repo: any): any {
  if (!r || typeof r !== 'object') return null;
  const number = typeof r.number === 'number' ? r.number : (typeof r.id === 'number' ? r.id : 0);
  const head = normRefSide(r.head);
  const base = normRefSide(r.base);
  if (head.sha === '' && typeof r.headSha === 'string') head.sha = r.headSha;
  if (base.sha === '' && typeof r.baseSha === 'string') base.sha = r.baseSha;
  return {
    raw: r,
    number,
    title: r.title ?? '',
    body: r.body ?? '',
    state: String(r.state ?? 'open').toLowerCase(),
    head,
    base,
    merged: r.merged === true,
    mergedAt: r.mergedAt ?? r.merged_at ?? null,
    mergeCommitSha: r.mergeCommitSha ?? r.merge_commit_sha ?? null,
    mergeable: typeof r.mergeable === 'boolean' ? r.mergeable : undefined,
    id: typeof r.id === 'number' ? r.id : stableId(`${repo.owner}/${repo.name}#pull-${number}`),
    createdAt: r.createdAt ?? r.created_at ?? FIXED_DATE,
    updatedAt: r.updatedAt ?? r.updated_at ?? FIXED_DATE,
    closedAt: r.closedAt ?? r.closed_at ?? null,
    user: r.user ?? { login: VIEWER.login, id: VIEWER.id, type: 'User' },
  };
}

export function normCommit(r: any): any {
  if (!r || typeof r !== 'object') return null;
  const sha = r.sha ?? r.oid ?? r.id ?? '';
  const inner = r.commit ?? {};
  const parsePerson = (v: any): { name: string; email: string; date: string } => {
    if (typeof v === 'string') return parseIdent(v);
    if (v && typeof v === 'object') return { name: v.name ?? AUTHOR_NAME, email: v.email ?? AUTHOR_EMAIL, date: v.date ?? FIXED_DATE };
    return { name: AUTHOR_NAME, email: AUTHOR_EMAIL, date: FIXED_DATE };
  };
  const author = parsePerson(r.author ?? inner.author ?? null);
  const committer = parsePerson(r.committer ?? inner.committer ?? null);
  const parentsRaw = r.parents ?? r.parentShas ?? inner.parents ?? [];
  const parents = Array.isArray(parentsRaw) ? parentsRaw.map((p: any) => (typeof p === 'string' ? p : (p.sha ?? p.oid ?? ''))).filter(Boolean) : [];
  return {
    sha,
    message: typeof (r.message ?? inner.message) === 'string' ? (r.message ?? inner.message as string).replace(/\n$/, '') : '',
    tree: r.tree ?? inner.tree?.sha ?? '',
    author: { name: author.name ?? AUTHOR_NAME, email: author.email ?? AUTHOR_EMAIL, date: author.date ?? FIXED_DATE },
    committer: { name: committer.name ?? AUTHOR_NAME, email: committer.email ?? AUTHOR_EMAIL, date: committer.date ?? FIXED_DATE },
    parents,
  };
}

// -------------------------------------------------------------------------------------------
// Git object helpers (raw object parsing; used when the store exposes primitives
// but not the high-level operation a route needs).
// -------------------------------------------------------------------------------------------

export function gitOid(kind: string, data: Buffer): string {
  const h = createHash('sha1');
  h.update(`${kind} ${data.length}\0`, 'utf8');
  h.update(data);
  return h.digest('hex');
}

function parseIdent(text: string): { name: string; email: string; date: string } {
  const m = /^(.*) <(.*)> (\d+) ([+-]\d{4})$/.exec(text.trim());
  if (!m) return { name: text.trim(), email: '', date: FIXED_DATE };
  return { name: m[1] ?? '', email: m[2] ?? '', date: new Date(Number(m[3]) * 1000).toISOString() };
}

export function parseCommit(data: Buffer): any {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2).replace(/\n$/, '');
  const out: any = { tree: '', parents: [], message, author: null, committer: null };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) out.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) out.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) out.author = parseIdent(line.slice(7));
    else if (line.startsWith('committer ')) out.committer = parseIdent(line.slice(10));
  }
  if (!out.author) out.author = { name: AUTHOR_NAME, email: AUTHOR_EMAIL, date: FIXED_DATE };
  if (!out.committer) out.committer = { name: AUTHOR_NAME, email: AUTHOR_EMAIL, date: FIXED_DATE };
  return out;
}

export function parseTree(data: Buffer): { mode: string; name: string; oid: string; type: string }[] {
  const entries: { mode: string; name: string; oid: string; type: string }[] = [];
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    if (sp === -1) break;
    const mode = data.toString('utf8', off, sp);
    const nul = data.indexOf(0x00, sp);
    if (nul === -1 || nul + 21 > data.length) break;
    const name = data.toString('utf8', sp + 1, nul);
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid, type: mode === '40000' ? 'tree' : 'blob' });
    off = nul + 21;
  }
  return entries;
}

export function serializeTree(entries: { mode: string; name: string; oid: string }[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export function objectData(obj: any): { kind: string; data: Buffer } | null {
  if (obj === null || obj === undefined) return null;
  if (typeof obj === 'string') return { kind: '', data: Buffer.from(obj, 'utf8') };
  if (Buffer.isBuffer(obj)) return { kind: '', data: obj };
  if (obj instanceof Uint8Array) return { kind: '', data: Buffer.from(obj) };
  const data = obj.data ?? obj.content ?? obj.bytes ?? null;
  if (data === null || data === undefined) return null;
  let buf: Buffer;
  if (Buffer.isBuffer(data)) buf = data;
  else if (data instanceof Uint8Array) buf = Buffer.from(data);
  else if (typeof data === 'string' && (obj.encoding === 'base64' || /^[A-Za-z0-9+/=]{4,}$/.test(data))) buf = b64decode(data);
  else buf = Buffer.from(String(data), 'utf8');
  return { kind: obj.kind ?? obj.type ?? '', data: buf };
}

export function oidOf(value: any): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') return value.oid ?? value.sha ?? value.id ?? '';
  return '';
}

// -------------------------------------------------------------------------------------------
// Store operations with fallbacks.
// -------------------------------------------------------------------------------------------

export function getRepoRaw(a: AdaptedStore, owner: string, name: string): any {
  try {
    const r = callOp(a, 'getRepo', [owner, name]);
    return r ?? null;
  } catch {
    return null;
  }
}

export function listReposRaw(a: AdaptedStore, owner: string): any[] {
  try {
    const list = callOp(a, 'listRepos', [owner]);
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export function resolveRefOp(a: AdaptedStore, repoRaw: any, ref: string): string | null {
  if (hasOp(a, 'resolveRef')) {
    try {
      const oid = callOp(a, 'resolveRef', [repoRaw, ref]);
      if (typeof oid === 'string' && oid !== '') return oid;
      if (oid && typeof oid === 'object') {
        const s = oid.oid ?? oid.sha ?? '';
        if (s !== '') return s;
      }
    } catch { /* fall through */ }
  }
  if (hasOp(a, 'listRefs')) {
    try {
      const refs = callOp(a, 'listRefs', [repoRaw]);
      if (Array.isArray(refs)) {
        for (const r of refs) {
          const name = r.name ?? r.ref ?? '';
          if (name === ref) return r.oid ?? r.sha ?? null;
        }
      }
    } catch { /* fall through */ }
  }
  if (ref.startsWith('refs/heads/')) {
    const branches = listBranchesOp(a, repoRaw);
    const found = branches.find((b) => b.name === ref.slice('refs/heads/'.length));
    if (found) return found.sha;
  }
  return null;
}

export function readCommitOp(a: AdaptedStore, repoRaw: any, oid: string): any {
  if (!hasOp(a, 'getObject')) return null;
  try {
    const obj = objectData(callOp(a, 'getObject', [repoRaw, oid]));
    if (!obj) return null;
    const parsed = parseCommit(obj.data);
    parsed.sha = oid;
    return parsed;
  } catch {
    return null;
  }
}

export function treeMapOp(a: AdaptedStore, repoRaw: any, treeOid: string): Map<string, { oid: string; mode: string; type: string }> {
  const out = new Map<string, { oid: string; mode: string; type: string }>();
  if (!hasOp(a, 'getObject')) return out;
  const walk = (tree: string, prefix: string): void => {
    let raw: { kind: string; data: Buffer } | null = null;
    try { raw = objectData(callOp(a, 'getObject', [repoRaw, tree])); } catch { raw = null; }
    if (!raw) return;
    for (const e of parseTree(raw.data)) {
      const p = prefix === '' ? e.name : `${prefix}/${e.name}`;
      if (e.type === 'tree') {
        out.set(p, { oid: e.oid, mode: e.mode, type: 'tree' });
        walk(e.oid, p);
      } else {
        out.set(p, { oid: e.oid, mode: e.mode, type: 'blob' });
      }
    }
  };
  walk(treeOid, '');
  return out;
}

function treeEntriesOp(a: AdaptedStore, repoRaw: any, treeOid: string | null): { mode: string; name: string; oid: string; type: string }[] {
  if (treeOid === null || !hasOp(a, 'getObject')) return [];
  try {
    const raw = objectData(callOp(a, 'getObject', [repoRaw, treeOid]));
    if (!raw) return [];
    return parseTree(raw.data);
  } catch {
    return [];
  }
}

function createTreeOp(a: AdaptedStore, repoRaw: any, entries: { mode: string; name: string; oid: string; type: string }[]): string {
  const sorted = [...entries].sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
  if (hasOp(a, 'createTree')) {
    try {
      const out = callOp(a, 'createTree', [repoRaw, sorted]);
      const oid = oidOf(out);
      if (oid !== '') return oid;
    } catch { /* try the raw form */ }
  }
  if (hasOp(a, 'putObject')) {
    const out = callOp(a, 'putObject', [repoRaw, 'tree', serializeTree(sorted)]);
    const oid = oidOf(out);
    if (oid !== '') return oid;
    return gitOid('tree', serializeTree(sorted));
  }
  return gitOid('tree', serializeTree(sorted));
}

function createCommitOp(a: AdaptedStore, repoRaw: any, treeOid: string, parents: string[], message: string): string {
  if (hasOp(a, 'createCommit')) {
    try {
      const out = callOp(a, 'createCommit', [repoRaw, { tree: treeOid, parents, message }]);
      const oid = oidOf(out);
      if (oid !== '') return oid;
    } catch { /* try the positional form */ }
    try {
      const out = callOp(a, 'createCommit', [repoRaw, treeOid, parents, message]);
      const oid = oidOf(out);
      if (oid !== '') return oid;
    } catch { /* fall through */ }
  }
  if (hasOp(a, 'putObject')) {
    let text = `tree ${treeOid}\n`;
    for (const p of parents) text += `parent ${p}\n`;
    text += `author ${AUTHOR_NAME} <${AUTHOR_EMAIL}> ${FIXED_EPOCH} +0000\n`;
    text += `committer ${AUTHOR_NAME} <${AUTHOR_EMAIL}> ${FIXED_EPOCH} +0000\n\n${message}\n`;
    const buf = Buffer.from(text, 'utf8');
    const out = callOp(a, 'putObject', [repoRaw, 'commit', buf]);
    const oid = oidOf(out);
    if (oid !== '') return oid;
    return gitOid('commit', buf);
  }
  throw new Error('store cannot create a commit');
}

function createBlobOp(a: AdaptedStore, repoRaw: any, data: Buffer): string {
  if (hasOp(a, 'createBlob')) {
    try {
      const out = callOp(a, 'createBlob', [repoRaw, data]);
      const oid = oidOf(out);
      if (oid !== '') return oid;
    } catch { /* try putObject */ }
  }
  if (hasOp(a, 'putObject')) {
    const out = callOp(a, 'putObject', [repoRaw, 'blob', data]);
    const oid = oidOf(out);
    if (oid !== '') return oid;
    return gitOid('blob', data);
  }
  throw new Error('store cannot create a blob');
}

function writePathToTree(a: AdaptedStore, repoRaw: any, baseTreeOid: string | null, parts: string[], blobOid: string | null): string {
  const entries = treeEntriesOp(a, repoRaw, baseTreeOid);
  const head = parts[0] ?? '';
  if (parts.length === 1) {
    const next = entries.filter((e) => e.name !== head);
    if (blobOid !== null) next.push({ mode: '100644', name: head, oid: blobOid, type: 'blob' });
    return createTreeOp(a, repoRaw, next);
  }
  const dir = entries.find((e) => e.name === head && e.type === 'tree');
  const sub = writePathToTree(a, repoRaw, dir ? dir.oid : null, parts.slice(1), blobOid);
  const next = entries.filter((e) => e.name !== head);
  next.push({ mode: '40000', name: head, oid: sub, type: 'tree' });
  return createTreeOp(a, repoRaw, next);
}

export function putFileOp(a: AdaptedStore, repoRaw: any, branch: string, path: string, data: Buffer, message: string): { commitSha: string; blobSha: string } {
  if (hasOp(a, 'putFile')) {
    try {
      const out = callOp(a, 'putFile', [repoRaw, branch, path, data, message]);
      const commitSha = out?.commitSha ?? (typeof out?.commit === 'string' ? out.commit : out?.commit?.sha) ?? out?.sha ?? '';
      const blobSha = out?.blobSha ?? (typeof out?.blob === 'string' ? out.blob : out?.blob?.sha) ?? out?.contentSha ?? gitOid('blob', data);
      if (commitSha !== '') return { commitSha, blobSha };
    } catch (err) {
      // A store-level refusal (e.g. a bad branch) is real: only fall back when the
      // operation itself is missing, which callOp already reports.
      if (err instanceof Error && err.message.startsWith('store operation putFile')) { /* fall through */ }
      else throw err;
    }
  }
  const tip = resolveRefOp(a, repoRaw, `refs/heads/${branch}`);
  let treeOid: string | null = null;
  const parents: string[] = [];
  if (tip) {
    const commit = readCommitOp(a, repoRaw, tip);
    if (commit) { treeOid = commit.tree; parents.push(tip); }
  }
  const blobSha = createBlobOp(a, repoRaw, data);
  const parts = path.split('/').filter((p) => p !== '');
  const newTree = writePathToTree(a, repoRaw, treeOid, parts, blobSha);
  const commitSha = createCommitOp(a, repoRaw, newTree, parents, message);
  callOp(a, 'setRef', [repoRaw, `refs/heads/${branch}`, commitSha]);
  return { commitSha, blobSha };
}

export function deleteFileOp(a: AdaptedStore, repoRaw: any, branch: string, path: string, message: string): { commitSha: string } {
  if (hasOp(a, 'deleteFile')) {
    try {
      const out = callOp(a, 'deleteFile', [repoRaw, branch, path, message]);
      const commitSha = out?.commitSha ?? (typeof out?.commit === 'string' ? out.commit : out?.commit?.sha) ?? out?.sha ?? '';
      if (commitSha !== '') return { commitSha };
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('store operation deleteFile')) { /* fall through */ }
      else throw err;
    }
  }
  const tip = resolveRefOp(a, repoRaw, `refs/heads/${branch}`);
  if (!tip) throw new Error('branch not found');
  const commit = readCommitOp(a, repoRaw, tip);
  if (!commit) throw new Error('branch tip is not a commit');
  const parts = path.split('/').filter((p) => p !== '');
  const newTree = writePathToTree(a, repoRaw, commit.tree, parts, null);
  const commitSha = createCommitOp(a, repoRaw, newTree, [tip], message);
  callOp(a, 'setRef', [repoRaw, `refs/heads/${branch}`, commitSha]);
  return { commitSha };
}

export function readFileOp(a: AdaptedStore, repoRaw: any, ref: string, path: string): { data: Buffer; oid: string } | null {
  // readPathAtRef resolves branch names only, not raw commit oids: an oid ref
  // must go through the object tree walk below instead.
  const isOidRef = /^[0-9a-f]{40}$/i.test(ref);
  if (!isOidRef && hasOp(a, 'readPathAtRef')) {
    try {
      const out = callOp(a, 'readPathAtRef', [repoRaw, ref, path]);
      if (out === null || out === undefined) return null;
      if (out.type === 'blob') {
        const dataRaw = out.data ?? out.content ?? null;
        if (dataRaw === null || dataRaw === undefined) return null;
        const buf = Buffer.isBuffer(dataRaw) ? dataRaw : (dataRaw instanceof Uint8Array ? Buffer.from(dataRaw) : (typeof dataRaw === 'string' && out.encoding === 'base64' ? b64decode(dataRaw) : Buffer.from(String(dataRaw), 'utf8')));
        return { data: buf, oid: out.oid ?? out.sha ?? gitOid('blob', buf) };
      }
      return null;
    } catch {
      return null;
    }
  }
  if (hasOp(a, 'readFile')) {
    try {
      const out = callOp(a, 'readFile', [repoRaw, ref, path]);
      if (out === null || out === undefined) return null;
      if (Buffer.isBuffer(out)) return { data: out, oid: gitOid('blob', out) };
      const dataRaw = out.data ?? out.content ?? null;
      if (dataRaw !== null && dataRaw !== undefined) {
        let buf: Buffer;
        if (Buffer.isBuffer(dataRaw)) buf = dataRaw;
        else if (dataRaw instanceof Uint8Array) buf = Buffer.from(dataRaw);
        else if (typeof dataRaw === 'string' && out.encoding === 'base64') buf = b64decode(dataRaw);
        else buf = Buffer.from(String(dataRaw), 'utf8');
        return { data: buf, oid: out.oid ?? out.sha ?? gitOid('blob', buf) };
      }
      if (typeof out === 'string') return { data: Buffer.from(out, 'utf8'), oid: gitOid('blob', Buffer.from(out, 'utf8')) };
      return null;
    } catch {
      return null;
    }
  }
  const tip = resolveRefOp(a, repoRaw, ref.startsWith('refs/') ? ref : `refs/heads/${ref}`) ?? (ref.length === 40 ? ref : null);
  if (!tip) return null;
  const commit = readCommitOp(a, repoRaw, tip);
  if (!commit) return null;
  const map = treeMapOp(a, repoRaw, commit.tree);
  const entry = map.get(path);
  if (!entry || entry.type !== 'blob') return null;
  if (!hasOp(a, 'getObject')) return null;
  try {
    const obj = objectData(callOp(a, 'getObject', [repoRaw, entry.oid]));
    if (!obj) return null;
    return { data: obj.data, oid: entry.oid };
  } catch {
    return null;
  }
}

export function readDirOp(a: AdaptedStore, repoRaw: any, ref: string, path: string): { name: string; path: string; type: string; sha: string; size: number }[] | null {
  const isOidRef = /^[0-9a-f]{40}$/i.test(ref);
  if (!isOidRef && hasOp(a, 'readPathAtRef')) {
    try {
      const out = callOp(a, 'readPathAtRef', [repoRaw, ref, path]);
      if (out === null || out === undefined) return null;
      if (out.type !== 'tree' || !Array.isArray(out.entries)) return null;
      const prefix = path === '' ? '' : `${path}/`;
      return out.entries.map((e: any) => ({
        name: e.name ?? '',
        path: `${prefix}${e.name ?? ''}`,
        type: (e.kind ?? e.type) === 'tree' ? 'dir' : 'file',
        sha: e.oid ?? e.sha ?? '',
        size: typeof e.size === 'number' ? e.size : 0,
      }));
    } catch {
      return null;
    }
  }
  if (hasOp(a, 'readDir')) {
    try {
      const out = callOp(a, 'readDir', [repoRaw, ref, path]);
      if (out === null || out === undefined) return null;
      if (!Array.isArray(out)) return null;
      return out.map((e: any) => ({
        name: e.name ?? '',
        path: e.path ?? (path === '' ? (e.name ?? '') : `${path}/${e.name ?? ''}`),
        type: e.type ?? 'file',
        sha: e.sha ?? e.oid ?? '',
        size: typeof e.size === 'number' ? e.size : 0,
      }));
    } catch {
      return null;
    }
  }
  const tip = resolveRefOp(a, repoRaw, ref.startsWith('refs/') ? ref : `refs/heads/${ref}`) ?? (ref.length === 40 ? ref : null);
  if (!tip) return null;
  const commit = readCommitOp(a, repoRaw, tip);
  if (!commit) return null;
  const map = treeMapOp(a, repoRaw, commit.tree);
  const prefix = path === '' ? '' : `${path}/`;
  if (path !== '' && ![...map.keys()].some((k) => k.startsWith(prefix)) && !map.has(path)) return null;
  if (path !== '' && map.has(path) && map.get(path)?.type === 'blob') return null;
  const children = new Map<string, { type: string; sha: string }>();
  for (const [key, entry] of map) {
    if (!key.startsWith(prefix)) continue;
    const rest = key.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash === -1) children.set(rest, { type: 'file', sha: entry.oid });
    else children.set(rest.slice(0, slash), { type: 'dir', sha: map.get(`${prefix}${rest.slice(0, slash)}`)?.oid ?? '' });
  }
  const out: { name: string; path: string; type: string; sha: string; size: number }[] = [];
  for (const [name, info] of [...children.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1))) {
    let size = 0;
    if (info.type === 'file' && hasOp(a, 'getObject')) {
      try {
        const obj = objectData(callOp(a, 'getObject', [repoRaw, info.sha]));
        size = obj ? obj.data.length : 0;
      } catch { size = 0; }
    }
    out.push({ name, path: prefix === '' ? name : `${prefix}${name}`, type: info.type, sha: info.sha, size });
  }
  return out;
}

export function listBranchesOp(a: AdaptedStore, repoRaw: any): { name: string; sha: string }[] {
  if (hasOp(a, 'listBranches')) {
    try {
      const list = callOp(a, 'listBranches', [repoRaw]);
      if (Array.isArray(list)) {
        return list.map((b: any) => ({
          name: typeof b === 'string' ? b : (b.name ?? b.ref?.replace(/^refs\/heads\//, '') ?? ''),
          sha: typeof b === 'string' ? '' : (b.sha ?? b.oid ?? b.commit?.sha ?? ''),
        })).filter((b) => b.name !== '');
      }
    } catch { /* fall through */ }
  }
  if (hasOp(a, 'listRefs')) {
    try {
      const refs = callOp(a, 'listRefs', [repoRaw]);
      if (Array.isArray(refs)) {
        return refs
          .filter((r: any) => String(r.name ?? r.ref ?? '').startsWith('refs/heads/'))
          .map((r: any) => ({ name: String(r.name ?? r.ref).slice('refs/heads/'.length), sha: r.oid ?? r.sha ?? '' }));
      }
    } catch { /* fall through */ }
  }
  return [];
}

export function listCommitsOp(a: AdaptedStore, repoRaw: any, ref: string): any[] {
  if (hasOp(a, 'listCommits')) {
    try {
      const list = callOp(a, 'listCommits', [repoRaw, ref]);
      if (Array.isArray(list) && list.length > 0) return list.map(normCommit).filter(Boolean);
    } catch { /* fall through */ }
  }
  const tip = resolveRefOp(a, repoRaw, ref.startsWith('refs/') ? ref : `refs/heads/${ref}`) ?? (ref.length === 40 ? ref : null);
  if (!tip) return [];
  const out: any[] = [];
  const seen = new Set<string>();
  let current: string | null = tip;
  while (current !== null && !seen.has(current)) {
    seen.add(current);
    const commit = readCommitOp(a, repoRaw, current);
    if (!commit) break;
    out.push({ sha: current, message: commit.message, tree: commit.tree, author: commit.author, committer: commit.committer, parents: commit.parents });
    current = commit.parents.length > 0 ? commit.parents[0] : null;
  }
  return out;
}

// -------------------------------------------------------------------------------------------
// Pull-request files, conflict detection and merge.
// -------------------------------------------------------------------------------------------

/** The number of lines in a blob's text: a trailing newline ends the last line, it does not start a new one. */
export function countLines(text: string): number {
  if (text === '') return 0;
  const parts = text.split('\n');
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts.length;
}

/** Multiset line diff: lines in `b` not in `a` are additions, lines in `a` not in `b` deletions. */
export function lineDiff(aText: string, bText: string): { additions: number; deletions: number } {
  const aLines = aText === '' ? [] : aText.split('\n');
  const bLines = bText === '' ? [] : bText.split('\n');
  if (aLines.length > 0 && aLines[aLines.length - 1] === '') aLines.pop();
  if (bLines.length > 0 && bLines[bLines.length - 1] === '') bLines.pop();
  const counts = new Map<string, number>();
  for (const line of aLines) counts.set(line, (counts.get(line) ?? 0) + 1);
  let additions = 0;
  for (const line of bLines) {
    const left = counts.get(line) ?? 0;
    if (left > 0) counts.set(line, left - 1);
    else additions += 1;
  }
  let deletions = 0;
  for (const left of counts.values()) deletions += left;
  return { additions, deletions };
}

function blobTextOp(a: AdaptedStore, repoRaw: any, oid: string): string | null {
  if (!hasOp(a, 'getObject')) return null;
  try {
    const obj = objectData(callOp(a, 'getObject', [repoRaw, oid]));
    return obj ? obj.data.toString('utf8') : null;
  } catch {
    return null;
  }
}

export function treeDiffFiles(a: AdaptedStore, repoRaw: any, baseTreeOid: string, headTreeOid: string): { filename: string; status: string; additions: number; deletions: number; changes: number }[] {
  const baseMap = treeMapOp(a, repoRaw, baseTreeOid);
  const headMap = treeMapOp(a, repoRaw, headTreeOid);
  const paths = new Set<string>([...baseMap.keys(), ...headMap.keys()]);
  const out: { filename: string; status: string; additions: number; deletions: number; changes: number }[] = [];
  for (const path of [...paths].sort()) {
    const b = baseMap.get(path);
    const h = headMap.get(path);
    if (b && b.type === 'tree') continue;
    if (h && h.type === 'tree') continue;
    if (b && !h) {
      const text = blobTextOp(a, repoRaw, b.oid) ?? '';
      const lines = countLines(text);
      out.push({ filename: path, status: 'removed', additions: 0, deletions: lines, changes: lines });
    } else if (!b && h) {
      const text = blobTextOp(a, repoRaw, h.oid) ?? '';
      const lines = countLines(text);
      out.push({ filename: path, status: 'added', additions: lines, deletions: 0, changes: lines });
    } else if (b && h && b.oid !== h.oid) {
      const aText = blobTextOp(a, repoRaw, b.oid) ?? '';
      const bText = blobTextOp(a, repoRaw, h.oid) ?? '';
      const { additions, deletions } = lineDiff(aText, bText);
      out.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  return out;
}

export function listPullFilesOp(a: AdaptedStore, repoRaw: any, pull: any): { filename: string; status: string; additions: number; deletions: number; changes: number }[] {
  if (hasOp(a, 'listPullFiles')) {
    try {
      const list = callOp(a, 'listPullFiles', [repoRaw, pull.number]);
      if (Array.isArray(list)) {
        return list.map((f: any) => {
          const additions = typeof f.additions === 'number' ? f.additions : 0;
          const deletions = typeof f.deletions === 'number' ? f.deletions : 0;
          return {
            filename: f.filename ?? f.path ?? '',
            status: f.status ?? 'modified',
            additions,
            deletions,
            changes: typeof f.changes === 'number' ? f.changes : additions + deletions,
          };
        });
      }
    } catch { /* fall through to the tree diff */ }
  }
  const baseSha = pull.base.sha;
  const headSha = pull.head.sha;
  if (!baseSha || !headSha) return [];
  const baseCommit = readCommitOp(a, repoRaw, baseSha);
  const headCommit = readCommitOp(a, repoRaw, headSha);
  if (!baseCommit || !headCommit) return [];
  return treeDiffFiles(a, repoRaw, baseCommit.tree, headCommit.tree);
}

/** Would squash-merging this pull conflict? A file the pull changes (base -> head)
 *  that the base branch has also changed since the pull's base sha is a conflict. */
export function pullConflicts(a: AdaptedStore, repoRaw: any, pull: any): boolean {
  const baseTipSha = resolveRefOp(a, repoRaw, `refs/heads/${pull.base.ref}`);
  if (!baseTipSha) return false;
  if (baseTipSha === pull.base.sha) return false;
  const files = listPullFilesOp(a, repoRaw, pull);
  for (const file of files) {
    const baseVersion = readFileOp(a, repoRaw, pull.base.sha, file.filename);
    const tipVersion = readFileOp(a, repoRaw, baseTipSha, file.filename);
    const headVersion = readFileOp(a, repoRaw, pull.head.sha, file.filename);
    const baseOid = baseVersion ? baseVersion.oid : null;
    const tipOid = tipVersion ? tipVersion.oid : null;
    const headOid = headVersion ? headVersion.oid : null;
    if (tipOid !== baseOid && headOid !== baseOid) return true;
  }
  return false;
}

/** Is this pull mergeable? Prefer the store's own check; otherwise compare
 *  the changed files against the base branch tip. Null when unknowable. */
export function mergeableOf(a: AdaptedStore, repoRaw: any, pull: any): boolean | null {
  if (hasOp(a, 'checkPullMergeable')) {
    try {
      const out = callOp(a, 'checkPullMergeable', [repoRaw, pull.number]);
      if (out !== null && typeof out === 'object' && typeof out.mergeable === 'boolean') return out.mergeable;
      if (typeof out === 'boolean') return out;
    } catch { /* fall through to the tree comparison */ }
  }
  try {
    return !pullConflicts(a, repoRaw, pull);
  } catch {
    return null;
  }
}

export function getPullOp(a: AdaptedStore, repo: any, number: number): any {
  let pull: any = null;
  if (hasOp(a, 'getPull')) {
    try { pull = callOp(a, 'getPull', [repo.raw, number]) ?? null; } catch { pull = null; }
  }
  if (!pull && hasOp(a, 'listPulls')) {
    try {
      const list = callOp(a, 'listPulls', [repo.raw]);
      if (Array.isArray(list)) pull = list.find((p: any) => (p.number ?? p.id) === number) ?? null;
    } catch { /* ignore */ }
  }
  if (!pull) return null;
  const normed = normPull(pull, repo);
  const overlay = pullOverlay(a).get(pullKey(repo.owner, repo.name, number));
  if (overlay) {
    if (overlay.baseSha) normed.base.sha = overlay.baseSha;
    if (overlay.headSha) normed.head.sha = overlay.headSha;
    if (overlay.merged === true) {
      normed.merged = true;
      normed.state = 'closed';
      normed.mergedAt = overlay.mergedAt ?? normed.mergedAt;
      normed.mergeCommitSha = overlay.mergeSha ?? normed.mergeCommitSha;
      normed.closedAt = overlay.mergedAt ?? normed.closedAt;
    }
  }
  return normed;
}

export function listPullsOp(a: AdaptedStore, repo: any): any[] {
  let list: any[] = [];
  if (hasOp(a, 'listPulls')) {
    try {
      const raw = callOp(a, 'listPulls', [repo.raw]);
      if (Array.isArray(raw)) list = raw.map((p: any) => normPull(p, repo)).filter(Boolean);
    } catch { list = []; }
  }
  const overlay = pullOverlay(a);
  for (const pull of list) {
    const o = overlay.get(pullKey(repo.owner, repo.name, pull.number));
    if (o) {
      if (o.baseSha) pull.base.sha = o.baseSha;
      if (o.headSha) pull.head.sha = o.headSha;
      if (o.merged === true) {
        pull.merged = true;
        pull.state = 'closed';
        pull.mergedAt = o.mergedAt ?? pull.mergedAt;
        pull.mergeCommitSha = o.mergeSha ?? pull.mergeCommitSha;
        pull.closedAt = o.mergedAt ?? pull.closedAt;
      }
    }
  }
  return list;
}

export function createPullOp(a: AdaptedStore, repo: any, head: string, base: string, title: string, body: string): any {
  const fn = a.fns.createPull;
  if (!fn) throw new Error('store operation createPull is not available');
  // A 2-arity createPull takes one input object; a wider one takes positional args.
  const created = fn.length <= 2
    ? fn(repo.raw, { head, base, title, body })
    : fn(repo.raw, head, base, title, body);
  const pull = normPull(created, repo);
  const baseSha = resolveRefOp(a, repo.raw, `refs/heads/${base}`);
  const headSha = resolveRefOp(a, repo.raw, `refs/heads/${head}`);
  pullOverlay(a).set(pullKey(repo.owner, repo.name, pull.number), {
    baseSha: baseSha ?? pull.base.sha ?? '',
    headSha: headSha ?? pull.head.sha ?? '',
  });
  if (baseSha) pull.base.sha = baseSha;
  if (headSha) pull.head.sha = headSha;
  return pull;
}

/** Create an issue, choosing the store's input form by the method's arity:
 *  a 2-arity createIssue takes one input object; a wider one takes positional
 *  (title, body, labels) arguments. */
export function createIssueOp(a: AdaptedStore, repoRaw: any, title: string, body: string, labels: string[]): any {
  const fn = a.fns.createIssue;
  if (!fn) throw new Error('store operation createIssue is not available');
  return fn.length <= 2
    ? fn(repoRaw, { title, body, labels })
    : fn(repoRaw, title, body, labels);
}

export function mergePullOp(a: AdaptedStore, repo: any, pull: any, method: string): { sha: string; merged: boolean; message: string } {
  if (hasOp(a, 'mergePull')) {
    try {
      const out = callOp(a, 'mergePull', [repo.raw, pull.number, method]);
      if (typeof out === 'string' && out !== '') {
        pullOverlay(a).set(pullKey(repo.owner, repo.name, pull.number), {
          baseSha: pull.base.sha, headSha: pull.head.sha,
          merged: true, mergedAt: FIXED_DATE, mergeSha: out,
        });
        return { sha: out, merged: true, message: `Pull request #${pull.number} merged` };
      }
      const sha = out?.sha ?? out?.mergeSha ?? out?.merge_commit_sha ?? '';
      if (sha !== '' && (out?.merged === true || out?.merged === undefined)) {
        pullOverlay(a).set(pullKey(repo.owner, repo.name, pull.number), {
          baseSha: pull.base.sha, headSha: pull.head.sha,
          merged: true, mergedAt: FIXED_DATE, mergeSha: sha,
        });
        return { sha, merged: true, message: out?.message ?? `Pull request #${pull.number} merged` };
      }
      if (out?.merged === false) throw new Error('merge conflict');
      if (out !== null && out !== undefined) {
        // The store merged but reported no sha: the base tip is the merge commit.
        const tip = resolveRefOp(a, repo.raw, `refs/heads/${pull.base.ref}`);
        if (tip) {
          pullOverlay(a).set(pullKey(repo.owner, repo.name, pull.number), {
            baseSha: pull.base.sha, headSha: pull.head.sha,
            merged: true, mergedAt: FIXED_DATE, mergeSha: tip,
          });
          return { sha: tip, merged: true, message: `Pull request #${pull.number} merged` };
        }
      }
    } catch (err) {
      if (err instanceof Error && /conflict/i.test(err.message)) throw err;
      // A missing store op falls through to the local squash; other failures are real.
      if (!(err instanceof Error && err.message.startsWith('store operation mergePull'))) throw err;
    }
  }
  if (pullConflicts(a, repo.raw, pull)) throw new Error('merge conflict');
  const headCommit = readCommitOp(a, repo.raw, pull.head.sha);
  if (!headCommit) throw new Error('head commit not found');
  const baseTip = resolveRefOp(a, repo.raw, `refs/heads/${pull.base.ref}`);
  if (!baseTip) throw new Error('base branch not found');
  const message = `Merge pull request #${pull.number} from ${pull.head.ref}`;
  const sha = createCommitOp(a, repo.raw, headCommit.tree, [baseTip], message);
  callOp(a, 'setRef', [repo.raw, `refs/heads/${pull.base.ref}`, sha]);
  pullOverlay(a).set(pullKey(repo.owner, repo.name, pull.number), {
    baseSha: pull.base.sha, headSha: pull.head.sha,
    merged: true, mergedAt: FIXED_DATE, mergeSha: sha,
  });
  return { sha, merged: true, message: `Pull request #${pull.number} successfully merged` };
}

// -------------------------------------------------------------------------------------------
// REST shapes.
// -------------------------------------------------------------------------------------------

export function userJson(login: string): any {
  const u = USERS[login] ?? { login, id: stableId(`user:${login}`), name: login, email: `${login}@example.invalid`, type: 'User' };
  return {
    login: u.login,
    id: u.id,
    node_id: globalId('User', u.login),
    avatar_url: '',
    gravatar_id: '',
    url: `/api/v3/users/${u.login}`,
    html_url: `https://example.invalid/${u.login}`,
    type: u.type,
    site_admin: false,
    name: u.name,
    email: u.email,
    public_repos: 0,
    followers: 0,
    following: 0,
    created_at: FIXED_DATE,
    updated_at: FIXED_DATE,
  };
}

export function repoJson(a: AdaptedStore, repo: any): any {
  const overlay = repoOverlay(a).get(`${repo.owner}/${repo.name}`) ?? {};
  const description = overlay.description !== undefined ? overlay.description : repo.description;
  const isPrivate = overlay.private !== undefined ? overlay.private : repo.isPrivate;
  let openIssues = 0;
  try {
    const issues = callOp(a, 'listIssues', [repo.raw]);
    if (Array.isArray(issues)) openIssues = issues.filter((i: any) => String(i.state ?? 'open').toLowerCase() === 'open').length;
  } catch { openIssues = 0; }
  return {
    id: repo.id,
    node_id: globalId('Repository', `${repo.owner}/${repo.name}`),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: (USERS[repo.owner]?.id ?? stableId(`user:${repo.owner}`)), node_id: globalId('User', repo.owner), type: 'User', avatar_url: '', url: `/api/v3/users/${repo.owner}`, html_url: `https://example.invalid/${repo.owner}` },
    private: isPrivate,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    description,
    fork: false,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    archived: false,
    disabled: false,
    open_issues_count: openIssues,
    license: null,
    allow_forking: true,
    is_template: false,
    topics: [],
    visibility: isPrivate ? 'private' : 'public',
    forks: 0,
    open_issues: openIssues,
    watchers: 0,
    default_branch: repo.defaultBranch,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

export function issueJson(a: AdaptedStore, repo: any, issue: any, commentsCount?: number): any {
  let count = commentsCount;
  if (count === undefined) {
    try {
      const list = callOp(a, 'listComments', [repo.raw, issue.number]);
      count = Array.isArray(list) ? list.length : 0;
    } catch { count = issue.commentsCount ?? 0; }
  }
  return {
    id: issue.id,
    node_id: globalId('Issue', `${repo.owner}/${repo.name}#${issue.number}`),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User', node_id: globalId('User', VIEWER.login), avatar_url: '', url: `/api/v3/users/${VIEWER.login}` },
    labels: issue.labels.map((l: any) => ({
      id: l.id,
      node_id: globalId('Label', `${repo.owner}/${repo.name}:${l.name}`),
      url: `/api/v3/repos/${repo.owner}/${repo.name}/labels/${encodeURIComponent(l.name)}`,
      name: l.name,
      color: l.color,
      default: false,
      description: l.description ?? '',
    })),
    assignee: null,
    assignees: [],
    milestone: null,
    comments: count,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.state === 'closed' ? (issue.closedAt ?? issue.updatedAt) : null,
    author_association: 'OWNER',
    state_reason: null,
  };
}

export function commentJson(a: AdaptedStore, repo: any, issueNumber: number, comment: any): any {
  return {
    id: comment.id,
    node_id: globalId('IssueComment', `${repo.owner}/${repo.name}#${issueNumber}:${comment.id}`),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/comments/${comment.id}`,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issueNumber}#issuecomment-${comment.id}`,
    issue_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issueNumber}`,
    body: comment.body,
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User', node_id: globalId('User', VIEWER.login), avatar_url: '', url: `/api/v3/users/${VIEWER.login}` },
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    author_association: 'OWNER',
  };
}

export function labelJson(a: AdaptedStore, repo: any, label: any): any {
  return {
    id: label.id,
    node_id: globalId('Label', `${repo.owner}/${repo.name}:${label.name}`),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/labels/${encodeURIComponent(label.name)}`,
    name: label.name,
    color: label.color,
    default: false,
    description: label.description ?? '',
  };
}

export function pullJson(a: AdaptedStore, repo: any, pull: any): any {
  const mergedAt = pull.merged ? (pull.mergedAt ?? pull.updatedAt) : null;
  const mergeable = pull.merged ? true : (pull.mergeable !== undefined ? pull.mergeable : mergeableOf(a, repo.raw, pull));
  let additions = 0;
  let deletions = 0;
  let changedFiles = 0;
  try {
    const files = listPullFilesOp(a, repo.raw, pull);
    changedFiles = files.length;
    for (const f of files) { additions += f.additions; deletions += f.deletions; }
  } catch { /* counts stay zero */ }
  const side = (s: { ref: string; sha: string }): any => ({
    label: `${repo.owner}:${s.ref}`,
    ref: s.ref,
    sha: s.sha,
    user: { login: repo.owner, id: (USERS[repo.owner]?.id ?? stableId(`user:${repo.owner}`)), type: 'User', node_id: globalId('User', repo.owner), avatar_url: '', url: `/api/v3/users/${repo.owner}` },
    repo: { id: repo.id, name: repo.name, full_name: `${repo.owner}/${repo.name}` },
  });
  return {
    id: pull.id,
    node_id: globalId('PullRequest', `${repo.owner}/${repo.name}#${pull.number}`),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`,
    number: pull.number,
    state: pull.state,
    locked: false,
    title: pull.title,
    body: pull.body,
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User', node_id: globalId('User', VIEWER.login), avatar_url: '', url: `/api/v3/users/${VIEWER.login}` },
    labels: [],
    milestone: null,
    active_lock_reason: null,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? (pull.closedAt ?? pull.updatedAt) : null,
    merged_at: mergedAt,
    merge_commit_sha: pull.merged ? (pull.mergeCommitSha ?? null) : null,
    assignee: null,
    assignees: [],
    requested_reviewers: [],
    requested_teams: [],
    head: side(pull.head),
    base: side(pull.base),
    author_association: 'OWNER',
    auto_merge: null,
    draft: false,
    merged: pull.merged,
    mergeable,
    mergeable_state: pull.merged ? 'clean' : (mergeable === true ? 'clean' : (mergeable === false ? 'dirty' : 'unknown')),
    merged_by: null,
    comments: 0,
    review_comments: 0,
    commits: 1,
    additions,
    deletions,
    changed_files: changedFiles,
  };
}

export function commitJson(a: AdaptedStore, repo: any, commit: any): any {
  const parents = (commit.parents ?? []).map((sha: string) => ({ sha, url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}` }));
  return {
    sha: commit.sha,
    node_id: globalId('Commit', `${repo.owner}/${repo.name}:${commit.sha}`),
    commit: {
      author: { name: commit.author.name, email: commit.author.email, date: commit.author.date },
      committer: { name: commit.committer.name, email: commit.committer.email, date: commit.committer.date },
      message: commit.message,
      tree: { sha: commit.tree, url: `/api/v3/repos/${repo.owner}/${repo.name}/git/trees/${commit.tree}` },
      url: `/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${commit.sha}`,
      comment_count: 0,
      verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
    },
    url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${commit.sha}`,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/commit/${commit.sha}`,
    comments_url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${commit.sha}/comments`,
    author: { login: VIEWER.login, id: VIEWER.id, type: 'User', node_id: globalId('User', VIEWER.login), avatar_url: '', url: `/api/v3/users/${VIEWER.login}` },
    committer: { login: VIEWER.login, id: VIEWER.id, type: 'User', node_id: globalId('User', VIEWER.login), avatar_url: '', url: `/api/v3/users/${VIEWER.login}` },
    parents,
  };
}

export function contentFileJson(repo: any, path: string, entry: { data: Buffer; oid: string }): any {
  const name = path.split('/').filter((p) => p !== '').pop() ?? path;
  return {
    type: 'file',
    encoding: 'base64',
    size: entry.data.length,
    name,
    path,
    content: b64encode(entry.data),
    sha: entry.oid,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
    git_url: `/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${entry.oid}`,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/blob/HEAD/${path}`,
    download_url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
    _links: { git: `/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${entry.oid}`, self: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`, html: `https://example.invalid/${repo.owner}/${repo.name}/blob/HEAD/${path}` },
  };
}

export function contentDirJson(repo: any, entries: { name: string; path: string; type: string; sha: string; size: number }[]): any[] {
  return entries.map((e) => ({
    type: e.type,
    size: e.size,
    name: e.name,
    path: e.path,
    sha: e.sha,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${e.path}`,
    git_url: `/api/v3/repos/${repo.owner}/${repo.name}/git/${e.type === 'dir' ? 'trees' : 'blobs'}/${e.sha}`,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/${e.type === 'dir' ? 'tree' : 'blob'}/HEAD/${e.path}`,
    download_url: e.type === 'file' ? `/api/v3/repos/${repo.owner}/${repo.name}/contents/${e.path}` : null,
    _links: { git: `/api/v3/repos/${repo.owner}/${repo.name}/git/${e.type === 'dir' ? 'trees' : 'blobs'}/${e.sha}`, self: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${e.path}`, html: `https://example.invalid/${repo.owner}/${repo.name}/${e.type === 'dir' ? 'tree' : 'blob'}/HEAD/${e.path}` },
  }));
}

// -------------------------------------------------------------------------------------------
// Dispatch: dispatchRest(store, method, segments, query, auth, rawBody)
// -------------------------------------------------------------------------------------------

type Resp = { status: number; headers: Record<string, string>; body: string };

function parseBody(rawBody: unknown): { ok: boolean; value: any } {
  if (rawBody === null || rawBody === undefined || rawBody === '') return { ok: true, value: {} };
  if (typeof rawBody !== 'string') {
    if (typeof Buffer !== 'undefined' && Buffer.isBuffer(rawBody)) {
      const text = rawBody.toString('utf8');
      if (text === '') return { ok: true, value: {} };
      try {
        return { ok: true, value: JSON.parse(text) };
      } catch {
        return { ok: false, value: null };
      }
    }
    return { ok: true, value: rawBody };
  }
  try {
    return { ok: true, value: JSON.parse(rawBody) };
  } catch {
    return { ok: false, value: null };
  }
}

/** Load the viewer's repository, or null (404: absent, or under another owner). */
function loadViewerRepo(a: AdaptedStore, owner: string, name: string): any {
  if (owner !== VIEWER.login) return null;
  const raw = getRepoRaw(a, owner, name);
  if (!raw) return null;
  const repo = normRepo(raw, owner);
  const overlay = repoOverlay(a).get(`${owner}/${name}`);
  if (overlay) {
    if (overlay.description !== undefined) repo.description = overlay.description;
    if (overlay.private !== undefined) repo.isPrivate = overlay.private;
  }
  return repo;
}

function basePathOf(segments: string[]): string {
  return `/api/v3/${segments.map((s) => encodeURIComponent(s)).join('/')}`;
}

export function dispatchRest(store: any, method: string, segments: string[], query: Record<string, unknown>, auth: unknown, rawBody: unknown): Resp {
  const a = adaptStore(store);
  const m = String(method).toUpperCase();
  const segs = segments.filter((s) => s !== '');

  if (!isViewer(auth)) return errResp(401, 'Requires authentication');

  const needsBody = m === 'POST' || m === 'PATCH' || m === 'PUT' || m === 'DELETE';
  let body: any = {};
  if (needsBody) {
    const parsed = parseBody(rawBody);
    if (!parsed.ok) return errResp(400, 'Problems parsing JSON');
    body = parsed.value ?? {};
    if (body === null || typeof body !== 'object' || Array.isArray(body)) body = {};
  }

  // API root.
  if (segs.length === 0) {
    if (m !== 'GET') return errResp(404, 'Not Found');
    return jsonResp(200, {
      current_user_url: '/api/v3/user',
      current_user_authorizations_html_url: 'https://example.invalid/settings/applications',
      authorizations_url: '/api/v3/authorizations',
      code_search_url: '/api/v3/search/code?q={query}{&page,per_page,sort,order}',
      commit_search_url: '/api/v3/search/commits?q={query}{&page,per_page,sort,order}',
      emails_url: '/api/v3/user/emails',
      emojis_url: '/api/v3/emojis',
      events_url: '/api/v3/events',
      feeds_url: '/api/v3/feeds',
      following_url: '/api/v3/user/following{/target}',
      gists_url: '/api/v3/gists{/gist_id}',
      hub_url: 'https://api.github.com/hub',
      issue_search_url: '/api/v3/search/issues?q={query}{&page,per_page,sort,order}',
      issues_url: '/api/v3/issues',
      keys_url: '/api/v3/user/keys',
      label_search_url: '/api/v3/search/labels?q={query}&repository_id={repository_id}{&page,per_page}',
      notifications_url: '/api/v3/notifications',
      organization_url: '/api/v3/orgs/{org}',
      organization_repositories_url: '/api/v3/orgs/{org}/repos{?type,page,per_page,sort}',
      public_gists_url: '/api/v3/gists/public',
      rate_limit_url: '/api/v3/rate_limit',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      repository_search_url: '/api/v3/search/repositories?q={query}{&page,per_page,sort,order}',
      current_user_repositories_url: '/api/v3/user/repos{?type,page,per_page,sort}',
      starred_url: '/api/v3/user/starred{/owner}{/repo}',
      starred_gists_url: '/api/v3/gists/starred',
      topic_search_url: '/api/v3/search/topics?q={query}{&page,per_page}',
      user_url: '/api/v3/users/{user}',
      user_organizations_url: '/api/v3/user/orgs',
      user_repositories_url: '/api/v3/user/repos{?type,page,per_page,sort}',
      user_search_url: '/api/v3/search/users?q={query}{&page,per_page,sort,order}',
    });
  }

  // GET /api/v3/meta
  if (segs.length === 1 && segs[0] === 'meta') {
    if (m !== 'GET') return errResp(404, 'Not Found');
    return jsonResp(200, { installed_version: '1.0.0', verifiable_password_authentication: true, github_services_sha: '0000000000000000000000000000000000000000', hooks: [], git: [], pages: [], importer: [], wiki: [], pull_request: [] });
  }

  // GET /api/v3/user and /user/repos
  if (segs[0] === 'user') {
    if (segs.length === 1) {
      if (m !== 'GET') return errResp(404, 'Not Found');
      return jsonResp(200, userJson(VIEWER.login));
    }
    if (segs.length === 2 && segs[1] === 'repos') {
      if (m === 'GET') {
        const repos = listReposRaw(a, VIEWER.login).map((r: any) => normRepo(r, VIEWER.login)).filter(Boolean);
        const { items, headers } = paginate(repos, query, basePathOf(segs));
        return jsonResp(200, items.map((r: any) => repoJson(a, r)), headers);
      }
      if (m === 'POST') {
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        if (name === '') return errResp(422, 'name is required');
        if (getRepoRaw(a, VIEWER.login, name)) return errResp(422, 'Repository already exists');
        const description = typeof body.description === 'string' ? body.description : null;
        const isPrivate = body.private === true;
        let raw: any;
        try {
          raw = callOp(a, 'createRepo', [VIEWER.login, name, description, isPrivate]);
        } catch (err) {
          return errResp(422, err instanceof Error ? err.message : 'could not create repository');
        }
        if (!raw) return errResp(422, 'Repository already exists');
        const repo = normRepo(raw, VIEWER.login);
        return jsonResp(201, repoJson(a, repo));
      }
      return errResp(404, 'Not Found');
    }
    return errResp(404, 'Not Found');
  }

  // GET /api/v3/users/{login}
  if (segs[0] === 'users' && segs.length === 2) {
    if (m !== 'GET') return errResp(404, 'Not Found');
    const login = decodeURIComponent(segs[1] ?? '');
    if (!USERS[login]) return errResp(404, 'Not Found');
    return jsonResp(200, userJson(login));
  }

  // /repos/{owner}/{repo}/...
  if (segs[0] === 'repos' && segs.length >= 3) {
    const owner = decodeURIComponent(segs[1] ?? '');
    const repoName = decodeURIComponent(segs[2] ?? '');
    const rest = segs.slice(3);
    const repo = loadViewerRepo(a, owner, repoName);
    if (!repo) return errResp(404, 'Not Found');

    // /repos/{o}/{r} itself
    if (rest.length === 0) {
      if (m === 'GET') return jsonResp(200, repoJson(a, repo));
      if (m === 'PATCH') {
        const overlay = repoOverlay(a);
        const key = `${owner}/${repoName}`;
        const entry = overlay.get(key) ?? {};
        if (typeof body.description === 'string') entry.description = body.description;
        if (body.description === null) entry.description = null;
        if (typeof body.private === 'boolean') entry.private = body.private;
        overlay.set(key, entry);
        if (typeof body.description === 'string' || body.description === null) repo.description = body.description;
        if (typeof body.private === 'boolean') repo.isPrivate = body.private;
        return jsonResp(200, repoJson(a, repo));
      }
      if (m === 'DELETE') {
        try { callOp(a, 'deleteRepo', [owner, repoName]); } catch { /* already gone */ }
        repoOverlay(a).delete(`${owner}/${repoName}`);
        return { status: 204, headers: { 'content-type': 'application/json; charset=utf-8', 'x-github-request-id': nextRequestId('rest'), 'x-oauth-scopes': 'repo, read:org' }, body: '' };
      }
      return errResp(404, 'Not Found');
    }

    // branches
    if (rest[0] === 'branches') {
      if (m !== 'GET') return errResp(404, 'Not Found');
      const branches = listBranchesOp(a, repo.raw);
      if (rest.length === 1) {
        return jsonResp(200, branches.map((b) => ({ name: b.name, commit: { sha: b.sha, url: `/api/v3/repos/${owner}/${repoName}/commits/${b.sha}` }, protected: false })));
      }
      const branchName = rest.slice(1).map((s) => decodeURIComponent(s)).join('/');
      const found = branches.find((b) => b.name === branchName);
      if (!found) return errResp(404, 'Not Found');
      return jsonResp(200, { name: found.name, commit: { sha: found.sha, url: `/api/v3/repos/${owner}/${repoName}/commits/${found.sha}` }, protected: false });
    }

    // commits
    if (rest[0] === 'commits') {
      if (m !== 'GET') return errResp(404, 'Not Found');
      if (rest.length === 1) {
        const ref = qstr(query, 'sha', repo.defaultBranch);
        const commits = listCommitsOp(a, repo.raw, ref);
        const { items, headers } = paginate(commits, query, basePathOf(segs));
        return jsonResp(200, items.map((c: any) => commitJson(a, repo, c)), headers);
      }
      const sha = rest.slice(1).map((s) => decodeURIComponent(s)).join('/');
      const tip = resolveRefOp(a, repo.raw, `refs/heads/${sha}`);
      if (tip) {
        const commit = readCommitOp(a, repo.raw, tip);
        if (commit) return jsonResp(200, commitJson(a, repo, { sha: tip, ...commit }));
      }
      const commits = listCommitsOp(a, repo.raw, repo.defaultBranch);
      const found = commits.find((c: any) => c.sha === sha || (typeof c.sha === 'string' && c.sha.startsWith(sha)));
      if (!found) return errResp(404, 'Not Found');
      return jsonResp(200, commitJson(a, repo, found));
    }

    // contents
    if (rest[0] === 'contents') {
      const filePath = rest.slice(1).map((s) => decodeURIComponent(s)).join('/');
      const ref = qstr(query, 'ref', repo.defaultBranch);
      if (m === 'GET') {
        if (filePath === '') {
          const dir = readDirOp(a, repo.raw, ref, '');
          if (dir === null) return errResp(404, 'Not Found');
          return jsonResp(200, contentDirJson(repo, dir));
        }
        const file = readFileOp(a, repo.raw, ref, filePath);
        if (file) return jsonResp(200, contentFileJson(repo, filePath, file));
        const dir = readDirOp(a, repo.raw, ref, filePath);
        if (dir !== null) return jsonResp(200, contentDirJson(repo, dir));
        return errResp(404, 'Not Found');
      }
      if (m === 'PUT') {
        if (typeof body.content !== 'string' || body.content === '') return errResp(422, 'content is required');
        const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
        const data = b64decode(body.content);
        const current = readFileOp(a, repo.raw, branch, filePath);
        if (typeof body.sha === 'string' && body.sha !== '' && current && body.sha.toLowerCase() !== current.oid.toLowerCase()) {
          return errResp(409, 'sha does not match the current blob');
        }
        let out: { commitSha: string; blobSha: string };
        try {
          out = putFileOp(a, repo.raw, branch, filePath, data, typeof body.message === 'string' ? body.message : 'update');
        } catch (err) {
          return errResp(422, err instanceof Error ? err.message : 'could not write file');
        }
        const entry = contentFileJson(repo, filePath, { data, oid: out.blobSha });
        return jsonResp(current ? 200 : 201, {
          content: entry,
          commit: { sha: out.commitSha, message: typeof body.message === 'string' ? body.message : 'update', url: `/api/v3/repos/${owner}/${repoName}/commits/${out.commitSha}` },
        });
      }
      if (m === 'DELETE') {
        const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
        const current = readFileOp(a, repo.raw, branch, filePath);
        if (!current) return errResp(404, 'Not Found');
        if (typeof body.sha === 'string' && body.sha !== '' && body.sha.toLowerCase() !== current.oid.toLowerCase()) {
          return errResp(409, 'sha does not match the current blob');
        }
        let out: { commitSha: string };
        try {
          out = deleteFileOp(a, repo.raw, branch, filePath, typeof body.message === 'string' ? body.message : 'delete');
        } catch (err) {
          return errResp(422, err instanceof Error ? err.message : 'could not delete file');
        }
        return jsonResp(200, { commit: { sha: out.commitSha, message: typeof body.message === 'string' ? body.message : 'delete', url: `/api/v3/repos/${owner}/${repoName}/commits/${out.commitSha}` }, content: null });
      }
      return errResp(404, 'Not Found');
    }

    // git refs
    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (m === 'POST' && rest.length === 2) {
        const ref = typeof body.ref === 'string' ? body.ref : '';
        const sha = typeof body.sha === 'string' ? body.sha : '';
        if (ref === '' || sha === '') return errResp(422, 'ref and sha are required');
        if (resolveRefOp(a, repo.raw, ref)) return errResp(422, 'Reference already exists');
        try {
          callOp(a, 'setRef', [repo.raw, ref, sha]);
        } catch (err) {
          return errResp(422, err instanceof Error ? err.message : 'could not create ref');
        }
        return jsonResp(201, { ref, node_id: globalId('Ref', `${owner}/${repoName}:${ref}`), url: `/api/v3/repos/${owner}/${repoName}/git/refs/${ref.replace(/^refs\//, '')}`, object: { sha, type: 'commit', url: `/api/v3/repos/${owner}/${repoName}/git/commits/${sha}` } });
      }
      if (m === 'GET') {
        if (rest.length === 2) {
          const refs = listBranchesOp(a, repo.raw).map((b) => ({ ref: `refs/heads/${b.name}`, node_id: globalId('Ref', `${owner}/${repoName}:refs/heads/${b.name}`), url: `/api/v3/repos/${owner}/${repoName}/git/refs/heads/${b.name}`, object: { sha: b.sha, type: 'commit', url: `/api/v3/repos/${owner}/${repoName}/git/commits/${b.sha}` } }));
          return jsonResp(200, refs);
        }
        const refName = rest.slice(2).map((s) => decodeURIComponent(s)).join('/');
        const fullRef = `refs/${refName}`;
        const oid = resolveRefOp(a, repo.raw, fullRef);
        if (!oid) return errResp(404, 'Not Found');
        return jsonResp(200, { ref: fullRef, node_id: globalId('Ref', `${owner}/${repoName}:${fullRef}`), url: `/api/v3/repos/${owner}/${repoName}/git/refs/${refName}`, object: { sha: oid, type: 'commit', url: `/api/v3/repos/${owner}/${repoName}/git/commits/${oid}` } });
      }
      return errResp(404, 'Not Found');
    }

    // issues
    if (rest[0] === 'issues') {
      if (rest.length === 1) {
        if (m === 'GET') {
          let issues: any[] = [];
          try {
            const raw = callOp(a, 'listIssues', [repo.raw]);
            if (Array.isArray(raw)) issues = raw.map((i: any) => normIssue(i, repo)).filter(Boolean);
          } catch { issues = []; }
          const state = qstr(query, 'state', 'open').toLowerCase();
          if (state === 'open' || state === 'closed') issues = issues.filter((i) => i.state === state);
          const sort = qstr(query, 'sort', 'created');
          const direction = qstr(query, 'direction', 'desc').toLowerCase();
          if (sort === 'created') issues.sort((x, y) => (direction === 'asc' ? x.number - y.number : y.number - x.number));
          const { items, headers } = paginate(issues, query, basePathOf(segs));
          return jsonResp(200, items.map((i: any) => issueJson(a, repo, i)), headers);
        }
        if (m === 'POST') {
          const title = typeof body.title === 'string' ? body.title : '';
          if (title === '') return errResp(422, 'title is required');
          const labelNames: string[] = Array.isArray(body.labels) ? body.labels.map((l: any) => (typeof l === 'string' ? l : l?.name)).filter((n: any) => typeof n === 'string' && n !== '') : [];
          if (labelNames.length > 0) {
            let known: string[] = [];
            try {
              const raw = callOp(a, 'listLabels', [repo.raw]);
              if (Array.isArray(raw)) known = raw.map((l: any) => normLabel(l).name);
            } catch { known = []; }
            const bad = labelNames.find((n) => !known.includes(n));
            if (bad !== undefined) return errResp(422, `Label "${bad}" does not exist`);
          }
          let created: any;
          try {
            created = createIssueOp(a, repo.raw, title, typeof body.body === 'string' ? body.body : '', labelNames);
          } catch (err) {
            return errResp(422, err instanceof Error ? err.message : 'could not create issue');
          }
          if (!created) return errResp(422, 'could not create issue');
          return jsonResp(201, issueJson(a, repo, normIssue(created, repo)));
        }
        return errResp(404, 'Not Found');
      }
      const issueNumber = parseInt(rest[1] ?? '', 10);
      if (!Number.isInteger(issueNumber) || issueNumber < 1) return errResp(404, 'Not Found');
      if (rest.length === 3 && rest[2] === 'comments') {
        if (m === 'GET') {
          let comments: any[] = [];
          try {
            const raw = callOp(a, 'listComments', [repo.raw, issueNumber]);
            if (Array.isArray(raw)) comments = raw.map((c: any, i: number) => normComment(c, repo, issueNumber, i)).filter(Boolean);
          } catch { comments = []; }
          const { items, headers } = paginate(comments, query, basePathOf(segs));
          return jsonResp(200, items.map((c: any) => commentJson(a, repo, issueNumber, c)), headers);
        }
        if (m === 'POST') {
          if (typeof body.body !== 'string' || body.body === '') return errResp(422, 'body is required');
          let created: any;
          try {
            created = callOp(a, 'addComment', [repo.raw, issueNumber, body.body]);
          } catch (err) {
            return errResp(422, err instanceof Error ? err.message : 'could not create comment');
          }
          if (!created) return errResp(422, 'could not create comment');
          return jsonResp(201, commentJson(a, repo, issueNumber, normComment(created, repo, issueNumber, 0)));
        }
        return errResp(404, 'Not Found');
      }
      if (rest.length === 2) {
        let issue: any = null;
        try {
          const raw = callOp(a, 'getIssue', [repo.raw, issueNumber]);
          if (raw) issue = normIssue(raw, repo);
        } catch { issue = null; }
        if (!issue) return errResp(404, 'Not Found');
        if (m === 'GET') return jsonResp(200, issueJson(a, repo, issue));
        if (m === 'PATCH') {
          const patch: Record<string, any> = {};
          if (typeof body.state === 'string' && (body.state === 'open' || body.state === 'closed')) patch.state = body.state;
          if (typeof body.title === 'string') patch.title = body.title;
          if (typeof body.body === 'string') patch.body = body.body;
          let updated: any;
          try {
            updated = callOp(a, 'updateIssue', [repo.raw, issueNumber, patch]);
          } catch (err) {
            return errResp(422, err instanceof Error ? err.message : 'could not update issue');
          }
          const next = updated ? normIssue(updated, repo) : { ...issue, ...patch };
          return jsonResp(200, issueJson(a, repo, next));
        }
        return errResp(404, 'Not Found');
      }
      return errResp(404, 'Not Found');
    }

    // labels
    if (rest[0] === 'labels') {
      if (m === 'GET' && rest.length === 1) {
        let labels: any[] = [];
        try {
          const raw = callOp(a, 'listLabels', [repo.raw]);
          if (Array.isArray(raw)) labels = raw.map(normLabel);
        } catch { labels = []; }
        return jsonResp(200, labels.map((l: any) => labelJson(a, repo, l)));
      }
      if (m === 'POST' && rest.length === 1) {
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        if (name === '') return errResp(422, 'name is required');
        const color = typeof body.color === 'string' && body.color !== '' ? body.color.replace(/^#/, '') : 'ededed';
        try {
          const existing = callOp(a, 'listLabels', [repo.raw]);
          if (Array.isArray(existing) && existing.some((l: any) => normLabel(l).name === name)) {
            return errResp(422, 'Label already exists');
          }
        } catch { /* the create below reports the failure */ }
        let created: any;
        try {
          created = callOp(a, 'createLabel', [repo.raw, name, color]);
        } catch (err) {
          return errResp(422, err instanceof Error ? err.message : 'could not create label');
        }
        if (!created) return errResp(422, 'Label already exists');
        return jsonResp(201, labelJson(a, repo, normLabel(created)));
      }
      return errResp(404, 'Not Found');
    }

    // pulls
    if (rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (m === 'GET') {
          let pulls = listPullsOp(a, repo);
          const state = qstr(query, 'state', 'open').toLowerCase();
          if (state === 'open' || state === 'closed') pulls = pulls.filter((p) => p.state === state);
          pulls.sort((x, y) => y.number - x.number);
          const { items, headers } = paginate(pulls, query, basePathOf(segs));
          return jsonResp(200, items.map((p: any) => pullJson(a, repo, p)), headers);
        }
        if (m === 'POST') {
          const head = typeof body.head === 'string' ? body.head : '';
          const base = typeof body.base === 'string' ? body.base : repo.defaultBranch;
          const title = typeof body.title === 'string' ? body.title : '';
          if (head === '' || title === '') return errResp(422, 'head and title are required');
          const headSha = resolveRefOp(a, repo.raw, `refs/heads/${head}`);
          const baseSha = resolveRefOp(a, repo.raw, `refs/heads/${base}`);
          if (!headSha || !baseSha) return errResp(422, 'head or base branch not found');
          if (headSha === baseSha) return errResp(422, 'No commits between head and base');
          let pull: any;
          try {
            pull = createPullOp(a, repo, head, base, title, typeof body.body === 'string' ? body.body : '');
          } catch (err) {
            return errResp(422, err instanceof Error ? err.message : 'could not create pull request');
          }
          return jsonResp(201, pullJson(a, repo, pull));
        }
        return errResp(404, 'Not Found');
      }
      const pullNumber = parseInt(rest[1] ?? '', 10);
      if (!Number.isInteger(pullNumber) || pullNumber < 1) return errResp(404, 'Not Found');
      if (rest.length === 3 && rest[2] === 'files') {
        if (m !== 'GET') return errResp(404, 'Not Found');
        const pull = getPullOp(a, repo, pullNumber);
        if (!pull) return errResp(404, 'Not Found');
        const files = listPullFilesOp(a, repo.raw, pull);
        return jsonResp(200, files.map((f) => ({ filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, changes: f.changes, sha: '', patch: '' })));
      }
      if (rest.length === 3 && rest[2] === 'merge') {
        if (m !== 'PUT') return errResp(404, 'Not Found');
        const pull = getPullOp(a, repo, pullNumber);
        if (!pull) return errResp(404, 'Not Found');
        const mergeMethod = typeof body.merge_method === 'string' ? body.merge_method : 'squash';
        if (mergeMethod !== 'squash') return errResp(405, 'Only the squash merge method is supported');
        if (pull.merged) return errResp(405, 'Pull request is already merged');
        try {
          const merged = mergePullOp(a, repo, pull, 'squash');
          return jsonResp(200, { sha: merged.sha, merged: true, message: merged.message });
        } catch (err) {
          if (err instanceof Error && /conflict/i.test(err.message)) return errResp(405, 'Merge conflict');
          return errResp(422, err instanceof Error ? err.message : 'could not merge pull request');
        }
      }
      if (rest.length === 2) {
        if (m !== 'GET') return errResp(404, 'Not Found');
        const pull = getPullOp(a, repo, pullNumber);
        if (!pull) return errResp(404, 'Not Found');
        return jsonResp(200, pullJson(a, repo, pull));
      }
      return errResp(404, 'Not Found');
    }

    return errResp(404, 'Not Found');
  }

  return errResp(404, 'Not Found');
}
