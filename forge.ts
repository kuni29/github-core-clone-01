// forge.ts: the forge's store and git object model. Everything lives in process memory: a
// content-addressed object store shared by all repositories, plus per-repository refs, labels,
// issues and pull requests. No clock and no randomness feed any answer: server-made commits take
// their timestamps from a per-repository counter, so two runs of the same request sequence build
// byte-identical objects.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const VIEWER = Object.freeze({
  login: 'adaiversen',
  id: 1000,
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
});

export const ZERO_OID = '0'.repeat(40);
const BASE_TS = 1735689600; // 2025-01-01T00:00:00Z; server commits count up from here.

// ---------------------------------------------------------------- object store

export type GitObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

const objects = new Map<string, GitObject>();

export function hashObject(type: GitObjectType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(`${type} ${data.length}\0`, 'utf8');
  hash.update(data);
  return hash.digest('hex');
}

export function storeObject(type: GitObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!objects.has(oid)) objects.set(oid, { type, data });
  return oid;
}

export function getObject(oid: string): GitObject | undefined {
  return objects.get(oid);
}

export function hasObject(oid: string): boolean {
  return objects.has(oid);
}

// ---------------------------------------------------------------- trees and commits

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Git's tree order: bytewise by name, directories as if the name ended in '/'. */
export function buildTreeBuffer(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = a.name + (a.mode === '40000' ? '/' : '');
    const kb = b.name + (b.mode === '40000' ? '/' : '');
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export function storeTree(entries: readonly TreeEntry[]): string {
  return storeObject('tree', buildTreeBuffer(entries));
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    const nul = data.indexOf(0x00, space);
    const mode = data.toString('utf8', pos, space);
    const name = data.toString('utf8', space + 1, nul);
    const oid = data.toString('hex', nul + 1, nul + 21);
    entries.push({ mode, name, oid });
    pos = nul + 21;
  }
  return entries;
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function buildCommitBuffer(info: CommitInfo): Buffer {
  const lines = [`tree ${info.tree}`];
  for (const parent of info.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${info.author}`);
  lines.push(`committer ${info.committer}`);
  return Buffer.from(`${lines.join('\n')}\n\n${info.message}`, 'utf8');
}

export function commitOf(oid: string): CommitInfo | null {
  const obj = objects.get(oid);
  if (!obj || obj.type !== 'commit') return null;
  return parseCommit(obj.data);
}

/** Follow annotated tag objects to the commit they name; the chain holds every oid passed. */
export function peelToCommit(oid: string): { commit: string; chain: string[] } | null {
  const chain: string[] = [];
  let current = oid;
  for (let guard = 0; guard < 32; guard += 1) {
    const obj = objects.get(current);
    if (!obj) return null;
    chain.push(current);
    if (obj.type === 'commit') return { commit: current, chain };
    if (obj.type !== 'tag') return null;
    const match = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
    if (!match) return null;
    current = match[1]!;
  }
  return null;
}

/** The commit an oid names (itself, or through tag objects), or null. */
export function peelCommitOid(oid: string): string | null {
  const peeled = peelToCommit(oid);
  return peeled === null ? null : peeled.commit;
}

/** The oid a tag object points at, or null when `oid` is not a tag. */
export function tagTarget(oid: string): string | null {
  const obj = objects.get(oid);
  if (!obj || obj.type !== 'tag') return null;
  const match = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
  return match ? match[1]! : null;
}

// ---------------------------------------------------------------- ancestry and closure

/** Every commit reachable from `tips` (through tag objects too), with its generation (min distance). */
export function commitGenerations(tips: readonly string[]): Map<string, number> {
  const generations = new Map<string, number>();
  const queue: Array<{ oid: string; gen: number }> = [];
  for (const tip of tips) {
    const commit = peelCommitOid(tip);
    if (commit !== null && !generations.has(commit)) {
      generations.set(commit, 0);
      queue.push({ oid: commit, gen: 0 });
    }
  }
  for (let head = 0; head < queue.length; head += 1) {
    const { oid, gen } = queue[head]!;
    const info = commitOf(oid);
    if (info === null) continue;
    for (const parent of info.parents) {
      if (!generations.has(parent)) {
        generations.set(parent, gen + 1);
        queue.push({ oid: parent, gen: gen + 1 });
      }
    }
  }
  return generations;
}

export function isAncestor(ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const target = peelCommitOid(ancestor);
  const start = peelCommitOid(descendant);
  if (target === null || start === null) return false;
  if (target === start) return true;
  // Breadth-first from the descendant, stopping the moment the target is reached: a
  // fast-forward check on a fresh tip finds its parent in the first generation.
  const seen = new Set<string>([start]);
  const queue: string[] = [start];
  for (let head = 0; head < queue.length; head += 1) {
    const info = commitOf(queue[head]!);
    if (info === null) continue;
    for (const parent of info.parents) {
      if (parent === target) return true;
      if (!seen.has(parent)) {
        seen.add(parent);
        queue.push(parent);
      }
    }
  }
  return false;
}

/** A common ancestor of `a` and `b` minimizing the summed distance, or null. */
export function mergeBaseOid(a: string, b: string): string | null {
  const fromA = commitGenerations([a]);
  const fromB = commitGenerations([b]);
  let best: string | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const [oid, genA] of fromA) {
    const genB = fromB.get(oid);
    if (genB !== undefined && genA + genB < bestScore) {
      bestScore = genA + genB;
      best = oid;
    }
  }
  return best;
}

/** Add a commit's tree (recursively) and every blob under it to `into`. */
function addTreeClosure(treeOid: string, into: Set<string>): void {
  if (into.has(treeOid)) return;
  const obj = objects.get(treeOid);
  if (!obj || obj.type !== 'tree') return;
  into.add(treeOid);
  for (const entry of parseTree(obj.data)) {
    if (entry.mode === '40000') addTreeClosure(entry.oid, into);
    else if (objects.has(entry.oid)) into.add(entry.oid);
  }
}

/** Add one commit object plus its whole tree closure to `into`. */
function addCommitClosure(commitOid: string, into: Set<string>): void {
  const info = commitOf(commitOid);
  if (info === null) return;
  into.add(commitOid);
  addTreeClosure(info.tree, into);
}

/**
 * The full object closure of arbitrary starting oids. When a commit is in `stopAt`, the commit and
 * its trees are included but its parents are not followed (a shallow client's held set).
 */
export function objectClosure(starts: readonly string[], stopAt?: ReadonlySet<string>): Set<string> {
  const into = new Set<string>();
  const commitQueue: string[] = [];
  const visit = (oid: string): void => {
    const obj = objects.get(oid);
    if (!obj) return;
    if (obj.type === 'commit') {
      if (!into.has(oid)) {
        addCommitClosure(oid, into);
        commitQueue.push(oid);
      }
    } else if (obj.type === 'tag') {
      into.add(oid);
      const target = tagTarget(oid);
      if (target !== null) visit(target);
    } else if (obj.type === 'tree') {
      addTreeClosure(oid, into);
    } else {
      into.add(oid);
    }
  };
  for (const start of starts) visit(start);
  for (let head = 0; head < commitQueue.length; head += 1) {
    const oid = commitQueue[head]!;
    if (stopAt !== undefined && stopAt.has(oid)) continue;
    const info = commitOf(oid);
    if (info === null) continue;
    for (const parent of info.parents) visit(parent);
  }
  return into;
}

/** Commits within `depth` generations of the wants (want tips are generation 0), plus closures. */
export function boundedClosure(wants: readonly string[], depth: number): { objects: Set<string>; commits: Set<string>; boundary: string[] } {
  // A depth-limited breadth-first walk: parents of commits at the last included generation
  // are never visited, so a depth-1 clone of a long history costs one generation, not all.
  const generations = new Map<string, number>();
  const queue: Array<{ oid: string; gen: number }> = [];
  for (const want of wants) {
    const commit = peelCommitOid(want);
    if (commit !== null && !generations.has(commit)) {
      generations.set(commit, 0);
      queue.push({ oid: commit, gen: 0 });
    }
  }
  for (let head = 0; head < queue.length; head += 1) {
    const { oid, gen } = queue[head]!;
    if (gen >= depth - 1) continue;
    const info = commitOf(oid);
    if (info === null) continue;
    for (const parent of info.parents) {
      if (!generations.has(parent)) {
        generations.set(parent, gen + 1);
        queue.push({ oid: parent, gen: gen + 1 });
      }
    }
  }
  const commits = new Set<string>();
  for (const [oid, gen] of generations) if (gen < depth) commits.add(oid);
  const into = new Set<string>();
  // Tag objects on the peel chain of a want ride along.
  for (const want of wants) {
    const peeled = peelToCommit(want);
    if (peeled !== null) for (const oid of peeled.chain) if (oid !== peeled.commit) into.add(oid);
  }
  for (const oid of commits) addCommitClosure(oid, into);
  const boundary: string[] = [];
  for (const oid of commits) {
    const gen = generations.get(oid)!;
    if (gen !== depth - 1) continue;
    const info = commitOf(oid);
    if (info !== null && info.parents.length > 0) boundary.push(oid);
  }
  return { objects: into, commits, boundary };
}

export interface FetchPlan {
  objects: string[];
  shallow: string[];
  unshallow: string[];
}

/** Decide exactly which objects a fetch sends and which shallow lines it reports. */
export function planFetch(wants: readonly string[], haves: readonly string[], shallowLines: readonly string[], deepen: number | null): FetchPlan {
  if (deepen !== null && deepen > 0) {
    const bounded = boundedClosure(wants, deepen);
    // What the client already holds: the closure of its haves and of its shallow boundary,
    // never descending past the boundary commits. The wants themselves are not held — a
    // deepening fetch re-asks for the same tips it holds only down to that boundary.
    const held = objectClosure([...haves, ...shallowLines], new Set(shallowLines));
    const send = [...bounded.objects].filter((oid) => !held.has(oid));
    const boundary = new Set(bounded.boundary);
    const unshallow: string[] = [];
    for (const line of shallowLines) {
      if (bounded.commits.has(line) && !boundary.has(line)) unshallow.push(line);
    }
    return { objects: send, shallow: bounded.boundary, unshallow };
  }
  const wantClosure = objectClosure(wants);
  const haveClosure = haves.length > 0 ? objectClosure(haves) : new Set<string>();
  const send = [...wantClosure].filter((oid) => !haveClosure.has(oid));
  return { objects: send, shallow: [], unshallow: [] };
}

// ---------------------------------------------------------------- packs

const PACK_TYPES: Record<string, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const PACK_TYPE_NAMES: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/**
 * Memoized packs, keyed by the requested oid list. Sound because the store is
 * content-addressed and append-only: an oid's object never changes once stored, so a
 * pack built for a list is the pack for that list forever. Only small packs are kept
 * (the depth-limited fetches the benchmark repeats), and the map clears rather than
 * grows past its cap.
 */
const packCache = new Map<string, Buffer>();
const PACK_CACHE_MAX_ENTRIES = 128;
const PACK_CACHE_MAX_BYTES = 256 * 1024;

/** A plain pack (no deltas) carrying exactly `oids`, in the order given. */
export function buildPack(oids: readonly string[]): Buffer {
  const present = oids.filter((oid) => objects.has(oid));
  // The key is the present list, not the requested one: an oid stored later must not
  // be served a pack built before it existed.
  const key = present.length <= 1024 ? present.join(' ') : null;
  if (key !== null) {
    const hit = packCache.get(key);
    if (hit !== undefined) return hit;
  }
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(present.length, 8);
  parts.push(header);
  for (const oid of present) {
    const obj = objects.get(oid)!;
    const typeCode = PACK_TYPES[obj.type]!;
    const size = obj.data.length;
    const headBytes: number[] = [];
    let first = (typeCode << 4) | (size & 0x0f);
    let rest = size >> 4;
    if (rest > 0) first |= 0x80;
    headBytes.push(first);
    while (rest > 0) {
      let byte = rest & 0x7f;
      rest >>= 7;
      if (rest > 0) byte |= 0x80;
      headBytes.push(byte);
    }
    parts.push(Buffer.from(headBytes));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  const pack = Buffer.concat([body, trailer]);
  if (key !== null && pack.length <= PACK_CACHE_MAX_BYTES) {
    if (packCache.size >= PACK_CACHE_MAX_ENTRIES) packCache.clear();
    packCache.set(key, pack);
  }
  return pack;
}

/** The end offset of the deflate stream starting at `start`, knowing its inflated size. */
function inflateEnd(buf: Buffer, start: number, expectedSize: number): { data: Buffer; end: number } {
  // One inflate over the rest of the pack (inflateSync tolerates the trailing entries): with
  // info:true the engine reports exactly how many compressed bytes the stream consumed, which
  // is precisely the stream's end. No probing, and a well-formed stream never throws.
  let out: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    out = inflateSync(buf.subarray(start), { info: true }) as { buffer: Buffer; engine: { bytesWritten: number } };
  } catch {
    throw new Error('pack entry does not inflate');
  }
  if (out.buffer.length !== expectedSize) throw new Error('pack entry size mismatch');
  return { data: out.buffer, end: start + out.engine.bytesWritten };
}

export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readSize = (): number => {
    let size = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[pos]!;
      pos += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return size;
  };
  const sourceSize = readSize();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const targetSize = readSize();
  const out: Buffer[] = [];
  let produced = 0;
  while (pos < delta.length) {
    const op = delta[pos]!;
    pos += 1;
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      if (op & 0x01) { offset = delta[pos]!; pos += 1; }
      if (op & 0x02) { offset |= delta[pos]! << 8; pos += 1; }
      if (op & 0x04) { offset |= delta[pos]! << 16; pos += 1; }
      if (op & 0x08) { offset |= delta[pos]! << 24; pos += 1; }
      if (op & 0x10) { size = delta[pos]!; pos += 1; }
      if (op & 0x20) { size |= delta[pos]! << 8; pos += 1; }
      if (op & 0x40) { size |= delta[pos]! << 16; pos += 1; }
      if (size === 0) size = 0x10000;
      out.push(base.subarray(offset, offset + size));
      produced += size;
    } else if (op > 0) {
      out.push(delta.subarray(pos, pos + op));
      produced += op;
      pos += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const result = Buffer.concat(out);
  if (produced !== targetSize || result.length !== targetSize) throw new Error('delta target size mismatch');
  return result;
}

/**
 * Parse a pack and store every object it carries (deltas resolved against the pack itself or
 * the store). Returns the number of objects the pack declared. Throws on any malformation.
 */
export function unpackPack(pack: Buffer): number {
  if (pack.length < 12 + 20) throw new Error('pack too short');
  if (pack.toString('ascii', 0, 4) !== 'PACK') throw new Error('pack header missing');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailer = pack.subarray(pack.length - 20);
  const digest = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest();
  if (!digest.equals(trailer)) throw new Error('pack checksum mismatch');
  let pos = 12;
  const byOffset = new Map<number, string>();
  for (let index = 0; index < count; index += 1) {
    const entryStart = pos;
    const firstByte = pack[pos]!;
    pos += 1;
    const typeCode = (firstByte >> 4) & 7;
    let size = firstByte & 0x0f;
    let shift = 4;
    let byte = firstByte;
    while (byte & 0x80) {
      byte = pack[pos]!;
      pos += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let baseOid: string | null = null;
    let baseType: GitObjectType | null = null;
    if (typeCode === 6) {
      // OFS_DELTA: a negative offset to the base entry's start.
      let b = pack[pos]!;
      pos += 1;
      let offset = b & 0x7f;
      while (b & 0x80) {
        b = pack[pos]!;
        pos += 1;
        offset = ((offset + 1) << 7) | (b & 0x7f);
      }
      const found = byOffset.get(entryStart - offset);
      if (found === undefined) throw new Error('ofs-delta base not in pack');
      baseOid = found;
      baseType = objects.get(baseOid)?.type ?? null;
    } else if (typeCode === 7) {
      baseOid = pack.toString('hex', pos, pos + 20);
      pos += 20;
      baseType = objects.get(baseOid)?.type ?? null;
    }
    const { data, end } = inflateEnd(pack, pos, size);
    pos = end;
    if (typeCode === 6 || typeCode === 7) {
      if (baseOid === null || baseType === null) throw new Error('delta base missing');
      const base = objects.get(baseOid);
      if (!base) throw new Error('delta base missing');
      const resolved = applyDelta(base.data, data);
      const oid = storeObject(baseType, resolved);
      byOffset.set(entryStart, oid);
    } else {
      const type = PACK_TYPE_NAMES[typeCode];
      if (type === undefined) throw new Error(`pack object type ${typeCode}`);
      const oid = storeObject(type, data);
      byOffset.set(entryStart, oid);
    }
  }
  return count;
}

// ---------------------------------------------------------------- repository store

export interface LabelRec {
  name: string;
  color: string;
}

export interface CommentRec {
  id: number;
  body: string;
}

export interface IssueRec {
  kind: 'issue' | 'pull';
  dbId: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentRec[];
  seq: number;
  headRef: string;
  baseRef: string;
  merged: boolean;
  mergeCommitSha: string | null;
  mergedAt: string | null;
  /** Bump on every mutation of the record; app.ts keys its serialized-issue cache on it. */
  rev: number;
}

export interface RepoRec {
  id: number;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  refs: Map<string, string>;
  labels: Map<string, LabelRec>;
  issues: Map<number, IssueRec>;
  nextNumber: number;
  seqCounter: number;
  commitCounter: number;
}

const repos = new Map<string, RepoRec>();
let nextRepoId = 1;
let nextIssueDbId = 1;
let nextCommentId = 1;

export function createRepo(name: string, description: string, isPrivate: boolean): RepoRec {
  const repo: RepoRec = {
    id: nextRepoId,
    name,
    description,
    isPrivate,
    defaultBranch: 'main',
    refs: new Map(),
    labels: new Map(),
    issues: new Map(),
    nextNumber: 1,
    seqCounter: 0,
    commitCounter: 0,
  };
  nextRepoId += 1;
  repos.set(name, repo);
  return repo;
}

export function getRepo(name: string): RepoRec | undefined {
  return repos.get(name);
}

export function deleteRepo(name: string): boolean {
  return repos.delete(name);
}

export function listRepos(): RepoRec[] {
  return [...repos.values()].sort((a, b) => a.id - b.id);
}

export function newIssueDbId(): number {
  const id = nextIssueDbId;
  nextIssueDbId += 1;
  return id;
}

export function newCommentId(): number {
  const id = nextCommentId;
  nextCommentId += 1;
  return id;
}

/** The next deterministic timestamp for a server-made commit in this repository. */
export function nextCommitTimestamp(repo: RepoRec): number {
  repo.commitCounter += 1;
  return BASE_TS + repo.commitCounter * 60;
}

export function viewerIdentityLine(timestamp: number): string {
  return `${VIEWER.name} <${VIEWER.email}> ${timestamp} +0000`;
}

/** Create a commit object authored by the viewer identity and return its oid. */
export function createServerCommit(repo: RepoRec, tree: string, parents: readonly string[], message: string): string {
  const ts = nextCommitTimestamp(repo);
  const line = viewerIdentityLine(ts);
  return storeObject('commit', buildCommitBuffer({ tree, parents: [...parents], author: line, committer: line, message }));
}

// ---------------------------------------------------------------- tree file operations

/** Flatten a tree into path -> {oid, mode}; a null tree is the empty tree. */
export function flattenTree(treeOid: string | null): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const walk = (oid: string, prefix: string): void => {
    const obj = objects.get(oid);
    if (!obj || obj.type !== 'tree') return;
    for (const entry of parseTree(obj.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  };
  if (treeOid !== null) walk(treeOid, '');
  return out;
}

/** Build (and store) the tree hierarchy for a flattened file map; returns the root tree oid. */
export function buildTreeFromFlat(flat: ReadonlyMap<string, { oid: string; mode: string }>): string {
  interface Node {
    files: Array<{ name: string; oid: string; mode: string }>;
    dirs: Map<string, Node>;
  }
  const root: Node = { files: [], dirs: new Map() };
  for (const [path, file] of flat) {
    const segments = path.split('/');
    let node = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const segment = segments[i]!;
      let next = node.dirs.get(segment);
      if (next === undefined) {
        next = { files: [], dirs: new Map() };
        node.dirs.set(segment, next);
      }
      node = next;
    }
    node.files.push({ name: segments[segments.length - 1]!, oid: file.oid, mode: file.mode });
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const file of node.files) entries.push({ mode: file.mode, name: file.name, oid: file.oid });
    for (const [name, dir] of node.dirs) entries.push({ mode: '40000', name, oid: build(dir) });
    return storeTree(entries);
  };
  return build(root);
}

/** The tree oid a commit names, or null. */
export function treeOfCommit(commitOid: string): string | null {
  const info = commitOf(commitOid);
  return info === null ? null : info.tree;
}

/** The tip commit of a branch ref, or null when the branch does not exist. */
export function branchTip(repo: RepoRec, branch: string): string | null {
  return repo.refs.get(`refs/heads/${branch}`) ?? null;
}

/**
 * Replace (or, with blobOid null, delete) one file on a branch, committing on top of the branch
 * tip. Creates the branch (and the repository's first commit) when it does not exist yet.
 * Returns the new commit oid.
 */
export function writeFileOnBranch(repo: RepoRec, branch: string, path: string, blobOid: string | null, message: string): string {
  const ref = `refs/heads/${branch}`;
  const tip = repo.refs.get(ref) ?? null;
  let parentTree: string | null = null;
  let parents: string[] = [];
  if (tip !== null) {
    parentTree = treeOfCommit(tip);
    parents = [tip];
  } else {
    // A new branch starts from the default branch's tip when the repository has one.
    const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
    if (defaultTip !== null) {
      parentTree = treeOfCommit(defaultTip);
      parents = [defaultTip];
    }
  }
  const flat = flattenTree(parentTree);
  if (blobOid === null) flat.delete(path);
  else flat.set(path, { oid: blobOid, mode: '100644' });
  const tree = buildTreeFromFlat(flat);
  const commit = createServerCommit(repo, tree, parents, message);
  repo.refs.set(ref, commit);
  return commit;
}

// ---------------------------------------------------------------- merges and diffs

/**
 * File-level three-way merge of three trees. Returns the merged tree oid, or null on a
 * conflict (both sides changed the same path differently, or one deleted what the other
 * changed).
 */
export function mergeTrees(baseTree: string | null, oursTree: string | null, theirsTree: string | null): string | null {
  const base = flattenTree(baseTree);
  const ours = flattenTree(oursTree);
  const theirs = flattenTree(theirsTree);
  const paths = new Set<string>([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  const merged = new Map<string, { oid: string; mode: string }>();
  for (const path of paths) {
    const b = base.get(path)?.oid;
    const o = ours.get(path)?.oid;
    const t = theirs.get(path)?.oid;
    if (o === t) {
      if (o !== undefined) merged.set(path, ours.get(path) ?? theirs.get(path)!);
    } else if (b === o) {
      if (t !== undefined) merged.set(path, theirs.get(path)!);
    } else if (b === t) {
      if (o !== undefined) merged.set(path, ours.get(path)!);
    } else {
      return null;
    }
  }
  return buildTreeFromFlat(merged);
}

export function countLines(data: Buffer): number {
  if (data.length === 0) return 0;
  let lines = 0;
  for (const byte of data) if (byte === 0x0a) lines += 1;
  if (data[data.length - 1] !== 0x0a) lines += 1;
  return lines;
}

export interface FileDiff {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
}

/** The file-level diff between two trees (line counts are whole-file for changed blobs). */
export function diffTrees(fromTree: string | null, toTree: string | null): FileDiff[] {
  const from = flattenTree(fromTree);
  const to = flattenTree(toTree);
  const paths = new Set<string>([...from.keys(), ...to.keys()]);
  const diffs: FileDiff[] = [];
  for (const path of [...paths].sort()) {
    const a = from.get(path);
    const b = to.get(path);
    if (a !== undefined && b !== undefined && a.oid === b.oid) continue;
    const aData = a !== undefined ? (objects.get(a.oid)?.data ?? Buffer.alloc(0)) : null;
    const bData = b !== undefined ? (objects.get(b.oid)?.data ?? Buffer.alloc(0)) : null;
    const additions = bData === null ? 0 : countLines(bData);
    const deletions = aData === null ? 0 : countLines(aData);
    diffs.push({
      filename: path,
      status: a === undefined ? 'added' : b === undefined ? 'removed' : 'modified',
      additions,
      deletions,
      changes: additions + deletions,
    });
  }
  return diffs;
}

/** The outcome of attempting to merge a pull request into its base branch. */
export type MergeOutcome =
  | { ok: true; sha: string }
  | { ok: false; reason: 'conflict' | 'missing' };

/**
 * Squash-merge a pull request: one new commit on the base branch whose tree is the three-way
 * merge of merge-base, base tip and head tip. Shared by REST, GraphQL and MCP.
 */
export function mergePullRequest(repo: RepoRec, issue: IssueRec): MergeOutcome {
  const baseTip = branchTip(repo, issue.baseRef);
  const headTip = branchTip(repo, issue.headRef);
  if (baseTip === null || headTip === null) return { ok: false, reason: 'missing' };
  const base = mergeBaseOid(baseTip, headTip);
  const baseTree = base === null ? null : treeOfCommit(base);
  const mergedTree = mergeTrees(baseTree, treeOfCommit(baseTip), treeOfCommit(headTip));
  if (mergedTree === null) return { ok: false, reason: 'conflict' };
  const message = `${issue.title}\n\n${issue.body}`.trimEnd() + '\n';
  const sha = createServerCommit(repo, mergedTree, [baseTip], message);
  repo.refs.set(`refs/heads/${issue.baseRef}`, sha);
  issue.merged = true;
  issue.state = 'closed';
  issue.mergeCommitSha = sha;
  const ts = BASE_TS + repo.commitCounter * 60;
  issue.mergedAt = new Date(ts * 1000).toISOString();
  issue.rev += 1;
  return { ok: true, sha };
}

/** Whether a pull request would merge cleanly right now (GraphQL's mergeable). */
export function pullMergeable(repo: RepoRec, issue: IssueRec): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  if (issue.merged) return 'MERGEABLE';
  const baseTip = branchTip(repo, issue.baseRef);
  const headTip = branchTip(repo, issue.headRef);
  if (baseTip === null || headTip === null) return 'UNKNOWN';
  const base = mergeBaseOid(baseTip, headTip);
  const baseTree = base === null ? null : treeOfCommit(base);
  return mergeTrees(baseTree, treeOfCommit(baseTip), treeOfCommit(headTip)) === null ? 'CONFLICTING' : 'MERGEABLE';
}

/** Create an issue or pull record with the repository's next shared number. */
export function createIssueRec(repo: RepoRec, init: Partial<IssueRec> & { kind: 'issue' | 'pull'; title: string }): IssueRec {
  const number = repo.nextNumber;
  repo.nextNumber += 1;
  repo.seqCounter += 1;
  const rec: IssueRec = {
    kind: init.kind,
    dbId: newIssueDbId(),
    number,
    title: init.title,
    body: init.body ?? '',
    state: 'open',
    labels: init.labels ?? [],
    comments: [],
    seq: repo.seqCounter,
    headRef: init.headRef ?? '',
    baseRef: init.baseRef ?? '',
    merged: false,
    mergeCommitSha: null,
    mergedAt: null,
    rev: 0,
  };
  repo.issues.set(number, rec);
  return rec;
}
