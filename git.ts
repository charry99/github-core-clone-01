/**
 * git.ts — git smart-HTTP protocol layer on top of the store.
 *
 * upload-pack speaks protocol v2 (info/refs advertisement plus ls-refs and
 * fetch commands); receive-pack speaks protocol v0 (ref advertisement plus
 * command list, pack, and a report-status reply on the sideband). Only node
 * built-ins are used (node:crypto for SHA-1, node:zlib for pack
 * deflation/inflation). Packs we write contain plain entries only, sorted by
 * oid; packs we read support plain entries and both delta kinds.
 *
 * Handler shape (shared with the later API and wiring sessions): each entry
 * point takes the store, the HTTP method, the path segments, the query
 * object, the authorization header value and the raw request body, and
 * returns { status, headers, body } where the body is a string or a Buffer.
 *
 * Path segments: the router may pass the full path ([owner, repo.git, ...])
 * or the parts after the /<owner>/<repo>.git/ prefix ([info, refs],
 * [git-upload-pack]) together with query.owner / query.repo. Both forms are
 * accepted; when neither carries the repository the answer is 404.
 *
 * Node 22, TypeScript with type stripping, no dependencies. No enums, no
 * parameter properties, no namespaces.
 */

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import {
  ZERO_OID,
  hashObject,
  parseCommit,
  parseTag,
  parseTree,
} from './store.ts';
import type { GitObjectKind, RepoRecord, Store } from './store.ts';

export const GIT_AGENT = 'makefun-git-forge/1.0';
export const PKT_LINE_MAX = 65520;
const PKT_LINE_MAX_PAYLOAD = PKT_LINE_MAX - 4;
/** Largest sideband data chunk: one band byte plus this many pack bytes. */
const SIDEBAND_CHUNK = 65515;

export type QueryObject = Record<string, string | undefined>;

export interface HandlerResult {
  status: number;
  headers: Record<string, string>;
  body: string | Buffer;
}

// ---------------------------------------------------------------------------------------------
// pkt-line codec
// ---------------------------------------------------------------------------------------------

export type DecodedPacket =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

/** Encode one data packet: 4 hex length bytes (payload + 4) then the payload. */
export function encodePktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length > PKT_LINE_MAX_PAYLOAD) throw new Error('pkt-line payload exceeds the maximum');
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

export function pktLineFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function pktLineDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

export function pktLineResponseEnd(): Buffer {
  return Buffer.from('0002', 'ascii');
}

/** Encode a mixed sequence; 'flush' / 'delim' / 'response-end' are the control packets. */
export function encodePktLines(items: ReadonlyArray<string | Buffer | 'flush' | 'delim' | 'response-end'>): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(pktLineFlush());
    else if (item === 'delim') parts.push(pktLineDelim());
    else if (item === 'response-end') parts.push(pktLineResponseEnd());
    else parts.push(encodePktLine(item));
  }
  return Buffer.concat(parts);
}

const HEX4 = /^[0-9a-fA-F]{4}$/;

