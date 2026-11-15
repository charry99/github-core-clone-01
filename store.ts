/**
 * store.ts — the forge's in-memory store.
 *
 * Everything lives in memory: repositories, git objects, refs, issues, pull
 * requests, labels and comments, plus the fixed user records from the kit's
 * deterministic scenario. No disk writes, no wall-clock time, no randomness:
 * counters are sequential integers and every derived value is a pure function
 * of its inputs, so two runs produce byte-identical objects.
 *
 * Node 22, TypeScript with type stripping, node built-ins only (node:crypto
 * for SHA-1). No enums, no parameter properties, no namespaces.
 */

import { createHash } from 'node:crypto';

export const ZERO_OID = '0'.repeat(40);
export const VIEWER_LOGIN = 'adaiversen';
export const TEAMMATE_LOGIN = 'quinnkeller';
export const STRANGER_LOGIN = 'olgabauer';
export const ORG_LOGIN = 'faint-meadow-org';
/** The one identity every commit the entry itself creates carries. */
export const FIXED_IDENTITY = 'Conformance <conformance@make.fun>';
/** The one timestamp every commit the entry itself creates carries. */
export const FIXED_TIMESTAMP = 1700000000;
export const FIXED_TIMEZONE = '+0000';
export const FIXED_CREATED_AT = '2025-01-01T00:00:00Z';
export const FIXED_MERGED_AT = '2025-01-01T00:00:00Z';

export type GitObjectKind = 'blob' | 'tree' | 'commit' | 'tag';
export type UserType = 'User' | 'Organization';
export type IssueState = 'open' | 'closed';

export interface UserRecord {
  id: number;
  login: string;
  name: string;
  email: string;
  type: UserType;
}

/** The fixed users of the kit's deterministic scenario. */
export const USERS: readonly UserRecord[] = [
  { id: 1000, login: 'adaiversen', name: 'ada iversen', email: 'adaiversen@example.invalid', type: 'User' },
  { id: 1001, login: 'quinnkeller', name: 'quinn keller', email: 'quinnkeller@example.invalid', type: 'User' },
  { id: 1002, login: 'olgabauer', name: 'olga bauer', email: 'olgabauer@example.invalid', type: 'User' },
];

const USER_BY_LOGIN = new Map<string, UserRecord>(USERS.map((user) => [user.login, user]));

export function getUserByLogin(login: string): UserRecord | null {
  return USER_BY_LOGIN.get(login) ?? null;
}

export function getViewer(): UserRecord {
  return USER_BY_LOGIN.get(VIEWER_LOGIN) as UserRecord;
}

export interface GitObjectRecord {
  kind: GitObjectKind;
  data: Buffer;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export interface TagView {
  object: string;
  type: GitObjectKind;
  tag: string;
  tagger: string;
  message: string;
}

export interface CommentRecord {
  id: number;
  body: string;
  author: string;
  createdAt: string;
}

export interface IssueRecord {
  number: number;
  title: string;
  body: string;
  state: IssueState;
  labels: string[];
  comments: CommentRecord[];
  createdAt: string;
  updatedAt: string;
}

export interface PullRecord {
  number: number;
  title: string;
  body: string;
  state: IssueState;
  head: string;
  base: string;
  headSha: string | null;
  baseSha: string | null;
  merged: boolean;
  mergeCommitSha: string | null;
  mergedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PullFile {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
}

export interface BranchInfo {
  name: string;
  oid: string;
}

export interface RefInfo {
  name: string;
  oid: string;
}

export interface PathEntry {
  name: string;
  kind: 'blob' | 'tree' | 'commit';
  mode: string;
  oid: string;
}

export type PathReadResult =
  | { type: 'blob'; data: Buffer; oid: string; mode: string }
  | { type: 'tree'; entries: PathEntry[]; oid: string };

export interface RepoRecord {
  owner: string;
  name: string;
  fullName: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  createdIndex: number;
  objects: Map<string, GitObjectRecord>;
  refs: Map<string, string>;
  issues: IssueRecord[];
  pullRequests: PullRecord[];
  labels: string[];
  nextIssueNumber: number;
  nextPullNumber: number;
  nextCommentId: number;
}

// ---------------------------------------------------------------------------------------------
// pure object helpers (no store needed)
// ---------------------------------------------------------------------------------------------

/** git's object id: SHA-1 over `<kind> <size>\0` + the object's bytes. */
export function hashObject(kind: GitObjectKind, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(Buffer.from(kind + ' ' + String(data.length) + '\0', 'utf8'));
  hash.update(data);
  return hash.digest('hex');
}

/** git's tree-entry sort: byte order of the name, a directory compared as if it ended in '/'. */
export function compareTreeEntries(a: TreeEntry, b: TreeEntry): number {
  const left = Buffer.from(a.mode === '40000' ? a.name + '/' : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? b.name + '/' : b.name, 'utf8');
  return Buffer.compare(left, right);
}

/** Build a tree object's bytes from entries; entries are sorted the way git sorts them. */
export function buildTreeBytes(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeEntries);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(entry.mode + ' ' + entry.name + '\0', 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface BuildCommitFields {
  tree: string;
  parents?: readonly string[];
  author?: string;
  committer?: string;
  message: string;
  timestamp?: number;
  timezone?: string;
}

/** Build a commit object's bytes. Author/committer/timestamp default to the fixed identity. */
export function buildCommitBytes(fields: BuildCommitFields): Buffer {
  const timestamp = fields.timestamp ?? FIXED_TIMESTAMP;
  const timezone = fields.timezone ?? FIXED_TIMEZONE;
  const author = fields.author ?? FIXED_IDENTITY;
  const committer = fields.committer ?? FIXED_IDENTITY;
  const lines: string[] = ['tree ' + fields.tree];
  for (const parent of fields.parents ?? []) lines.push('parent ' + parent);
  lines.push('author ' + author + ' ' + String(timestamp) + ' ' + timezone);
  lines.push('committer ' + committer + ' ' + String(timestamp) + ' ' + timezone);
  lines.push('');
  return Buffer.from(lines.join('\n') + '\n' + fields.message, 'utf8');
}

/** Parse a tree object into its entries, in the object's stored order. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('malformed tree entry: no mode separator');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0) throw new Error('malformed tree entry: no name terminator');
    if (nul + 21 > data.length) throw new Error('malformed tree entry: truncated object id');
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

/** Parse a commit object. */
export function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headerText = data.subarray(0, headerEnd).toString('utf8');
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of headerText.split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  return { tree, parents, author, committer, message };
}

/** Parse an annotated tag object. */
export function parseTag(data: Buffer): TagView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headers = new Map<string, string>();
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space < 0) continue;
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  const type = headers.get('type') ?? '';
  const tagType: GitObjectKind = type === 'commit' || type === 'tree' || type === 'blob' || type === 'tag' ? type : 'commit';
  return {
    object: headers.get('object') ?? '',
    type: tagType,
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8'),
  };
}