/** Decode a complete buffer into packets; throws on a malformed header or truncation. */
export function decodePktLines(bytes: Buffer): DecodedPacket[] {
  const packets: DecodedPacket[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    if (offset + 4 > bytes.length) throw new Error('truncated pkt-line header');
    const header = bytes.subarray(offset, offset + 4).toString('ascii');
    if (!HEX4.test(header)) throw new Error('invalid pkt-line length ' + JSON.stringify(header));
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (length === 3) throw new Error('invalid pkt-line length 0003');
    if (length > PKT_LINE_MAX) throw new Error('pkt-line length exceeds the maximum');
    if (offset + length > bytes.length) throw new Error('truncated pkt-line');
    packets.push({ kind: 'data', payload: bytes.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return packets;
}

/**
 * Decode pkt-lines up to and including the first flush packet; everything
 * after it is returned untouched (a receive-pack pack follows its command
 * list unframed). Throws on malformed framing before the flush.
 */
export function splitPktLinesAndRest(bytes: Buffer): { packets: DecodedPacket[]; rest: Buffer } {
  const packets: DecodedPacket[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    if (offset + 4 > bytes.length) throw new Error('truncated pkt-line header');
    const header = bytes.subarray(offset, offset + 4).toString('ascii');
    if (!HEX4.test(header)) throw new Error('invalid pkt-line length ' + JSON.stringify(header));
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      return { packets, rest: bytes.subarray(offset + 4) };
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (length === 3) throw new Error('invalid pkt-line length 0003');
    if (length > PKT_LINE_MAX) throw new Error('pkt-line length exceeds the maximum');
    if (offset + length > bytes.length) throw new Error('truncated pkt-line');
    packets.push({ kind: 'data', payload: bytes.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, rest: Buffer.alloc(0) };
}

/** The text of every data packet, in order, control packets dropped. */
export function packetLines(packets: readonly DecodedPacket[]): string[] {
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
  }
  return lines;
}

/** Frame bytes as one sideband packet on the given channel (1 data, 2 progress, 3 error). */
export function sidebandPacket(channel: 1 | 2 | 3, data: Buffer): Buffer {
  return encodePktLine(Buffer.concat([Buffer.from([channel]), data]));
}

/** Frame a byte stream as sideband channel-1 packets, chunked to the pkt-line limit. */
export function sidebandDataPackets(data: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  if (data.length === 0) {
    packets.push(sidebandPacket(1, Buffer.alloc(0)));
    return packets;
  }
  for (let offset = 0; offset < data.length; offset += SIDEBAND_CHUNK) {
    packets.push(sidebandPacket(1, data.subarray(offset, Math.min(offset + SIDEBAND_CHUNK, data.length))));
  }
  return packets;
}

// ---------------------------------------------------------------------------------------------
// packfile write / read
// ---------------------------------------------------------------------------------------------

export interface PackObjectInput {
  type: GitObjectKind;
  data: Buffer;
}

const PACK_TYPE_CODE: Record<GitObjectKind, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const PACK_CODE_TYPE: Record<number, GitObjectKind> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function writePackObjectHeader(type: GitObjectKind, size: number): Buffer {
  const code = PACK_TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/**
 * Build a packfile from plain objects (no deltas), entries sorted by oid for
 * determinism. The trailer is SHA-1 over everything before it.
 */
export function writePack(objects: Iterable<PackObjectInput>): Buffer {
  const list = [...objects].sort((a, b) => {
    const left = hashObject(a.type, a.data);
    const right = hashObject(b.type, b.data);
    return left < right ? -1 : left > right ? 1 : 0;
  });
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

export interface PackEntry {
  offset: number;
  type: GitObjectKind;
  size: number;
  data: Buffer;
  oid: string;
  delta: { kind: 'ofs' | 'ref'; baseOid: string } | null;
}

export interface PackReadResult {
  version: number;
  declaredCount: number;
  objects: Map<string, { type: GitObjectKind; data: Buffer }>;
  entries: PackEntry[];
  trailer: string;
  checksumOk: boolean;
  deltaCount: number;
}

function readVarintSize(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  if (start >= buffer.length) throw new Error('pack entry has no size header');
  let byte = buffer[start];
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('pack entry size varint is truncated');
    byte = buffer[offset];
    offset += 1;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (shift > 63) throw new Error('pack entry size varint is too long');
  }
  return { size, next: offset, first };
}

function readOfsDeltaBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  if (start >= buffer.length) throw new Error('ofs-delta has no base offset');
  let byte = buffer[start];
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('ofs-delta base offset is truncated');
    byte = buffer[offset];
    offset += 1;
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

/** Inflate one zlib stream at `offset`; returns its bytes and the offset just past the stream. */
export function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const view = buffer.subarray(offset);
  let result: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    result = inflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  } catch (err) {
    throw new Error('zlib stream at offset ' + String(offset) + ' did not inflate: ' + (err as Error).message);
  }
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error('zlib stream at offset ' + String(offset) + ' consumed no bytes');
  return { data: result.buffer, next: offset + written };
}

/** Apply a git delta (the copy/insert instruction stream) to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta size varint is truncated');
      const byte = delta[offset];
      offset += 1;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
      if (shift > 63) throw new Error('delta size varint is too long');
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) {
    throw new Error('delta expects a ' + String(sourceSize) + '-byte base, got ' + String(base.length));
  }
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset];
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy offset is truncated');
          copyOffset += delta[offset] * 2 ** shift;
          offset += 1;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy size is truncated');
          copySize += delta[offset] * 2 ** shift;
          offset += 1;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy is out of the base');
      if (written + copySize > targetSize) throw new Error('delta writes past its target size');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (offset + literal > delta.length) throw new Error('delta insert is truncated');
      if (written + literal > targetSize) throw new Error('delta writes past its target size');
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error('delta produced ' + String(written) + ' of ' + String(targetSize) + ' bytes');
  return out;
}

/**
 * Read a packfile (version 2 or 3) and resolve every object, including
 * OFS_DELTA and REF_DELTA. `resolveBase` supplies a base object a thin pack
 * leaves out. Every object's SHA-1 is recomputed and its declared size
 * checked; a mismatch is an error.
 */
export function readPack(
  pack: Buffer,
  options: { resolveBase?: (oid: string) => { type: GitObjectKind; data: Buffer } | undefined } = {},
): PackReadResult {
  const buffer = pack;
  if (buffer.length < 32) throw new Error('pack is ' + String(buffer.length) + ' bytes, too short');
  if (buffer.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = buffer.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error('unsupported pack version ' + String(version));
  const declaredCount = buffer.readUInt32BE(8);
  const trailerStart = buffer.length - 20;
  const trailer = buffer.subarray(trailerStart).toString('hex');
  const computedTrailer = createHash('sha1').update(buffer.subarray(0, trailerStart)).digest('hex');
  const checksumOk = trailer === computedTrailer;

  interface RawEntry {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
    resolvedType?: GitObjectKind;
    resolved?: Buffer;
    oid?: string;
  }

  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readVarintSize(buffer, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawEntry = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsDeltaBase(buffer, offset);
      offset = base.next;
      if (base.baseOffset <= 0 || base.baseOffset > entryOffset) {
        throw new Error('ofs-delta at ' + String(entryOffset) + ' names an invalid base offset');
      }
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      if (offset + 20 > trailerStart) throw new Error('ref-delta base id is truncated');
      entry.baseOid = buffer.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!PACK_CODE_TYPE[typeCode]) {
      throw new Error('pack entry ' + String(index) + ' has unknown type code ' + String(typeCode));
    }
    const inflated = inflateAt(buffer.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) {
      throw new Error('pack entry at ' + String(entryOffset) + ' declares ' + String(header.size) + ' bytes but inflated to ' + String(inflated.data.length));
    }
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) {
    throw new Error('pack has ' + String(trailerStart - offset) + ' stray bytes before its trailer');
  }

  const entries: PackEntry[] = [];
  const objects = new Map<string, { type: GitObjectKind; data: Buffer }>();
  const resolving = new Set<number>();
  const resolvedByOid = new Map<string, RawEntry>();

  const resolve = (entry: RawEntry): { type: GitObjectKind; data: Buffer; oid: string } => {
    if (entry.resolved && entry.resolvedType && entry.oid) {
      return { type: entry.resolvedType, data: entry.resolved, oid: entry.oid };
    }
    if (resolving.has(entry.offset)) throw new Error('delta cycle at pack offset ' + String(entry.offset));
    resolving.add(entry.offset);
    let type: GitObjectKind;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset as number);
      if (!baseEntry) throw new Error('ofs-delta base at offset ' + String(entry.baseOffset) + ' is not in the pack');
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid as string;
      const baseEntry = resolvedByOid.get(wanted);
      if (baseEntry) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = options.resolveBase ? options.resolveBase(wanted) : undefined;
        if (!external) throw new Error('ref-delta base ' + wanted + ' is neither in the pack nor supplied');
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = PACK_CODE_TYPE[entry.typeCode];
      data = entry.data;
    }
    const oid = hashObject(type, data);
    entry.resolved = data;
    entry.resolvedType = type;
    entry.oid = oid;
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return { type, data, oid };
  };

  let deltaCount = 0;
  for (const entry of raw) {
    const resolved = resolve(entry);
    if (entry.typeCode === 6 || entry.typeCode === 7) deltaCount += 1;
    if (!objects.has(resolved.oid)) objects.set(resolved.oid, { type: resolved.type, data: resolved.data });
    entries.push({
      offset: entry.offset,
      type: resolved.type,
      size: entry.size,
      data: entry.data,
      oid: resolved.oid,
      delta:
        entry.typeCode === 6
          ? { kind: 'ofs', baseOid: byOffset.get(entry.baseOffset as number)?.oid ?? '' }
          : entry.typeCode === 7
            ? { kind: 'ref', baseOid: entry.baseOid as string }
            : null,
    });
  }

  return { version, declaredCount, objects, entries, trailer, checksumOk, deltaCount };
}

// ---------------------------------------------------------------------------------------------
// shared handler plumbing
// ---------------------------------------------------------------------------------------------

function jsonResult(status: number, value: unknown): HandlerResult {
  return { status, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) };
}

function unauthorizedResult(): HandlerResult {
  return jsonResult(401, { message: 'Requires authentication' });
}

function notFoundResult(message: string): HandlerResult {
  return jsonResult(404, { message });
}

function badRequestResult(message: string): HandlerResult {
  return jsonResult(400, { message });
}

function asBuffer(body: Buffer | string | undefined): Buffer {
  if (body === undefined) return Buffer.alloc(0);
  if (Buffer.isBuffer(body)) return body;
  return Buffer.from(body, 'latin1');
}

function bearerToken(auth: string | null | undefined): string | null {
  if (!auth) return null;
  const prefix = 'Bearer ';
  if (auth.startsWith(prefix)) return auth.slice(prefix.length).trim();
  return auth.trim();
}

/**
 * The bearer token is read from MAKEFUN_SHOP_TOKEN. A request carrying
 * exactly that token is the viewer. When the variable is unset (local runs),
 * any non-empty bearer token counts as the viewer. No token, or a token that
 * does not match when the variable is set, is unauthenticated.
 */
export function isAuthenticated(auth: string | null | undefined): boolean {
  const token = bearerToken(auth);
  if (!token) return false;
  const expected = process.env.MAKEFUN_SHOP_TOKEN;
  if (expected) return token === expected;
  return true;
}