// ---------------------------------------------------------------------------------------------
// line diff (for pull files)
// ---------------------------------------------------------------------------------------------

function splitLines(data: Buffer | null): string[] {
  if (!data) return [];
  const text = data.toString('utf8');
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Added/deleted line counts between two versions, via longest-common-subsequence. */
export function diffLineCounts(oldData: Buffer | null, newData: Buffer | null): { additions: number; deletions: number } {
  const oldLines = splitLines(oldData);
  const newLines = splitLines(newData);
  const n = oldLines.length;
  const m = newLines.length;
  if (n * m > 4000000) return { additions: m, deletions: n };
  let prev: number[] = new Array<number>(m + 1).fill(0);
  let cur: number[] = new Array<number>(m + 1).fill(0);
  for (let i = 1; i <= n; i += 1) {
    cur[0] = 0;
    for (let j = 1; j <= m; j += 1) {
      cur[j] = oldLines[i - 1] === newLines[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    const tmp = prev;
    prev = cur;
    cur = tmp;
  }
  const lcs = prev[m];
  return { additions: m - lcs, deletions: n - lcs };
}

// ---------------------------------------------------------------------------------------------
// walk options
// ---------------------------------------------------------------------------------------------

export interface WalkOptions {
  /** Oids the walker already holds: their closure is excluded from the result. */
  exclude?: Iterable<string>;
  /** Maximum commit generation depth (tips are depth 1). Unset means unlimited. */
  depth?: number;
  /** Shallow boundaries: walking from an excluded tip stops at these commits. */
  shallowBoundaries?: Iterable<string>;
}

export interface WalkResult {
  /** Reachable object oids, sorted for determinism. */
  oids: string[];
  /** Commits at the depth boundary, sorted. */
  shallow: string[];
  /** Every commit the walk visited (including held shallow tips it walked through). */
  visitedCommits: string[];
}

export interface ListIssuesOptions {
  state?: IssueState | 'all';
  direction?: 'asc' | 'desc';
}

export interface ListPullsOptions {
  state?: IssueState | 'all';
}

export interface CreateIssueFields {
  title: string;
  body: string;
  labels?: readonly string[];
}

export interface PatchIssueFields {
  state?: IssueState;
  title?: string;
  body?: string;
}

export interface CreatePullFields {
  head: string;
  base: string;
  title: string;
  body: string;
}

export interface MergeOptions {
  message?: string;
}

export interface ContentsChangeResult {
  commit: string;
  blob: string;
}

export interface ContentsDeleteResult {
  commit: string;
}

export interface MergeableCheck {
  mergeable: boolean;
  conflictPath?: string;
}

export interface Store {
  users: readonly UserRecord[];
  viewer: UserRecord;
  createRepo(owner: string, name: string, description: string, isPrivate: boolean): RepoRecord;
  getRepo(owner: string, name: string): RepoRecord | null;
  listReposByOwner(owner: string): RepoRecord[];
  deleteRepo(owner: string, name: string): boolean;
  putObject(repo: RepoRecord, kind: GitObjectKind, data: Buffer): string;
  getObject(repo: RepoRecord, oid: string): GitObjectRecord | null;
  hasObject(repo: RepoRecord, oid: string): boolean;
  listRefs(repo: RepoRecord, prefix?: string): RefInfo[];
  getRef(repo: RepoRecord, name: string): string | null;
  setRef(repo: RepoRecord, name: string, oid: string): void;
  createRef(repo: RepoRecord, name: string, oid: string): void;
  deleteRef(repo: RepoRecord, name: string): boolean;
  resolveRef(repo: RepoRecord, name: string): string | null;
  walkObjects(repo: RepoRecord, tips: Iterable<string>, options?: WalkOptions): WalkResult;
  buildBlob(repo: RepoRecord, data: Buffer): string;
  buildTree(repo: RepoRecord, entries: readonly TreeEntry[]): string;
  buildCommit(repo: RepoRecord, fields: BuildCommitFields): string;
  applyContentsChange(repo: RepoRecord, branch: string, path: string, data: Buffer, message: string): ContentsChangeResult;
  applyContentsDelete(repo: RepoRecord, branch: string, path: string, message: string): ContentsDeleteResult;
  readPathAtRef(repo: RepoRecord, ref: string, path: string): PathReadResult | null;
  createIssue(repo: RepoRecord, fields: CreateIssueFields): IssueRecord;
  listIssues(repo: RepoRecord, options?: ListIssuesOptions): IssueRecord[];
  getIssue(repo: RepoRecord, number: number): IssueRecord | null;
  patchIssue(repo: RepoRecord, number: number, fields: PatchIssueFields): IssueRecord | null;
  createComment(repo: RepoRecord, issueNumber: number, body: string, author?: string): CommentRecord;
  listComments(repo: RepoRecord, issueNumber: number): CommentRecord[];
  createLabel(repo: RepoRecord, name: string): string;
  listLabels(repo: RepoRecord): string[];
  createPull(repo: RepoRecord, fields: CreatePullFields): PullRecord;
  getPull(repo: RepoRecord, number: number): PullRecord | null;
  listPulls(repo: RepoRecord, options?: ListPullsOptions): PullRecord[];
  listPullFiles(repo: RepoRecord, number: number): PullFile[];
  findMergeBase(repo: RepoRecord, a: string, b: string): string | null;
  checkPullMergeable(repo: RepoRecord, number: number): MergeableCheck;
  mergePullSquash(repo: RepoRecord, number: number, options?: MergeOptions): string;
  listBranches(repo: RepoRecord): BranchInfo[];
  listCommits(repo: RepoRecord, branch: string): Array<CommitView & { oid: string }>;
}

// ---------------------------------------------------------------------------------------------
// the store
// ---------------------------------------------------------------------------------------------

/** Create a fresh, empty store. */
export function createStore(): Store {
  const repos = new Map<string, RepoRecord>();
  let createdCounter = 0;

  function createRepo(owner: string, name: string, description: string, isPrivate: boolean): RepoRecord {
    const fullName = owner + '/' + name;
    if (repos.has(fullName)) throw new Error('repository ' + fullName + ' already exists');
    const repo: RepoRecord = {
      owner,
      name,
      fullName,
      description,
      isPrivate,
      defaultBranch: 'main',
      createdIndex: createdCounter,
      objects: new Map<string, GitObjectRecord>(),
      refs: new Map<string, string>(),
      issues: [],
      pullRequests: [],
      labels: [],
      nextIssueNumber: 1,
      nextPullNumber: 1,
      nextCommentId: 1,
    };
    createdCounter += 1;
    repos.set(fullName, repo);
    return repo;
  }

  function getRepo(owner: string, name: string): RepoRecord | null {
    return repos.get(owner + '/' + name) ?? null;
  }

  function listReposByOwner(owner: string): RepoRecord[] {
    const out: RepoRecord[] = [];
    for (const repo of repos.values()) {
      if (repo.owner === owner) out.push(repo);
    }
    out.sort((a, b) => a.createdIndex - b.createdIndex);
    return out;
  }

  function deleteRepo(owner: string, name: string): boolean {
    return repos.delete(owner + '/' + name);
  }

  function putObject(repo: RepoRecord, kind: GitObjectKind, data: Buffer): string {
    const oid = hashObject(kind, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { kind, data });
    return oid;
  }

  function getObject(repo: RepoRecord, oid: string): GitObjectRecord | null {
    return repo.objects.get(oid) ?? null;
  }

  function hasObject(repo: RepoRecord, oid: string): boolean {
    return repo.objects.has(oid);
  }

  function listRefs(repo: RepoRecord, prefix?: string): RefInfo[] {
    const out: RefInfo[] = [];
    for (const [name, oid] of repo.refs) {
      if (prefix === undefined || name.startsWith(prefix)) out.push({ name, oid });
    }
    out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return out;
  }

  function getRef(repo: RepoRecord, name: string): string | null {
    return repo.refs.get(name) ?? null;
  }

  function setRef(repo: RepoRecord, name: string, oid: string): void {
    repo.refs.set(name, oid);
  }

  function createRef(repo: RepoRecord, name: string, oid: string): void {
    if (repo.refs.has(name)) throw new Error('ref ' + name + ' already exists');
    repo.refs.set(name, oid);
  }

  function deleteRef(repo: RepoRecord, name: string): boolean {
    return repo.refs.delete(name);
  }

  function resolveRef(repo: RepoRecord, name: string): string | null {
    if (name === 'HEAD') return repo.refs.get('refs/heads/' + repo.defaultBranch) ?? null;
    if (name.startsWith('refs/')) return repo.refs.get(name) ?? null;
    const head = repo.refs.get('refs/heads/' + name);
    if (head !== undefined) return head;
    const tag = repo.refs.get('refs/tags/' + name);
    if (tag !== undefined) return tag;
    return null;
  }

  /** Add a tree and everything under it to `out`, skipping gitlinks. */
  function addTreeClosure(repo: RepoRecord, oid: string, out: Set<string>, skip: Set<string>): void {
    const stack: string[] = [oid];
    while (stack.length > 0) {
      const current = stack.pop() as string;
      if (out.has(current) || skip.has(current)) continue;
      const obj = repo.objects.get(current);
      if (!obj) continue;
      out.add(current);
      if (obj.kind === 'tree') {
        for (const entry of parseTree(obj.data)) {
          if (entry.mode === '160000') continue;
          stack.push(entry.oid);
        }
      }
    }
  }

  function walkObjects(repo: RepoRecord, tips: Iterable<string>, options: WalkOptions = {}): WalkResult {
    const exclude = new Set<string>(options.exclude ?? []);
    const boundaries = new Set<string>(options.shallowBoundaries ?? []);
    const limit = options.depth;
    // Phase 1: the exclusion set — everything reachable from the haves, stopping
    // at shallow boundaries (their ancestors are not held).
    const excluded = new Set<string>();
    const eQueue: string[] = [...exclude];
    const eSeen = new Set<string>();
    while (eQueue.length > 0) {
      const oid = eQueue.pop() as string;
      if (eSeen.has(oid)) continue;
      eSeen.add(oid);
      const obj = repo.objects.get(oid);
      if (!obj) continue;
      excluded.add(oid);
      if (obj.kind === 'commit') {
        const commit = parseCommit(obj.data);
        addTreeClosure(repo, commit.tree, excluded, new Set<string>());
        if (!boundaries.has(oid)) {
          for (const parent of commit.parents) eQueue.push(parent);
        }
      } else if (obj.kind === 'tag') {
        eQueue.push(parseTag(obj.data).object);
      } else if (obj.kind === 'tree') {
        addTreeClosure(repo, oid, excluded, new Set<string>());
      }
    }
    // Phase 2: walk from the tips with the depth limit.
    const included = new Set<string>();
    const shallow = new Set<string>();
    const visitedCommits = new Set<string>();
    const commitDepth = new Map<string, number>();
    const seenObjects = new Set<string>();
    interface Work {
      oid: string;
      depth: number;
    }
    const queue: Work[] = [];
    for (const tip of tips) queue.push({ oid: tip, depth: 1 });
    let head = 0;
    while (head < queue.length) {
      const item = queue[head];
      head += 1;
      const obj = repo.objects.get(item.oid);
      if (!obj) continue;
      if (obj.kind === 'commit') {
        const known = commitDepth.get(item.oid);
        if (known !== undefined && known <= item.depth) continue;
        commitDepth.set(item.oid, item.depth);
        visitedCommits.add(item.oid);
        const held = excluded.has(item.oid);
        const isBoundary = boundaries.has(item.oid);
        const commit = parseCommit(obj.data);
        const atLimit = limit !== undefined && item.depth >= limit;
        if (!held) {
          included.add(item.oid);
          addTreeClosure(repo, commit.tree, included, excluded);
          if (atLimit) shallow.add(item.oid);
          else {
            for (const parent of commit.parents) queue.push({ oid: parent, depth: item.depth + 1 });
          }
        } else if (isBoundary) {
          if (!atLimit) {
            for (const parent of commit.parents) queue.push({ oid: parent, depth: item.depth + 1 });
          }
        }
        if (!atLimit) shallow.delete(item.oid);
      } else if (obj.kind === 'tag') {
        if (seenObjects.has(item.oid)) continue;
        seenObjects.add(item.oid);
        if (!excluded.has(item.oid)) included.add(item.oid);
        queue.push({ oid: parseTag(obj.data).object, depth: item.depth });
      } else if (obj.kind === 'tree') {
        if (seenObjects.has(item.oid)) continue;
        seenObjects.add(item.oid);
        if (!excluded.has(item.oid)) {
          included.add(item.oid);
          for (const entry of parseTree(obj.data)) {
            if (entry.mode === '160000') continue;
            queue.push({ oid: entry.oid, depth: item.depth });
          }
        }
      } else {
        if (seenObjects.has(item.oid)) continue;
        seenObjects.add(item.oid);
        if (!excluded.has(item.oid)) included.add(item.oid);
      }
    }
    return {
      oids: [...included].sort(),
      shallow: [...shallow].sort(),
      visitedCommits: [...visitedCommits].sort(),
    };
  }

  function buildBlob(repo: RepoRecord, data: Buffer): string {
    return putObject(repo, 'blob', data);
  }

  function buildTree(repo: RepoRecord, entries: readonly TreeEntry[]): string {
    return putObject(repo, 'tree', buildTreeBytes(entries));
  }

  function buildCommit(repo: RepoRecord, fields: BuildCommitFields): string {
    return putObject(repo, 'commit', buildCommitBytes(fields));
  }

  function splitPath(path: string): string[] {
    return path.split('/').filter((segment) => segment.length > 0);
  }

  function rebuildTreeWithFile(repo: RepoRecord, treeOid: string | null, segments: string[], blobOid: string): string {
    const data = treeOid === null ? null : repo.objects.get(treeOid);
    const entries: TreeEntry[] = data && data.kind === 'tree' ? parseTree(data.data) : [];
    const name = segments[0];
    if (segments.length === 1) {
      const next = entries.filter((entry) => entry.name !== name);
      next.push({ mode: '100644', name, oid: blobOid });
      return putObject(repo, 'tree', buildTreeBytes(next));
    }
    const child = entries.find((entry) => entry.name === name);
    const childTree = child && child.mode === '40000' ? child.oid : null;
    const newChild = rebuildTreeWithFile(repo, childTree, segments.slice(1), blobOid);
    const next = entries.filter((entry) => entry.name !== name);
    next.push({ mode: '40000', name, oid: newChild });
    return putObject(repo, 'tree', buildTreeBytes(next));
  }

  function removeFromTree(repo: RepoRecord, treeOid: string, segments: string[]): string | null {
    const data = repo.objects.get(treeOid);
    const entries: TreeEntry[] = data && data.kind === 'tree' ? parseTree(data.data) : [];
    const name = segments[0];
    if (segments.length === 1) {
      const next = entries.filter((entry) => entry.name !== name);
      if (next.length === 0) return null;
      return putObject(repo, 'tree', buildTreeBytes(next));
    }
    const child = entries.find((entry) => entry.name === name && entry.mode === '40000');
    if (!child) return treeOid;
    const newChild = removeFromTree(repo, child.oid, segments.slice(1));
    let next: TreeEntry[];
    if (newChild === null) next = entries.filter((entry) => entry.name !== name);
    else {
      next = entries.map((entry) => (entry.name === name ? { mode: '40000', name, oid: newChild } : entry));
    }
    if (next.length === 0) return null;
    return putObject(repo, 'tree', buildTreeBytes(next));
  }

  function findInTree(repo: RepoRecord, treeOid: string, segments: string[]): string | null {
    const data = repo.objects.get(treeOid);
    if (!data || data.kind !== 'tree') return null;
    const entries = parseTree(data.data);
    const entry = entries.find((candidate) => candidate.name === segments[0]);
    if (!entry) return null;
    if (segments.length === 1) return entry.oid;
    if (entry.mode !== '40000') return null;
    return findInTree(repo, entry.oid, segments.slice(1));
  }

  function branchTipTree(repo: RepoRecord, branch: string): { tip: string | null; tree: string | null } {
    const tip = repo.refs.get('refs/heads/' + branch) ?? null;
    if (tip === null) return { tip: null, tree: null };
    const obj = repo.objects.get(tip);
    if (!obj || obj.kind !== 'commit') return { tip, tree: null };
    return { tip, tree: parseCommit(obj.data).tree };
  }

  function applyContentsChange(repo: RepoRecord, branch: string, path: string, data: Buffer, message: string): ContentsChangeResult {
    const segments = splitPath(path);
    if (segments.length === 0) throw new Error('cannot write to an empty path');
    const blob = buildBlob(repo, data);
    const { tip, tree } = branchTipTree(repo, branch);
    const newTree = rebuildTreeWithFile(repo, tree, segments, blob);
    const parents = tip === null ? [] : [tip];
    const commit = buildCommit(repo, { tree: newTree, parents, message });
    setRef(repo, 'refs/heads/' + branch, commit);
    return { commit, blob };
  }

  function applyContentsDelete(repo: RepoRecord, branch: string, path: string, message: string): ContentsDeleteResult {
    const segments = splitPath(path);
    if (segments.length === 0) throw new Error('cannot delete an empty path');
    const { tip, tree } = branchTipTree(repo, branch);
    if (tip === null || tree === null) throw new Error('branch ' + branch + ' does not exist');
    if (findInTree(repo, tree, segments) === null) throw new Error('path ' + path + ' does not exist');
    const newTree = removeFromTree(repo, tree, segments);
    const rootTree = newTree === null ? putObject(repo, 'tree', buildTreeBytes([])) : newTree;
    const commit = buildCommit(repo, { tree: rootTree, parents: [tip], message });
    setRef(repo, 'refs/heads/' + branch, commit);
    return { commit };
  }

  function listTreeEntries(repo: RepoRecord, treeOid: string): PathEntry[] {
    const data = repo.objects.get(treeOid);
    if (!data || data.kind !== 'tree') return [];
    return parseTree(data.data).map((entry) => ({
      name: entry.name,
      kind: entry.mode === '40000' ? 'tree' : entry.mode === '160000' ? 'commit' : 'blob',
      mode: entry.mode,
      oid: entry.oid,
    }));
  }

  function readPathAtRef(repo: RepoRecord, ref: string, path: string): PathReadResult | null {
    const oid = resolveRef(repo, ref);
    if (oid === null) return null;
    const obj = repo.objects.get(oid);
    if (!obj) return null;
    let treeOid: string | null = null;
    if (obj.kind === 'commit') treeOid = parseCommit(obj.data).tree;
    else if (obj.kind === 'tree') treeOid = oid;
    else if (obj.kind === 'tag') {
      const target = repo.objects.get(parseTag(obj.data).object);
      if (!target) return null;
      if (target.kind === 'commit') treeOid = parseCommit(target.data).tree;
      else if (target.kind === 'tree') treeOid = parseTag(obj.data).object;
      else if (target.kind === 'blob' && path.split('/').filter((s) => s.length > 0).length === 0) {
        return { type: 'blob', data: target.data, oid: parseTag(obj.data).object, mode: '100644' };
      } else return null;
    } else return null;
    if (treeOid === null) return null;
    const segments = splitPath(path);
    if (segments.length === 0) return { type: 'tree', entries: listTreeEntries(repo, treeOid), oid: treeOid };
    let current = treeOid;
    for (let index = 0; index < segments.length; index += 1) {
      const data = repo.objects.get(current);
      if (!data || data.kind !== 'tree') return null;
      const entry = parseTree(data.data).find((candidate) => candidate.name === segments[index]);
      if (!entry) return null;
      if (index === segments.length - 1) {
        if (entry.mode === '40000') return { type: 'tree', entries: listTreeEntries(repo, entry.oid), oid: entry.oid };
        const blob = repo.objects.get(entry.oid);
        if (!blob) return null;
        return { type: 'blob', data: blob.data, oid: entry.oid, mode: entry.mode };
      }
      if (entry.mode !== '40000') return null;
      current = entry.oid;
    }
    return null;
  }

  function createIssue(repo: RepoRecord, fields: CreateIssueFields): IssueRecord {
    const labels = fields.labels ?? [];
    for (const label of labels) {
      if (!repo.labels.includes(label)) throw new Error('label ' + label + ' does not exist');
    }
    const issue: IssueRecord = {
      number: repo.nextIssueNumber,
      title: fields.title,
      body: fields.body,
      state: 'open',
      labels: [...labels],
      comments: [],
      createdAt: FIXED_CREATED_AT,
      updatedAt: FIXED_CREATED_AT,
    };
    repo.nextIssueNumber += 1;
    repo.issues.push(issue);
    return issue;
  }

  function listIssues(repo: RepoRecord, options: ListIssuesOptions = {}): IssueRecord[] {
    const state = options.state ?? 'all';
    const direction = options.direction ?? 'asc';
    const out = repo.issues.filter((issue) => state === 'all' || issue.state === state);
    out.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
    return out;
  }

  function getIssue(repo: RepoRecord, number: number): IssueRecord | null {
    return repo.issues.find((issue) => issue.number === number) ?? null;
  }

  function patchIssue(repo: RepoRecord, number: number, fields: PatchIssueFields): IssueRecord | null {
    const issue = getIssue(repo, number);
    if (!issue) return null;
    if (fields.state !== undefined) issue.state = fields.state;
    if (fields.title !== undefined) issue.title = fields.title;
    if (fields.body !== undefined) issue.body = fields.body;
    return issue;
  }

  function createComment(repo: RepoRecord, issueNumber: number, body: string, author?: string): CommentRecord {
    const issue = getIssue(repo, issueNumber);
    if (!issue) throw new Error('issue #' + String(issueNumber) + ' does not exist');
    const comment: CommentRecord = {
      id: repo.nextCommentId,
      body,
      author: author ?? VIEWER_LOGIN,
      createdAt: FIXED_CREATED_AT,
    };
    repo.nextCommentId += 1;
    issue.comments.push(comment);
    return comment;
  }

  function listComments(repo: RepoRecord, issueNumber: number): CommentRecord[] {
    const issue = getIssue(repo, issueNumber);
    if (!issue) return [];
    return [...issue.comments].sort((a, b) => a.id - b.id);
  }

  function createLabel(repo: RepoRecord, name: string): string {
    if (repo.labels.includes(name)) throw new Error('label ' + name + ' already exists');
    repo.labels.push(name);
    return name;
  }

  function listLabels(repo: RepoRecord): string[] {
    return [...repo.labels];
  }

  function createPull(repo: RepoRecord, fields: CreatePullFields): PullRecord {
    const pull: PullRecord = {
      number: repo.nextPullNumber,
      title: fields.title,
      body: fields.body,
      state: 'open',
      head: fields.head,
      base: fields.base,
      headSha: resolveRef(repo, fields.head),
      baseSha: resolveRef(repo, fields.base),
      merged: false,
      mergeCommitSha: null,
      mergedAt: null,
      createdAt: FIXED_CREATED_AT,
      updatedAt: FIXED_CREATED_AT,
    };
    repo.nextPullNumber += 1;
    repo.pullRequests.push(pull);
    return pull;
  }

  function getPull(repo: RepoRecord, number: number): PullRecord | null {
    return repo.pullRequests.find((pull) => pull.number === number) ?? null;
  }

  function listPulls(repo: RepoRecord, options: ListPullsOptions = {}): PullRecord[] {
    const state = options.state ?? 'all';
    const out = repo.pullRequests.filter((pull) => state === 'all' || pull.state === state);
    out.sort((a, b) => a.number - b.number);
    return out;
  }

  function flattenTree(repo: RepoRecord, treeOid: string, prefix: string, out: Map<string, { oid: string; mode: string }>): void {
    const obj = repo.objects.get(treeOid);
    if (!obj || obj.kind !== 'tree') return;
    for (const entry of parseTree(obj.data)) {
      const path = prefix === '' ? entry.name : prefix + '/' + entry.name;
      if (entry.mode === '40000') flattenTree(repo, entry.oid, path, out);
      else out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  }

  function treeOfTip(repo: RepoRecord, tip: string | null): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    if (tip === null) return out;
    const obj = repo.objects.get(tip);
    if (!obj || obj.kind !== 'commit') return out;
    flattenTree(repo, parseCommit(obj.data).tree, '', out);
    return out;
  }

  function listPullFiles(repo: RepoRecord, number: number): PullFile[] {
    const pull = getPull(repo, number);
    if (!pull) throw new Error('pull request #' + String(number) + ' does not exist');
    const baseTip = resolveRef(repo, pull.base) ?? pull.baseSha;
    const headTip = resolveRef(repo, pull.head) ?? pull.headSha;
    const baseMap = treeOfTip(repo, baseTip);
    const headMap = treeOfTip(repo, headTip);
    const paths = new Set<string>([...baseMap.keys(), ...headMap.keys()]);
    const files: PullFile[] = [];
    for (const path of [...paths].sort()) {
      const base = baseMap.get(path);
      const head = headMap.get(path);
      if (base && !head) {
        const counts = diffLineCounts(repo.objects.get(base.oid)?.data ?? null, null);
        files.push({ filename: path, status: 'removed', additions: 0, deletions: counts.deletions });
      } else if (!base && head) {
        const counts = diffLineCounts(null, repo.objects.get(head.oid)?.data ?? null);
        files.push({ filename: path, status: 'added', additions: counts.additions, deletions: 0 });
      } else if (base && head && base.oid !== head.oid) {
        const counts = diffLineCounts(repo.objects.get(base.oid)?.data ?? null, repo.objects.get(head.oid)?.data ?? null);
        files.push({ filename: path, status: 'modified', additions: counts.additions, deletions: counts.deletions });
      }
    }
    return files;
  }

  /** The best common ancestor of two commits (the three-way merge base). */
  function findMergeBase(repo: RepoRecord, a: string, b: string): string | null {
    const ancestorsA = new Map<string, number>();
    const queueA: Array<{ oid: string; depth: number }> = [{ oid: a, depth: 0 }];
    let headA = 0;
    while (headA < queueA.length) {
      const item = queueA[headA];
      headA += 1;
      if (ancestorsA.has(item.oid)) continue;
      ancestorsA.set(item.oid, item.depth);
      const obj = repo.objects.get(item.oid);
      if (!obj || obj.kind !== 'commit') continue;
      for (const parent of parseCommit(obj.data).parents) queueA.push({ oid: parent, depth: item.depth + 1 });
    }
    const queueB: Array<{ oid: string; depth: number }> = [{ oid: b, depth: 0 }];
    const seenB = new Set<string>();
    let headB = 0;
    let best: string | null = null;
    let bestScore = Number.POSITIVE_INFINITY;
    while (headB < queueB.length) {
      const item = queueB[headB];
      headB += 1;
      if (seenB.has(item.oid)) continue;
      seenB.add(item.oid);
      const depthA = ancestorsA.get(item.oid);
      if (depthA !== undefined) {
        const score = depthA + item.depth;
        if (score < bestScore) {
          bestScore = score;
          best = item.oid;
        }
        continue;
      }
      const obj = repo.objects.get(item.oid);
      if (!obj || obj.kind !== 'commit') continue;
      for (const parent of parseCommit(obj.data).parents) queueB.push({ oid: parent, depth: item.depth + 1 });
    }
    return best;
  }

  /**
   * Whether a pull request's squash merge would conflict: a path counts as
   * conflicted when it changed on both sides of the merge base (head tip and
   * base tip) and the two sides disagree. A change on one side only, or the
   * same change on both sides, merges cleanly.
   */
  function checkPullMergeable(repo: RepoRecord, number: number): MergeableCheck {
    const pull = getPull(repo, number);
    if (!pull) throw new Error('pull request #' + String(number) + ' does not exist');
    const baseTip = resolveRef(repo, pull.base) ?? pull.baseSha;
    const headTip = resolveRef(repo, pull.head) ?? pull.headSha;
    if (baseTip === null || headTip === null) return { mergeable: true };
    const mergeBase = findMergeBase(repo, headTip, baseTip);
    const baseMap = treeOfTip(repo, mergeBase);
    const headMap = treeOfTip(repo, headTip);
    const tipMap = treeOfTip(repo, baseTip);
    const paths = new Set<string>([...baseMap.keys(), ...headMap.keys(), ...tipMap.keys()]);
    for (const path of [...paths].sort()) {
      const inBase = baseMap.get(path)?.oid ?? null;
      const inHead = headMap.get(path)?.oid ?? null;
      const inTip = tipMap.get(path)?.oid ?? null;
      const headChanged = inHead !== inBase;
      const tipChanged = inTip !== inBase;
      if (headChanged && tipChanged && inHead !== inTip) return { mergeable: false, conflictPath: path };
    }
    return { mergeable: true };
  }

  function mergePullSquash(repo: RepoRecord, number: number, options: MergeOptions = {}): string {
    const pull = getPull(repo, number);
    if (!pull) throw new Error('pull request #' + String(number) + ' does not exist');
    if (pull.state !== 'open') throw new Error('pull request #' + String(number) + ' is not open');
    const check = checkPullMergeable(repo, number);
    if (!check.mergeable) {
      const err = new Error('merge conflict in ' + (check.conflictPath ?? 'unknown path')) as Error & { code?: string };
      err.code = 'MERGE_CONFLICT';
      throw err;
    }
    const baseTip = resolveRef(repo, pull.base);
    if (baseTip === null) throw new Error('base branch ' + pull.base + ' does not exist');
    const headTip = resolveRef(repo, pull.head) ?? pull.headSha;
    if (headTip === null) throw new Error('head branch ' + pull.head + ' does not exist');
    const headObj = repo.objects.get(headTip);
    if (!headObj || headObj.kind !== 'commit') throw new Error('head tip is not a commit');
    const tree = parseCommit(headObj.data).tree;
    const message = options.message ?? 'Merge pull request #' + String(pull.number) + ' from ' + pull.head + '\n';
    const commitOid = buildCommit(repo, { tree, parents: [baseTip], message });
    setRef(repo, 'refs/heads/' + pull.base, commitOid);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergeCommitSha = commitOid;
    pull.mergedAt = FIXED_MERGED_AT;
    return commitOid;
  }

  function listBranches(repo: RepoRecord): BranchInfo[] {
    const out: BranchInfo[] = [];
    for (const [name, oid] of repo.refs) {
      if (name.startsWith('refs/heads/')) out.push({ name: name.slice('refs/heads/'.length), oid });
    }
    out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return out;
  }

  function listCommits(repo: RepoRecord, branch: string): Array<CommitView & { oid: string }> {
    const out: Array<CommitView & { oid: string }> = [];
    let current = resolveRef(repo, branch);
    const seen = new Set<string>();
    while (current !== null && !seen.has(current)) {
      seen.add(current);
      const obj = repo.objects.get(current);
      if (!obj || obj.kind !== 'commit') break;
      const view = parseCommit(obj.data);
      out.push({ oid: current, ...view });
      current = view.parents.length > 0 ? view.parents[0] : null;
    }
    return out;
  }

  return {
    users: USERS,
    viewer: getViewer(),
    createRepo,
    getRepo,
    listReposByOwner,
    deleteRepo,
    putObject,
    getObject,
    hasObject,
    listRefs,
    getRef,
    setRef,
    createRef,
    deleteRef,
    resolveRef,
    walkObjects,
    buildBlob,
    buildTree,
    buildCommit,
    applyContentsChange,
    applyContentsDelete,
    readPathAtRef,
    createIssue,
    listIssues,
    getIssue,
    patchIssue,
    createComment,
    listComments,
    createLabel,
    listLabels,
    createPull,
    getPull,
    listPulls,
    listPullFiles,
    findMergeBase,
    checkPullMergeable,
    mergePullSquash,
    listBranches,
    listCommits,
  };
}

/** True when an error is a merge-conflict refusal from mergePullSquash. */
export function isMergeConflict(err: unknown): boolean {
  return Boolean(err) && typeof err === 'object' && (err as { code?: unknown }).code === 'MERGE_CONFLICT';
}