interface GitPath {
  owner: string;
  repo: string;
  rest: string[];
}

function parseGitPath(segments: string[], query: QueryObject): GitPath | null {
  if (segments.length >= 3) {
    let repo = segments[1];
    if (repo.endsWith('.git')) repo = repo.slice(0, -4);
    return { owner: segments[0], repo, rest: segments.slice(2) };
  }
  const owner = query.owner;
  const repo = query.repo;
  if (owner && repo) {
    const clean = repo.endsWith('.git') ? repo.slice(0, -4) : repo;
    return { owner, repo: clean, rest: segments };
  }
  return null;
}

/** Peel an annotated tag to the object it ultimately points at. */
function peelTag(repo: RepoRecord, oid: string): string {
  let current = oid;
  const seen = new Set<string>();
  for (;;) {
    if (seen.has(current)) return current;
    seen.add(current);
    const obj = repo.objects.get(current);
    if (!obj || obj.kind !== 'tag') return current;
    current = parseTag(obj.data).object;
  }
}

function refLinesWithPeeling(store: Store, repo: RepoRecord): Array<{ oid: string; name: string; peeled?: string }> {
  const out: Array<{ oid: string; name: string; peeled?: string }> = [];
  for (const ref of store.listRefs(repo)) {
    const entry: { oid: string; name: string; peeled?: string } = { oid: ref.oid, name: ref.name };
    const obj = repo.objects.get(ref.oid);
    if (obj && obj.kind === 'tag') entry.peeled = peelTag(repo, ref.oid);
    out.push(entry);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// upload-pack (protocol v2)
// ---------------------------------------------------------------------------------------------

function uploadPackAdvertisement(): Buffer {
  return encodePktLines([
    'version 2\n',
    'agent=' + GIT_AGENT + '\n',
    'ls-refs=unborn\n',
    'fetch=shallow filter deepen want-ref\n',
    'object-format=sha1\n',
    'sideband-all\n',
    'flush',
  ]);
}

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function handleLsRefs(store: Store, repo: RepoRecord, args: LsRefsArgs): HandlerResult {
  const headOid = store.resolveRef(repo, 'HEAD');
  const headTarget = 'refs/heads/' + repo.defaultBranch;
  const lines: Array<string | 'flush'> = [];
  const keep = (name: string): boolean => args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  if (args.symrefs && keep('HEAD') && (headOid !== null || args.unborn)) {
    if (headOid === null) lines.push('unborn HEAD symref-target:' + headTarget + '\n');
    else lines.push(headOid + ' HEAD symref-target:' + headTarget + '\n');
  }
  for (const ref of refLinesWithPeeling(store, repo)) {
    if (!keep(ref.name)) continue;
    let line = ref.oid + ' ' + ref.name;
    if (args.peel && ref.peeled !== undefined) line += ' peeled:' + ref.peeled;
    lines.push(line + '\n');
  }
  lines.push('flush');
  return {
    status: 200,
    headers: { 'Content-Type': 'application/x-git-upload-pack-result' },
    body: encodePktLines(lines),
  };
}

interface FetchArgs {
  wants: string[];
  wantRefs: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  filter: string | null;
}

const HEX40 = /^[0-9a-f]{40}$/;

function handleFetch(store: Store, repo: RepoRecord, args: FetchArgs): HandlerResult {
  const wantOids = new Set<string>();
  const wantedRefLines: Array<{ oid: string; ref: string }> = [];
  for (const want of args.wants) {
    if (HEX40.test(want)) {
      wantOids.add(want);
    } else {
      const resolved = store.resolveRef(repo, want);
      if (resolved !== null) {
        wantOids.add(resolved);
        wantedRefLines.push({ oid: resolved, ref: want });
      }
    }
  }
  for (const refName of args.wantRefs) {
    const resolved = store.resolveRef(repo, refName);
    if (resolved !== null) {
      wantOids.add(resolved);
      const full = store.listRefs(repo).find((ref) => ref.oid === resolved && (ref.name === refName || ref.name.endsWith('/' + refName)));
      wantedRefLines.push({ oid: resolved, ref: full ? full.name : refName });
    }
  }
  for (const oid of wantOids) {
    if (!store.hasObject(repo, oid)) {
      return badRequestResult('want ' + oid + ' is not in the repository');
    }
  }
  for (const ref of store.listRefs(repo)) {
    if (wantOids.has(ref.oid)) wantedRefLines.push({ oid: ref.oid, ref: ref.name });
  }
  const seenWanted = new Set<string>();
  const wantedRefs = wantedRefLines.filter((entry) => {
    const key = entry.oid + ' ' + entry.ref;
    if (seenWanted.has(key)) return false;
    seenWanted.add(key);
    return true;
  });
  const walk = store.walkObjects(repo, wantOids, {
    exclude: args.haves,
    depth: args.depth === null ? undefined : args.depth,
    shallowBoundaries: args.shallow,
  });
  const packObjects: PackObjectInput[] = [];
  for (const oid of walk.oids) {
    const obj = store.getObject(repo, oid);
    if (obj) packObjects.push({ type: obj.kind, data: obj.data });
  }
  const pack = writePack(packObjects);
  const shallowSet = new Set(walk.shallow);
  const unshallow = args.shallow.filter((oid) => walk.visitedCommits.includes(oid) && !shallowSet.has(oid));

  const parts: Buffer[] = [];
  parts.push(encodePktLines(['acknowledgments\n', 'NAK\n', 'delim']));
  if (walk.shallow.length > 0 || unshallow.length > 0) {
    const lines: Array<string | 'delim'> = ['shallow-info\n'];
    for (const oid of walk.shallow) lines.push('shallow ' + oid + '\n');
    for (const oid of unshallow) lines.push('unshallow ' + oid + '\n');
    lines.push('delim');
    parts.push(encodePktLines(lines));
  }
  if (wantedRefs.length > 0) {
    const lines: Array<string | 'delim'> = ['wanted-refs\n'];
    for (const entry of wantedRefs) lines.push(entry.oid + ' ' + entry.ref + '\n');
    lines.push('delim');
    parts.push(encodePktLines(lines));
  }
  parts.push(encodePktLine('packfile\n'));
  parts.push(sidebandPacket(2, Buffer.from('Enumerating objects: ' + String(packObjects.length) + ', done.\n', 'utf8')));
  for (const packet of sidebandDataPackets(pack)) parts.push(packet);
  parts.push(pktLineFlush());
  return {
    status: 200,
    headers: { 'Content-Type': 'application/x-git-upload-pack-result' },
    body: Buffer.concat(parts),
  };
}

function parseV2Command(body: Buffer): { command: string; args: string[] } {
  const packets = decodePktLines(body);
  const lines = packetLines(packets);
  if (lines.length === 0) throw new Error('empty command');
  const first = lines[0].replace(/\n$/, '');
  if (!first.startsWith('command=')) throw new Error('expected a command line, got ' + JSON.stringify(first.slice(0, 40)));
  const command = first.slice('command='.length);
  const args: string[] = [];
  for (const line of lines.slice(1)) {
    const text = line.replace(/\n$/, '');
    if (text === '' || text.startsWith('agent=') || text.startsWith('object-format=')) continue;
    args.push(text);
  }
  return { command, args };
}

function uploadPackCommand(store: Store, repo: RepoRecord, body: Buffer): HandlerResult {
  let parsed: { command: string; args: string[] };
  try {
    parsed = parseV2Command(body);
  } catch (err) {
    return badRequestResult((err as Error).message);
  }
  if (parsed.command === 'ls-refs') {
    const lsArgs: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
    for (const arg of parsed.args) {
      if (arg === 'peel') lsArgs.peel = true;
      else if (arg === 'symrefs') lsArgs.symrefs = true;
      else if (arg === 'unborn') lsArgs.unborn = true;
      else if (arg.startsWith('ref-prefix ')) lsArgs.prefixes.push(arg.slice('ref-prefix '.length));
    }
    return handleLsRefs(store, repo, lsArgs);
  }
  if (parsed.command === 'fetch') {
    const fetchArgs: FetchArgs = { wants: [], wantRefs: [], haves: [], shallow: [], depth: null, filter: null };
    for (const arg of parsed.args) {
      if (arg.startsWith('want ')) fetchArgs.wants.push(arg.slice(5));
      else if (arg.startsWith('want-ref ')) fetchArgs.wantRefs.push(arg.slice(9));
      else if (arg.startsWith('have ')) fetchArgs.haves.push(arg.slice(5));
      else if (arg.startsWith('shallow ')) fetchArgs.shallow.push(arg.slice(8));
      else if (arg.startsWith('deepen ')) {
        const depth = Number.parseInt(arg.slice(7), 10);
        if (Number.isFinite(depth) && depth > 0) fetchArgs.depth = depth;
      } else if (arg.startsWith('filter ')) fetchArgs.filter = arg.slice(7);
    }
    return handleFetch(store, repo, fetchArgs);
  }
  return badRequestResult('unknown command ' + JSON.stringify(parsed.command));
}

/**
 * git-upload-pack entry point: GET info/refs (protocol v2 advertisement) and
 * POST git-upload-pack (ls-refs / fetch commands).
 */
export function handleUploadPack(
  store: Store,
  method: string,
  segments: string[],
  query: QueryObject,
  auth: string | null | undefined,
  body: Buffer | string | undefined,
): HandlerResult {
  const verb = method.toUpperCase();
  if (!isAuthenticated(auth)) return unauthorizedResult();
  const path = parseGitPath(segments, query);
  if (path === null) return notFoundResult('repository not found');
  const repo = store.getRepo(path.owner, path.repo);
  if (repo === null) return notFoundResult('repository ' + path.owner + '/' + path.repo + ' not found');
  if (verb === 'GET' && path.rest.length === 2 && path.rest[0] === 'info' && path.rest[1] === 'refs') {
    if (query.service !== 'git-upload-pack') return badRequestResult('unknown service ' + JSON.stringify(query.service ?? null));
    return {
      status: 200,
      headers: { 'Content-Type': 'application/x-git-upload-pack-advertisement' },
      body: uploadPackAdvertisement(),
    };
  }
  if (verb === 'POST' && path.rest.length === 1 && path.rest[0] === 'git-upload-pack') {
    return uploadPackCommand(store, repo, asBuffer(body));
  }
  return notFoundResult('not found');
}

// ---------------------------------------------------------------------------------------------
// receive-pack (protocol v0)
// ---------------------------------------------------------------------------------------------

function receivePackAdvertisement(store: Store, repo: RepoRecord): Buffer {
  const caps =
    'report-status side-band-64k delete-refs object-format=sha1 agent=' + GIT_AGENT + ' symref=HEAD:refs/heads/' + repo.defaultBranch;
  const parts: Buffer[] = [];
  parts.push(encodePktLine('# service=git-receive-pack\n'));
  parts.push(pktLineFlush());
  const refs = refLinesWithPeeling(store, repo);
  if (refs.length === 0) {
    parts.push(encodePktLine(ZERO_OID + ' capabilities^{}\0' + caps + '\n'));
  } else {
    const headOid = store.resolveRef(repo, 'HEAD');
    const lines: string[] = [];
    lines.push((headOid ?? ZERO_OID) + ' HEAD\0' + caps + '\n');
    for (const ref of refs) {
      lines.push(ref.oid + ' ' + ref.name + '\n');
      if (ref.peeled !== undefined) lines.push(ref.peeled + ' ' + ref.name + '^{}\n');
    }
    parts.push(encodePktLines(lines));
  }
  parts.push(pktLineFlush());
  return Buffer.concat(parts);
}

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** True when `ancestor` is reachable from `descendant` by following parents. */
function isAncestor(repo: RepoRecord, ancestor: string, descendant: string): boolean {
  const start = peelTag(repo, descendant);
  if (start === ancestor) return true;
  const queue: string[] = [start];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.kind !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) {
      if (parent === ancestor) return true;
      queue.push(parent);
    }
  }
  return false;
}

/** The first object id the tip's closure references that the store lacks, or null. */
function missingClosureObject(repo: RepoRecord, tip: string): string | null {
  const queue: string[] = [peelTag(repo, tip)];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj) return oid;
    if (obj.kind === 'commit') {
      const commit = parseCommit(obj.data);
      queue.push(commit.tree);
      for (const parent of commit.parents) queue.push(parent);
    } else if (obj.kind === 'tag') {
      queue.push(parseTag(obj.data).object);
    } else if (obj.kind === 'tree') {
      for (const entry of parseTree(obj.data)) {
        if (entry.mode === '160000') continue;
        queue.push(entry.oid);
      }
    }
  }
  return null;
}

function receivePackReport(
  unpackOk: boolean,
  unpackDetail: string,
  results: Array<{ ref: string; ok: boolean; reason: string }>,
  objectCount: number,
): Buffer {
  const lines: Array<string | 'flush'> = ['unpack ' + unpackDetail + '\n'];
  for (const result of results) {
    lines.push(result.ok ? 'ok ' + result.ref + '\n' : 'ng ' + result.ref + ' ' + result.reason + '\n');
  }
  lines.push('flush');
  const reportBytes = encodePktLines(lines);
  const parts: Buffer[] = [];
  parts.push(sidebandPacket(1, reportBytes));
  parts.push(
    sidebandPacket(2, Buffer.from('Unpacking objects: 100% (' + String(objectCount) + '/' + String(objectCount) + '), done.\n', 'utf8')),
  );
  parts.push(pktLineFlush());
  return Buffer.concat(parts);
}

function receivePackCommand(store: Store, repo: RepoRecord, body: Buffer): HandlerResult {
  const headers = { 'Content-Type': 'application/x-git-receive-pack-result' };
  let split: { packets: DecodedPacket[]; rest: Buffer };
  try {
    split = splitPktLinesAndRest(body);
  } catch (err) {
    return badRequestResult((err as Error).message);
  }
  const commands: PushCommand[] = [];
  for (const line of packetLines(split.packets)) {
    const text = line.replace(/\n$/, '');
    if (text === '') continue;
    const nul = text.indexOf('\0');
    const clean = nul >= 0 ? text.slice(0, nul) : text;
    const parts = clean.split(' ');
    if (parts.length !== 3 || !HEX40.test(parts[0]) || !HEX40.test(parts[1]) || !parts[2].startsWith('refs/')) {
      return badRequestResult('bad receive-pack command ' + JSON.stringify(clean.slice(0, 60)));
    }
    commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
  }
  if (commands.length === 0) return badRequestResult('no receive-pack commands');
  const needsPack = commands.some((command) => command.newOid !== ZERO_OID);
  let objectCount = 0;
  if (needsPack) {
    if (split.rest.length === 0) {
      return { status: 200, headers, body: receivePackReport(false, 'missing pack', [], 0) };
    }
    let read: ReturnType<typeof readPack>;
    try {
      read = readPack(split.rest, {
        resolveBase: (oid) => {
          const obj = store.getObject(repo, oid);
          return obj ? { type: obj.kind, data: obj.data } : undefined;
        },
      });
    } catch (err) {
      return { status: 200, headers, body: receivePackReport(false, (err as Error).message, [], 0) };
    }
    if (!read.checksumOk) {
      return { status: 200, headers, body: receivePackReport(false, 'pack checksum mismatch', [], 0) };
    }
    objectCount = read.objects.size;
    for (const [oid, obj] of read.objects) {
      if (!store.hasObject(repo, oid)) store.putObject(repo, obj.type, obj.data);
    }
    for (const command of commands) {
      if (command.newOid === ZERO_OID) continue;
      const missing = missingClosureObject(repo, command.newOid);
      if (missing !== null) {
        return { status: 200, headers, body: receivePackReport(false, 'object ' + missing + ' is missing', [], objectCount) };
      }
    }
  }
  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  for (const command of commands) {
    const current = store.getRef(repo, command.ref);
    if (command.newOid === ZERO_OID) {
      if (current === null) {
        results.push({ ref: command.ref, ok: false, reason: 'remote ref does not exist' });
      } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
        results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      } else {
        store.deleteRef(repo, command.ref);
        results.push({ ref: command.ref, ok: true, reason: '' });
      }
      continue;
    }
    if (command.oldOid === ZERO_OID) {
      if (current !== null) {
        results.push({ ref: command.ref, ok: false, reason: 'already exists' });
      } else {
        store.setRef(repo, command.ref, command.newOid);
        results.push({ ref: command.ref, ok: true, reason: '' });
      }
      continue;
    }
    if (current === null) {
      results.push({ ref: command.ref, ok: false, reason: 'remote ref does not exist' });
    } else if (command.oldOid !== current) {
      results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
    } else if (command.newOid === current) {
      results.push({ ref: command.ref, ok: true, reason: '' });
    } else if (!isAncestor(repo, current, command.newOid)) {
      results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
    } else {
      store.setRef(repo, command.ref, command.newOid);
      results.push({ ref: command.ref, ok: true, reason: '' });
    }
  }
  return { status: 200, headers, body: receivePackReport(true, 'ok', results, objectCount) };
}

/**
 * git-receive-pack entry point: GET info/refs (protocol v0 advertisement) and
 * POST git-receive-pack (command list, pack, report-status reply).
 */
export function handleReceivePack(
  store: Store,
  method: string,
  segments: string[],
  query: QueryObject,
  auth: string | null | undefined,
  body: Buffer | string | undefined,
): HandlerResult {
  const verb = method.toUpperCase();
  if (!isAuthenticated(auth)) return unauthorizedResult();
  const path = parseGitPath(segments, query);
  if (path === null) return notFoundResult('repository not found');
  const repo = store.getRepo(path.owner, path.repo);
  if (repo === null) return notFoundResult('repository ' + path.owner + '/' + path.repo + ' not found');
  if (verb === 'GET' && path.rest.length === 2 && path.rest[0] === 'info' && path.rest[1] === 'refs') {
    if (query.service !== 'git-receive-pack') return badRequestResult('unknown service ' + JSON.stringify(query.service ?? null));
    return {
      status: 200,
      headers: { 'Content-Type': 'application/x-git-receive-pack-advertisement' },
      body: receivePackAdvertisement(store, repo),
    };
  }
  if (verb === 'POST' && path.rest.length === 1 && path.rest[0] === 'git-receive-pack') {
    return receivePackCommand(store, repo, asBuffer(body));
  }
  return notFoundResult('not found');
}
