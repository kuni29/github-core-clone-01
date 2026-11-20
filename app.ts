// app.ts: the forge's HTTP surface — git smart HTTP (upload-pack v2 + v0 fallback,
// receive-pack v0), the REST v3 API, GraphQL v4 (gql.ts) and the MCP endpoint, all over the
// store in forge.ts. main.ts owns the lifecycle; this file is only the server.
//
// Wire discipline the suite grades: every REST reply is application/json with a non-empty
// X-GitHub-Request-Id; errors are JSON with a string message; a request without the trial's
// bearer token is 401; a repository under any owner but the token's login is 404, never 403.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  VIEWER,
  ZERO_OID,
  branchTip,
  buildPack,
  commitOf,
  createIssueRec,
  createRepo,
  deleteRepo,
  diffTrees,
  flattenTree,
  getObject,
  getRepo,
  hasObject,
  isAncestor,
  listRepos,
  mergeBaseOid,
  mergePullRequest,
  newCommentId,
  peelCommitOid,
  planFetch,
  storeObject,
  tagTarget,
  treeOfCommit,
  unpackPack,
  writeFileOnBranch,
  type IssueRec,
  type RepoRec,
} from './forge.ts';
import { handleGraphQLBody } from './gql.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const AGENT = 'github-core-clone/1.0';
const EPOCH_BASE = 1735689600;

let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter.toString(36)}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const payload = Buffer.from(`${JSON.stringify(body)}\n`, 'utf8');
  res.sendDate = false;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': payload.length,
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  res.end(payload);
}

/** Send a body that is already serialized JSON (sendJson's framing, minus the stringify). */
function sendJsonText(res: ServerResponse, status: number, text: string): void {
  const payload = Buffer.from(`${text}\n`, 'utf8');
  res.sendDate = false;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': payload.length,
    'x-github-request-id': nextRequestId(),
  });
  res.end(payload);
}

function sendEmpty(res: ServerResponse, status: number): void {
  res.sendDate = false;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'x-github-request-id': nextRequestId() });
  res.end();
}

function sendPlain(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.sendDate = false;
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  // Event-driven collection: the async-iterator form wraps every chunk in promise
  // machinery, which is the most expensive part of reading a small body.
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let settled = false;
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      settled = true;
      resolve(chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks));
    });
    req.on('error', (err) => {
      settled = true;
      reject(err);
    });
    req.on('close', () => {
      if (!settled) reject(new Error('request body aborted'));
    });
  });
}

let cachedToken: string | null = null;

/** The trial token is fixed before the process starts; read the environment once. */
function expectedToken(): string {
  if (cachedToken === null) cachedToken = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  return cachedToken;
}

function authed(req: IncomingMessage): boolean {
  const header = req.headers['authorization'];
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const token = header.slice('Bearer '.length);
  const expected = expectedToken();
  return expected === '' ? token.length > 0 : token === expected;
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function pathSegments(pathname: string): string[] {
  return pathname.split('/').filter((segment) => segment !== '').map(decodeSegment);
}

function remainderAfter(pathname: string, prefix: string): string | null {
  if (pathname === prefix) return '';
  if (pathname.startsWith(`${prefix}/`)) {
    return pathname
      .slice(prefix.length + 1)
      .split('/')
      .map(decodeSegment)
      .join('/');
  }
  return null;
}

const isoCache = new Map<number, string>();

/** A counter's ISO instant; a pure function of the counter, so answers are memoized. */
function isoFromCounter(seq: number): string {
  const hit = isoCache.get(seq);
  if (hit !== undefined) return hit;
  const text = new Date((EPOCH_BASE + seq * 60) * 1000).toISOString();
  isoCache.set(seq, text);
  return text;
}

// ---------------------------------------------------------------- pkt-lines

function pktLine(data: string | Buffer): Buffer {
  const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const head = (payload.length + 4).toString(16).padStart(4, '0');
  return Buffer.concat([Buffer.from(head, 'ascii'), payload]);
}

const FLUSH_PKT = Buffer.from('0000', 'ascii');

interface Pkt {
  kind: 'data' | 'flush' | 'delim' | 'response-end';
  payload: Buffer;
}

class PktReader {
  private pos = 0;
  private readonly buf: Buffer;

  constructor(buf: Buffer) {
    this.buf = buf;
  }

  get offset(): number {
    return this.pos;
  }

  next(): Pkt | null {
    if (this.pos >= this.buf.length) return null;
    if (this.pos + 4 > this.buf.length) throw new Error('truncated pkt-line');
    const head = this.buf.toString('ascii', this.pos, this.pos + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(head)) throw new Error('invalid pkt-line length');
    const length = parseInt(head, 16);
    if (length === 0) {
      this.pos += 4;
      return { kind: 'flush', payload: Buffer.alloc(0) };
    }
    if (length === 1) {
      this.pos += 4;
      return { kind: 'delim', payload: Buffer.alloc(0) };
    }
    if (length === 2) {
      this.pos += 4;
      return { kind: 'response-end', payload: Buffer.alloc(0) };
    }
    if (length < 4 || this.pos + length > this.buf.length) throw new Error('pkt-line overruns body');
    const payload = this.buf.subarray(this.pos + 4, this.pos + length);
    this.pos += length;
    return { kind: 'data', payload };
  }
}

function sidebandPackets(data: Buffer, band: number): Buffer[] {
  const packets: Buffer[] = [];
  // A pkt-line is at most 65520 bytes on the wire for the suite's client, header and band
  // byte included, so one packet carries at most 65515 bytes of pack data.
  const maxPayload = 65515;
  for (let offset = 0; offset < data.length; offset += maxPayload) {
    const chunk = data.subarray(offset, Math.min(data.length, offset + maxPayload));
    packets.push(pktLine(Buffer.concat([Buffer.from([band]), chunk])));
  }
  if (packets.length === 0) packets.push(pktLine(Buffer.from([band])));
  return packets;
}

// ---------------------------------------------------------------- git smart HTTP

interface RefLine {
  oid: string;
  name: string;
}

/** Advertisement ref lines: branches and tags sorted, annotated tags followed by their peel. */
function advertisedRefs(repo: RepoRec): RefLine[] {
  const lines: RefLine[] = [];
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name)!;
    lines.push({ oid, name });
    const target = tagTarget(oid);
    if (target !== null) {
      const peeled = peelCommitOid(oid);
      if (peeled !== null && peeled !== oid) lines.push({ oid: peeled, name: `${name}^{}` });
    }
  }
  return lines;
}

function headTarget(repo: RepoRec): string {
  return `refs/heads/${repo.defaultBranch}`;
}

function v0Advertisement(repo: RepoRec, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps =
    service === 'git-upload-pack'
      ? `multi_ack_detailed no-done side-band-64k thin-pack ofs-delta symref=HEAD:${headTarget(repo)} agent=${AGENT}`
      : `report-status delete-refs side-band-64k ofs-delta symref=HEAD:${headTarget(repo)} agent=${AGENT}`;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), FLUSH_PKT];
  const refs = advertisedRefs(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
    return Buffer.concat(parts);
  }
  const headOid = repo.refs.get(headTarget(repo)) ?? ZERO_OID;
  parts.push(pktLine(`${headOid} HEAD\0${caps}\n`));
  for (const ref of refs) parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
  return Buffer.concat(parts);
}

/** The v2 advertisement never changes, so it is framed once and shared by every answer. */
const V2_ADVERTISEMENT: Buffer = Buffer.concat([
  pktLine('version 2\n'),
  pktLine(`agent=${AGENT}\n`),
  pktLine('ls-refs=unborn\n'),
  pktLine('fetch=shallow\n'),
  pktLine('object-format=sha1\n'),
  FLUSH_PKT,
]);

function v2Advertisement(): Buffer {
  return V2_ADVERTISEMENT;
}

function handleInfoRefs(req: IncomingMessage, res: ServerResponse, repo: RepoRec, url: RequestUrl): void {
  const service = url.searchParams.get('service');
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    sendPlain(res, 400, 'text/plain; charset=utf-8', Buffer.from('missing or unknown service\n'));
    return;
  }
  if (service === 'git-upload-pack') {
    const protocol = req.headers['git-protocol'];
    if (typeof protocol === 'string' && protocol.includes('version=2')) {
      sendPlain(res, 200, 'application/x-git-upload-pack-advertisement', v2Advertisement());
      return;
    }
    sendPlain(res, 200, 'application/x-git-upload-pack-advertisement', v0Advertisement(repo, service));
    return;
  }
  sendPlain(res, 200, 'application/x-git-receive-pack-advertisement', v0Advertisement(repo, service));
}

/** Read pkt-lines until a flush (or the body ends); returns the data lines and the reader. */
function readPktSection(reader: PktReader): string[] {
  const lines: string[] = [];
  for (;;) {
    const packet = reader.next();
    if (packet === null || packet.kind === 'flush') return lines;
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8').replace(/\n$/, ''));
  }
}

function handleLsRefs(res: ServerResponse, repo: RepoRec, reader: PktReader): void {
  // The command section was already consumed by the caller up to the delim.
  const args = readPktSection(reader);
  let peel = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const arg of args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'unborn') unborn = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const lines: string[] = [];
  const target = headTarget(repo);
  const headOid = repo.refs.get(target);
  if (keep('HEAD')) {
    if (headOid !== undefined) lines.push(`${headOid} HEAD symref-target:${target}\n`);
    else if (unborn) lines.push(`unborn HEAD symref-target:${target}\n`);
  }
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    if (!keep(name)) continue;
    const oid = repo.refs.get(name)!;
    let line = `${oid} ${name}`;
    if (peel) {
      const peeled = peelCommitOid(oid);
      if (peeled !== null && peeled !== oid) line += ` peeled:${peeled}`;
    }
    lines.push(`${line}\n`);
  }
  const body = Buffer.concat([...lines.map((line) => pktLine(line)), FLUSH_PKT]);
  sendPlain(res, 200, 'application/x-git-upload-pack-result', body);
}

function fetchResponse(plan: { objects: string[]; shallow: string[]; unshallow: string[] }, haves: string[], done: boolean): Buffer {
  const parts: Buffer[] = [];
  if (haves.length > 0) {
    parts.push(pktLine('acknowledgments\n'));
    const acked = haves.filter((have) => hasObject(have));
    if (acked.length === 0) parts.push(pktLine('NAK\n'));
    else for (const have of acked) parts.push(pktLine(`ACK ${have}\n`));
    if (done) parts.push(pktLine('ready\n'));
    parts.push(FLUSH_PKT);
  }
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(FLUSH_PKT);
  }
  parts.push(pktLine('packfile\n'));
  const pack = buildPack(plan.objects);
  for (const packet of sidebandPackets(pack, 1)) parts.push(packet);
  parts.push(FLUSH_PKT);
  return Buffer.concat(parts);
}

function handleFetchV2(res: ServerResponse, reader: PktReader): void {
  const args = readPktSection(reader);
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let deepen: number | null = null;
  let done = false;
  for (const arg of args) {
    if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) shallow.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) deepen = parseInt(arg.slice(7).trim(), 10);
    else if (arg === 'done') done = true;
  }
  const plan = planFetch(wants, haves, shallow, Number.isFinite(deepen) ? deepen : null);
  sendPlain(res, 200, 'application/x-git-upload-pack-result', fetchResponse(plan, haves, done));
}

function handleFetchV0(res: ServerResponse, reader: PktReader): void {
  const wantSection = readPktSection(reader);
  const wants: string[] = [];
  const shallow: string[] = [];
  let deepen: number | null = null;
  for (const line of wantSection) {
    if (line.startsWith('want ')) wants.push(line.slice(5).split(' ')[0]!);
    else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) deepen = parseInt(line.slice(7).trim(), 10);
  }
  const haveSection = readPktSection(reader);
  const haves: string[] = [];
  for (const line of haveSection) {
    if (line.startsWith('have ')) haves.push(line.slice(5).trim());
  }
  const plan = planFetch(wants, haves, shallow, deepen);
  const parts: Buffer[] = [];
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(pktLine('NAK\n'));
  const pack = buildPack(plan.objects);
  for (const packet of sidebandPackets(pack, 1)) parts.push(packet);
  parts.push(FLUSH_PKT);
  sendPlain(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
}

function handleUploadPack(res: ServerResponse, repo: RepoRec, body: Buffer): void {
  const reader = new PktReader(body);
  // Command section: data lines up to a delim (v2) or a flush (v0).
  const commandLines: string[] = [];
  let sawDelim = false;
  for (;;) {
    const packet = reader.next();
    if (packet === null) break;
    if (packet.kind === 'delim') {
      sawDelim = true;
      break;
    }
    if (packet.kind === 'flush') break;
    if (packet.kind === 'data') commandLines.push(packet.payload.toString('utf8').replace(/\n$/, ''));
  }
  const command = commandLines.find((line) => line.startsWith('command='));
  if (command === 'command=ls-refs') {
    handleLsRefs(res, repo, reader);
    return;
  }
  if (command === 'command=fetch') {
    handleFetchV2(res, reader);
    return;
  }
  if (command !== undefined) {
    sendPlain(res, 400, 'text/plain; charset=utf-8', Buffer.from('unknown command\n'));
    return;
  }
  // No command line: a v0 fetch request (want lines first).
  const v0Reader = new PktReader(body);
  handleFetchV0(res, v0Reader);
}

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function handleReceivePack(res: ServerResponse, repo: RepoRec, body: Buffer): void {
  const reader = new PktReader(body);
  const lines = readPktSection(reader);
  const pack = body.subarray(reader.offset);
  const commands: PushCommand[] = [];
  let sideband = false;
  lines.forEach((rawLine, index) => {
    let line = rawLine;
    if (index === 0) {
      const nul = line.indexOf('\0');
      if (nul >= 0) {
        const caps = line.slice(nul + 1);
        if (caps.split(' ').includes('side-band-64k')) sideband = true;
        line = line.slice(0, nul);
      }
    }
    const parts = line.split(' ');
    if (parts.length === 3) commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts[2]! });
  });

  let unpackError: string | null = null;
  if (pack.length > 0) {
    try {
      unpackPack(pack);
    } catch (error) {
      unpackError = error instanceof Error ? error.message : String(error);
    }
  }

  const reportLines: string[] = [];
  reportLines.push(unpackError === null ? 'unpack ok\n' : `unpack ${unpackError.replace(/[\r\n]+/g, ' ')}\n`);
  for (const command of commands) {
    const fail = (reason: string): void => {
      reportLines.push(`ng ${command.ref} ${reason}\n`);
    };
    const ok = (): void => {
      reportLines.push(`ok ${command.ref}\n`);
    };
    if (unpackError !== null) {
      fail('unpacker error');
      continue;
    }
    const current = repo.refs.get(command.ref) ?? ZERO_OID;
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (!repo.refs.has(command.ref)) ok();
      else if (command.ref === headTarget(repo)) fail('deletion of the current branch prohibited');
      else {
        repo.refs.delete(command.ref);
        ok();
      }
      continue;
    }
    if (getObject(command.newOid) === undefined) {
      fail('not a valid object');
      continue;
    }
    if (command.oldOid === ZERO_OID) {
      if (repo.refs.has(command.ref)) fail('reference already exists');
      else {
        repo.refs.set(command.ref, command.newOid);
        ok();
      }
      continue;
    }
    if (current !== command.oldOid) {
      fail('stale info');
      continue;
    }
    if (!isAncestor(command.oldOid, command.newOid)) {
      fail('non-fast-forward');
      continue;
    }
    repo.refs.set(command.ref, command.newOid);
    ok();
  }

  const report = Buffer.concat([...reportLines.map((line) => pktLine(line)), FLUSH_PKT]);
  let responseBody: Buffer;
  if (sideband) {
    responseBody = Buffer.concat([...sidebandPackets(report, 1), FLUSH_PKT]);
  } else {
    responseBody = report;
  }
  sendPlain(res, 200, 'application/x-git-receive-pack-result', responseBody);
}

async function handleGit(req: IncomingMessage, res: ServerResponse, segments: string[], url: RequestUrl): Promise<void> {
  const [owner, repoGit, ...rest] = segments;
  const repoName = repoGit!.endsWith('.git') ? repoGit!.slice(0, -4) : repoGit!;
  const repo = owner === VIEWER.login ? getRepo(repoName) : undefined;
  if (repo === undefined) {
    sendPlain(res, 404, 'text/plain; charset=utf-8', Buffer.from('repository not found\n'));
    return;
  }
  const tail = rest.join('/');
  if (req.method === 'GET' && tail === 'info/refs') {
    handleInfoRefs(req, res, repo, url);
    return;
  }
  if (req.method === 'POST' && tail === 'git-upload-pack') {
    const body = await readBody(req);
    try {
      handleUploadPack(res, repo, body);
    } catch {
      sendPlain(res, 400, 'text/plain; charset=utf-8', Buffer.from('bad upload-pack request\n'));
    }
    return;
  }
  if (req.method === 'POST' && tail === 'git-receive-pack') {
    const body = await readBody(req);
    try {
      handleReceivePack(res, repo, body);
    } catch {
      sendPlain(res, 400, 'text/plain; charset=utf-8', Buffer.from('bad receive-pack request\n'));
    }
    return;
  }
  sendPlain(res, 404, 'text/plain; charset=utf-8', Buffer.from('not found\n'));
}

// ---------------------------------------------------------------- REST v3

type JsonBody = { ok: true; value: Record<string, unknown> } | { ok: false };

function parseJsonBody(buf: Buffer): JsonBody {
  if (buf.length === 0) return { ok: true, value: {} };
  try {
    const value = JSON.parse(buf.toString('utf8')) as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ok: true, value: {} };
    return { ok: true, value: value as Record<string, unknown> };
  } catch {
    return { ok: false };
  }
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function repoJson(repo: RepoRec): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: `${VIEWER.login}/${repo.name}`,
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    owner: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    html_url: `https://github.example/${VIEWER.login}/${repo.name}`,
    url: `https://api.github.example/repos/${VIEWER.login}/${repo.name}`,
    created_at: isoFromCounter(repo.id),
    updated_at: isoFromCounter(repo.id),
  };
}

function labelsJson(repo: RepoRec, issue: IssueRec): Array<Record<string, unknown>> {
  return issue.labels.map((name) => {
    const label = repo.labels.get(name);
    return { name, color: label?.color ?? 'ededed', default: false, description: null };
  });
}

function issueJson(repo: RepoRec, issue: IssueRec): Record<string, unknown> {
  const body: Record<string, unknown> = {
    id: issue.dbId,
    node_id: `I_${issue.dbId}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: labelsJson(repo, issue),
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    comments: issue.comments.length,
    created_at: isoFromCounter(issue.seq),
    updated_at: isoFromCounter(issue.seq),
    html_url: `https://github.example/${VIEWER.login}/${repo.name}/issues/${issue.number}`,
  };
  if (issue.kind === 'pull') {
    body.pull_request = { url: `https://api.github.example/repos/${VIEWER.login}/${repo.name}/pulls/${issue.number}` };
  }
  return body;
}

/**
 * The serialized issueJson for a record, cached against the record's rev: every mutation
 * site (REST PATCH, comment posts, GraphQL close/comment, a merge) bumps rev, so a cached
 * body is exactly the body issueJson would build now. Labels are immutable once created
 * and the repository's name never changes, so nothing else the body reads can drift.
 */
const issueJsonTextCache = new WeakMap<IssueRec, { rev: number; text: string }>();

function issueJsonText(repo: RepoRec, issue: IssueRec): string {
  const hit = issueJsonTextCache.get(issue);
  if (hit !== undefined && hit.rev === issue.rev) return hit.text;
  const text = JSON.stringify(issueJson(repo, issue));
  issueJsonTextCache.set(issue, { rev: issue.rev, text });
  return text;
}

function pullJson(repo: RepoRec, issue: IssueRec): Record<string, unknown> {
  const headTip = branchTip(repo, issue.headRef);
  const baseTip = branchTip(repo, issue.baseRef);
  const body = issueJson(repo, issue);
  delete body.pull_request;
  body.html_url = `https://github.example/${VIEWER.login}/${repo.name}/pull/${issue.number}`;
  body.head = {
    ref: issue.headRef,
    sha: headTip,
    label: `${VIEWER.login}:${issue.headRef}`,
    user: { login: VIEWER.login, id: VIEWER.id },
    repo: repoJson(repo),
  };
  body.base = {
    ref: issue.baseRef,
    sha: baseTip,
    label: `${VIEWER.login}:${issue.baseRef}`,
    user: { login: VIEWER.login, id: VIEWER.id },
    repo: repoJson(repo),
  };
  body.merged = issue.merged;
  body.merged_at = issue.mergedAt;
  body.merge_commit_sha = issue.mergeCommitSha;
  return body;
}

function commentJson(comment: { id: number; body: string }): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: `C_${comment.id}`,
    body: comment.body,
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: isoFromCounter(comment.id),
    updated_at: isoFromCounter(comment.id),
  };
}

interface PageResult<T> {
  items: T[];
  headers: Record<string, string>;
}

function paginate<T>(req: IncomingMessage, url: RequestUrl, items: T[]): PageResult<T> {
  const perPageRaw = parseInt(url.searchParams.get('per_page') ?? '30', 10);
  const perPage = Number.isFinite(perPageRaw) ? Math.min(100, Math.max(1, perPageRaw)) : 30;
  const pageRaw = parseInt(url.searchParams.get('page') ?? '1', 10);
  const page = Number.isFinite(pageRaw) ? Math.max(1, pageRaw) : 1;
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  const host = req.headers.host ?? '127.0.0.1';
  const pageUrl = (p: number): string => {
    const params = new URLSearchParams(url.searchParams);
    params.set('page', String(p));
    params.set('per_page', String(perPage));
    return `http://${host}${url.pathname}?${params.toString()}`;
  };
  const lastPage = Math.max(1, Math.ceil(items.length / perPage));
  const links: string[] = [];
  if (page < lastPage) {
    links.push(`<${pageUrl(page + 1)}>; rel="next"`);
    links.push(`<${pageUrl(lastPage)}>; rel="last"`);
  }
  if (page > 1) {
    links.push(`<${pageUrl(page - 1)}>; rel="prev"`);
    links.push(`<${pageUrl(1)}>; rel="first"`);
  }
  if (links.length > 0) headers.link = links.join(', ');
  return { items: slice, headers };
}

function notFound(res: ServerResponse): void {
  sendJson(res, 404, { message: 'Not Found' });
}

function validationFailed(res: ServerResponse, message: string): void {
  sendJson(res, 422, { message });
}

/** Resolve a branch name, full ref or commit oid to a commit oid. */
function resolveCommit(repo: RepoRec, ref: string): string | null {
  if (ref === '') return null;
  const byBranch = repo.refs.get(`refs/heads/${ref}`);
  if (byBranch !== undefined) return byBranch;
  const byRef = repo.refs.get(ref);
  if (byRef !== undefined) return peelCommitOid(byRef) ?? byRef;
  const obj = getObject(ref);
  if (obj !== undefined && obj.type === 'commit') return ref;
  if (obj !== undefined && obj.type === 'tag') return peelCommitOid(ref);
  return null;
}

function commitJson(oid: string): Record<string, unknown> | null {
  const info = commitOf(oid);
  if (info === null) return null;
  const parseIdentity = (line: string): { name: string; email: string; date: string } => {
    const match = /^(.*) <(.*)> (\d+) [+-]\d{4}$/.exec(line);
    if (match === null) return { name: line, email: '', date: isoFromCounter(0) };
    return { name: match[1]!, email: match[2]!, date: new Date(parseInt(match[3]!, 10) * 1000).toISOString() };
  };
  return {
    sha: oid,
    node_id: `C_${oid}`,
    commit: {
      message: info.message,
      tree: { sha: info.tree },
      author: parseIdentity(info.author),
      committer: parseIdentity(info.committer),
    },
    parents: info.parents.map((parent) => ({ sha: parent })),
    author: { login: VIEWER.login },
    committer: { login: VIEWER.login },
  };
}

function walkCommits(tip: string): string[] {
  const order: string[] = [];
  const seen = new Set<string>();
  const stack: string[] = [tip];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const info = commitOf(oid);
    if (info === null) continue;
    order.push(oid);
    for (let i = info.parents.length - 1; i >= 0; i -= 1) stack.push(info.parents[i]!);
  }
  return order;
}

function labelNamesOf(body: Record<string, unknown>): string[] {
  const raw = body.labels;
  if (!Array.isArray(raw)) return [];
  const names: string[] = [];
  for (const entry of raw) {
    if (typeof entry === 'string') names.push(entry);
    else if (typeof entry === 'object' && entry !== null && typeof (entry as { name?: unknown }).name === 'string') {
      names.push((entry as { name: string }).name);
    }
  }
  return names;
}

async function handleRest(req: IncomingMessage, res: ServerResponse, url: RequestUrl): Promise<void> {
  const method = req.method ?? 'GET';
  const pathname = url.pathname;
  const segments = pathSegments(pathname);

  // The API root and meta are answered before the body is read.
  if (method === 'GET' && segments.length === 2 && segments[0] === 'api' && segments[1] === 'v3') {
    sendJson(
      res,
      200,
      {
        current_user_url: '/api/v3/user',
        repository_url: '/api/v3/repos/{owner}/{repo}',
        issue_search_url: '/api/v3/search/issues',
        rate_limit_url: '/api/v3/rate_limit',
      },
      { 'x-oauth-scopes': 'repo, read:org' },
    );
    return;
  }

  const needsBody = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
  let body: Record<string, unknown> = {};
  if (needsBody) {
    const raw = await readBody(req);
    const parsed = parseJsonBody(raw);
    if (!parsed.ok) {
      sendJson(res, 400, { message: 'Malformed JSON in request body' });
      return;
    }
    body = parsed.value;
  }

  // /api/v3/meta
  if (method === 'GET' && segments.length === 3 && segments[2] === 'meta') {
    sendJson(res, 200, { installed_version: '1.0.0', hooks: [], pages: [], importer: [] });
    return;
  }

  // /api/v3/user
  if (method === 'GET' && segments.length === 3 && segments[2] === 'user') {
    sendJson(res, 200, {
      login: VIEWER.login,
      id: VIEWER.id,
      name: VIEWER.name,
      email: VIEWER.email,
      type: 'User',
      site_admin: false,
    });
    return;
  }

  // /api/v3/user/repos
  if (segments.length === 4 && segments[2] === 'user' && segments[3] === 'repos') {
    if (method === 'GET') {
      const page = paginate(req, url, listRepos().map(repoJson));
      sendJson(res, 200, page.items, page.headers);
      return;
    }
    if (method === 'POST') {
      const name = str(body.name);
      if (name === '') {
        validationFailed(res, 'Repository creation failed: name is required');
        return;
      }
      if (getRepo(name) !== undefined) {
        validationFailed(res, `Repository creation failed: a repository named '${name}' already exists for this account`);
        return;
      }
      const repo = createRepo(name, str(body.description), body.private === true);
      sendJson(res, 201, repoJson(repo));
      return;
    }
  }

  // Everything below is /api/v3/repos/{owner}/{repo}/...
  if (segments.length >= 5 && segments[2] === 'repos') {
    const owner = segments[3]!;
    const repoName = segments[4]!;
    const repo = owner === VIEWER.login ? getRepo(repoName) : undefined;
    if (repo === undefined) {
      notFound(res);
      return;
    }
    const rest = segments.slice(5);

    if (rest.length === 0) {
      if (method === 'GET') {
        sendJson(res, 200, repoJson(repo));
        return;
      }
      if (method === 'PATCH') {
        if (typeof body.description === 'string') repo.description = body.description;
        if (typeof body.private === 'boolean') repo.isPrivate = body.private;
        if (typeof body.default_branch === 'string' && body.default_branch !== '') repo.defaultBranch = body.default_branch;
        sendJson(res, 200, repoJson(repo));
        return;
      }
      if (method === 'DELETE') {
        deleteRepo(repo.name);
        sendEmpty(res, 204);
        return;
      }
      notFound(res);
      return;
    }

    // branches
    if (rest[0] === 'branches') {
      if (method === 'GET' && rest.length === 1) {
        const branches = [...repo.refs.entries()]
          .filter(([ref]) => ref.startsWith('refs/heads/'))
          .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha }, protected: false }))
          .sort((a, b) => (a.name < b.name ? -1 : 1));
        sendJson(res, 200, branches);
        return;
      }
      if (method === 'GET') {
        const name = remainderAfter(pathname, `/api/v3/repos/${owner}/${repoName}/branches`) ?? '';
        const sha = repo.refs.get(`refs/heads/${name}`);
        if (sha === undefined) {
          notFound(res);
          return;
        }
        sendJson(res, 200, { name, commit: { sha }, protected: false });
        return;
      }
      notFound(res);
      return;
    }

    // git refs
    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (method === 'GET' && rest.length === 2) {
        const refs = [...repo.refs.entries()]
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([ref, sha]) => ({ ref, object: { sha, type: getObject(sha)?.type ?? 'commit' } }));
        sendJson(res, 200, refs);
        return;
      }
      if (method === 'GET') {
        const ref = remainderAfter(pathname, `/api/v3/repos/${owner}/${repoName}/git/refs`) ?? '';
        const sha = repo.refs.get(ref);
        if (sha === undefined) {
          notFound(res);
          return;
        }
        sendJson(res, 200, { ref, object: { sha, type: getObject(sha)?.type ?? 'commit' } });
        return;
      }
      if (method === 'POST' && rest.length === 2) {
        const ref = str(body.ref);
        const sha = str(body.sha);
        if (!ref.startsWith('refs/') || getObject(sha) === undefined) {
          validationFailed(res, 'Validation Failed: ref or sha is invalid');
          return;
        }
        if (repo.refs.has(ref)) {
          validationFailed(res, `Reference already exists: ${ref}`);
          return;
        }
        repo.refs.set(ref, sha);
        sendJson(res, 201, { ref, object: { sha, type: getObject(sha)?.type ?? 'commit' } });
        return;
      }
      notFound(res);
      return;
    }

    // commits
    if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') {
      const shaParam = url.searchParams.get('sha');
      let tip: string | null;
      if (shaParam !== null && shaParam !== '') tip = resolveCommit(repo, shaParam);
      else tip = branchTip(repo, repo.defaultBranch);
      if (tip === null) {
        sendJson(res, 200, []);
        return;
      }
      const commits = walkCommits(tip)
        .map(commitJson)
        .filter((entry) => entry !== null);
      const page = paginate(req, url, commits);
      sendJson(res, 200, page.items, page.headers);
      return;
    }

    // contents
    if (rest[0] === 'contents') {
      const contentPath = remainderAfter(pathname, `/api/v3/repos/${owner}/${repoName}/contents`) ?? '';
      if (method === 'GET') {
        const refParam = url.searchParams.get('ref');
        const tip = refParam !== null && refParam !== '' ? resolveCommit(repo, refParam) : branchTip(repo, repo.defaultBranch);
        const tree = tip === null ? null : treeOfCommit(tip);
        const flat = flattenTree(tree);
        if (contentPath === '') {
          const entries = treeEntriesOf(repo, tree, '');
          sendJson(res, 200, entries);
          return;
        }
        const file = flat.get(contentPath);
        if (file !== undefined) {
          const data = getObject(file.oid)?.data ?? Buffer.alloc(0);
          sendJson(res, 200, {
            type: 'file',
            encoding: 'base64',
            name: contentPath.split('/').pop(),
            path: contentPath,
            sha: file.oid,
            size: data.length,
            content: data.toString('base64'),
          });
          return;
        }
        const dirEntries = treeEntriesOf(repo, tree, contentPath);
        if (dirEntries !== null) {
          sendJson(res, 200, dirEntries);
          return;
        }
        notFound(res);
        return;
      }
      if (method === 'PUT') {
        const branch = str(body.branch) || repo.defaultBranch;
        const tip = branchTip(repo, branch);
        const effectiveTip = tip ?? branchTip(repo, repo.defaultBranch);
        const flat = flattenTree(effectiveTip === null ? null : treeOfCommit(effectiveTip));
        const existing = flat.get(contentPath);
        if (existing !== undefined) {
          if (body.sha === undefined) {
            validationFailed(res, `Invalid request: "sha" wasn't supplied for the existing file ${contentPath}`);
            return;
          }
          if (str(body.sha) !== existing.oid) {
            sendJson(res, 409, { message: `Conflict: the sha does not match the current blob for ${contentPath}` });
            return;
          }
        }
        const blob = storeObject('blob', Buffer.from(str(body.content), 'base64'));
        const commit = writeFileOnBranch(repo, branch, contentPath, blob, str(body.message) || `Update ${contentPath}`);
        sendJson(res, existing !== undefined ? 200 : 201, {
          content: {
            type: 'file',
            encoding: 'base64',
            name: contentPath.split('/').pop(),
            path: contentPath,
            sha: blob,
            size: Buffer.from(str(body.content), 'base64').length,
          },
          commit: { sha: commit, message: str(body.message) },
        });
        return;
      }
      if (method === 'DELETE') {
        const branch = str(body.branch) || repo.defaultBranch;
        const tip = branchTip(repo, branch);
        const flat = flattenTree(tip === null ? null : treeOfCommit(tip));
        const existing = flat.get(contentPath);
        if (existing === undefined) {
          notFound(res);
          return;
        }
        if (body.sha !== undefined && str(body.sha) !== existing.oid) {
          sendJson(res, 409, { message: `Conflict: the sha does not match the current blob for ${contentPath}` });
          return;
        }
        const commit = writeFileOnBranch(repo, branch, contentPath, null, str(body.message) || `Delete ${contentPath}`);
        sendJson(res, 200, { content: null, commit: { sha: commit, message: str(body.message) } });
        return;
      }
      notFound(res);
      return;
    }

    // labels
    if (rest[0] === 'labels' && rest.length === 1) {
      if (method === 'GET') {
        sendJson(res, 200, [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color, default: false, description: null })));
        return;
      }
      if (method === 'POST') {
        const name = str(body.name);
        if (name === '') {
          validationFailed(res, 'Validation Failed: name is required');
          return;
        }
        if (repo.labels.has(name)) {
          validationFailed(res, `Validation Failed: a label named '${name}' already exists`);
          return;
        }
        const color = str(body.color) || 'ededed';
        repo.labels.set(name, { name, color });
        sendJson(res, 201, { name, color, default: false, description: null });
        return;
      }
      notFound(res);
      return;
    }

    // issues and comments
    if (rest[0] === 'issues') {
      if (rest.length === 1) {
        if (method === 'POST') {
          const names = labelNamesOf(body);
          for (const name of names) {
            if (!repo.labels.has(name)) {
              validationFailed(res, `Validation Failed: the label '${name}' does not exist in this repository`);
              return;
            }
          }
          const issue = createIssueRec(repo, { kind: 'issue', title: str(body.title), body: str(body.body), labels: names });
          sendJson(res, 201, issueJson(repo, issue));
          return;
        }
        if (method === 'GET') {
          const state = url.searchParams.get('state') ?? 'open';
          const direction = (url.searchParams.get('direction') ?? 'desc').toLowerCase();
          let items = [...repo.issues.values()].filter((issue) => issue.kind === 'issue');
          if (state === 'open' || state === 'closed') items = items.filter((issue) => issue.state === state);
          items.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
          const page = paginate(req, url, items.map((issue) => issueJson(repo, issue)));
          sendJson(res, 200, page.items, page.headers);
          return;
        }
        notFound(res);
        return;
      }
      const number = parseInt(rest[1]!, 10);
      const issue = Number.isFinite(number) ? repo.issues.get(number) : undefined;
      if (rest.length === 2) {
        if (issue === undefined) {
          notFound(res);
          return;
        }
        if (method === 'GET') {
          sendJsonText(res, 200, issueJsonText(repo, issue));
          return;
        }
        if (method === 'PATCH') {
          if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
          if (typeof body.title === 'string') issue.title = body.title;
          if (typeof body.body === 'string') issue.body = body.body;
          if (body.labels !== undefined) {
            const names = labelNamesOf(body);
            for (const name of names) {
              if (!repo.labels.has(name)) {
                validationFailed(res, `Validation Failed: the label '${name}' does not exist in this repository`);
                return;
              }
            }
            issue.labels = names;
          }
          issue.rev += 1;
          sendJson(res, 200, issueJson(repo, issue));
          return;
        }
        notFound(res);
        return;
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        if (issue === undefined) {
          notFound(res);
          return;
        }
        if (method === 'POST') {
          const comment = { id: newCommentId(), body: str(body.body) };
          issue.comments.push(comment);
          issue.rev += 1;
          sendJson(res, 201, commentJson(comment));
          return;
        }
        if (method === 'GET') {
          const page = paginate(req, url, issue.comments.map(commentJson));
          sendJson(res, 200, page.items, page.headers);
          return;
        }
        notFound(res);
        return;
      }
      notFound(res);
      return;
    }

    // pulls
    if (rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (method === 'POST') {
          const head = str(body.head).split(':').pop()!;
          const base = str(body.base).split(':').pop()!;
          if (branchTip(repo, head) === null) {
            validationFailed(res, `Validation Failed: the head branch '${head}' does not exist`);
            return;
          }
          if (branchTip(repo, base) === null) {
            validationFailed(res, `Validation Failed: the base branch '${base}' does not exist`);
            return;
          }
          const pull = createIssueRec(repo, { kind: 'pull', title: str(body.title), body: str(body.body), headRef: head, baseRef: base });
          sendJson(res, 201, pullJson(repo, pull));
          return;
        }
        if (method === 'GET') {
          const state = url.searchParams.get('state') ?? 'open';
          let items = [...repo.issues.values()].filter((issue) => issue.kind === 'pull');
          if (state === 'open') items = items.filter((issue) => issue.state === 'open');
          else if (state === 'closed') items = items.filter((issue) => issue.state === 'closed');
          items.sort((a, b) => b.seq - a.seq);
          const page = paginate(req, url, items.map((issue) => pullJson(repo, issue)));
          sendJson(res, 200, page.items, page.headers);
          return;
        }
        notFound(res);
        return;
      }
      const number = parseInt(rest[1]!, 10);
      const pull = Number.isFinite(number) ? repo.issues.get(number) : undefined;
      if (pull === undefined || pull.kind !== 'pull') {
        notFound(res);
        return;
      }
      if (rest.length === 2 && method === 'GET') {
        sendJson(res, 200, pullJson(repo, pull));
        return;
      }
      if (rest.length === 2 && method === 'PATCH') {
        if (body.state === 'open' || body.state === 'closed') pull.state = body.state;
        if (typeof body.title === 'string') pull.title = body.title;
        if (typeof body.body === 'string') pull.body = body.body;
        pull.rev += 1;
        sendJson(res, 200, pullJson(repo, pull));
        return;
      }
      if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
        const baseTip = branchTip(repo, pull.baseRef);
        const headTip = branchTip(repo, pull.headRef);
        if (baseTip === null || headTip === null) {
          sendJson(res, 200, []);
          return;
        }
        const base = mergeBaseOid(baseTip, headTip);
        const diffs = diffTrees(base === null ? null : treeOfCommit(base), treeOfCommit(headTip));
        const page = paginate(req, url, diffs.map((diff) => ({
          filename: diff.filename,
          status: diff.status,
          additions: diff.additions,
          deletions: diff.deletions,
          changes: diff.changes,
        })));
        sendJson(res, 200, page.items, page.headers);
        return;
      }
      if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
        if (pull.merged) {
          sendJson(res, 405, { message: 'Pull Request is not mergeable: it has already been merged' });
          return;
        }
        const outcome = mergePullRequest(repo, pull);
        if (!outcome.ok) {
          if (outcome.reason === 'conflict') {
            sendJson(res, 405, { message: 'Pull Request is not mergeable: conflicts must be resolved first' });
            return;
          }
          notFound(res);
          return;
        }
        sendJson(res, 200, { sha: outcome.sha, merged: true, message: 'Pull Request successfully merged' });
        return;
      }
      notFound(res);
      return;
    }

    notFound(res);
    return;
  }

  notFound(res);
}

/** Directory entries directly under `prefix` ('' is the root), or null when there is no such directory. */
function treeEntriesOf(repo: RepoRec, treeOid: string | null, prefix: string): Array<Record<string, unknown>> | null {
  void repo;
  if (treeOid === null) return prefix === '' ? [] : null;
  // Navigate to the subtree at prefix.
  let current: string | null = treeOid;
  if (prefix !== '') {
    for (const segment of prefix.split('/')) {
      if (current === null) return null;
      const obj = getObject(current);
      if (obj === undefined || obj.type !== 'tree') return null;
      const entry = parseTreeEntries(obj.data).find((candidate) => candidate.name === segment && candidate.mode === '40000');
      current = entry === undefined ? null : entry.oid;
    }
  }
  if (current === null) return null;
  const obj = getObject(current);
  if (obj === undefined || obj.type !== 'tree') return null;
  return parseTreeEntries(obj.data).map((entry) => ({
    type: entry.mode === '40000' ? 'dir' : 'file',
    name: entry.name,
    path: prefix === '' ? entry.name : `${prefix}/${entry.name}`,
    sha: entry.oid,
    size: 0,
  }));
}

function parseTreeEntries(data: Buffer): Array<{ mode: string; name: string; oid: string }> {
  const entries: Array<{ mode: string; name: string; oid: string }> = [];
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    const nul = data.indexOf(0x00, space);
    entries.push({
      mode: data.toString('utf8', pos, space),
      name: data.toString('utf8', space + 1, nul),
      oid: data.toString('hex', nul + 1, nul + 21),
    });
    pos = nul + 21;
  }
  return entries;
}

// ---------------------------------------------------------------- GraphQL

async function handleGraphQL(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') {
    notFound(res);
    return;
  }
  const raw = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    sendJson(res, 400, { errors: [{ message: 'Malformed JSON in request body' }] });
    return;
  }
  sendJson(res, 200, handleGraphQLBody(parsed));
}

// ---------------------------------------------------------------- MCP

const MCP_SERVER_INFO = { name: 'github-core-clone', version: '1.0.0' };
const MCP_REVISIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

function toolDef(
  name: string,
  description: string,
  properties: Record<string, { type: string; description: string }>,
  required: string[],
): McpToolDef {
  return { name, description, inputSchema: { type: 'object', properties, required } };
}

const MCP_TOOLS: McpToolDef[] = [
  toolDef(
    'create_repo',
    'Create a new repository owned by the authenticated user.',
    {
      name: { type: 'string', description: 'The repository name.' },
      description: { type: 'string', description: 'A short description of the repository.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
    },
    ['name'],
  ),
  toolDef(
    'get_repo',
    'Get a repository by owner and name.',
    {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
    },
    ['owner', 'repo'],
  ),
  toolDef(
    'create_issue',
    'Create an issue in a repository.',
    {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The issue title.' },
      body: { type: 'string', description: 'The issue body.' },
    },
    ['owner', 'repo', 'title'],
  ),
  toolDef(
    'list_issues',
    'List the issues of a repository, optionally filtered by state (open, closed or all).',
    {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      state: { type: 'string', description: 'open, closed or all.' },
    },
    ['owner', 'repo'],
  ),
  toolDef(
    'create_pull_request',
    'Create a pull request from a head branch into a base branch.',
    {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The pull request title.' },
      body: { type: 'string', description: 'The pull request body.' },
      head: { type: 'string', description: 'The head branch name.' },
      base: { type: 'string', description: 'The base branch name.' },
    },
    ['owner', 'repo', 'title', 'head', 'base'],
  ),
  toolDef(
    'merge_pull_request',
    'Merge a pull request into its base branch (squash).',
    {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      pull_number: { type: 'integer', description: 'The pull request number.' },
    },
    ['owner', 'repo', 'pull_number'],
  ),
];

class RpcError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

function mcpRepo(args: Record<string, unknown>): RepoRec {
  let owner = str(args.owner);
  let repoName = str(args.repo);
  if ((owner === '' || repoName === '') && typeof args.full_name === 'string') {
    const parts = args.full_name.split('/');
    if (parts.length === 2) {
      owner = parts[0]!;
      repoName = parts[1]!;
    }
  }
  if (owner !== VIEWER.login) throw new Error(`repository ${owner}/${repoName} not found`);
  const repo = getRepo(repoName);
  if (repo === undefined) throw new Error(`repository ${owner}/${repoName} not found`);
  return repo;
}

function requireArgs(args: Record<string, unknown>, names: string[]): void {
  for (const name of names) {
    if (args[name] === undefined || args[name] === null || args[name] === '') {
      throw new RpcError(-32602, `missing required argument: ${name}`);
    }
  }
}

function toolSuccess(value: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value as Record<string, unknown>,
    isError: false,
  };
}

function toolFailure(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function callMcpTool(name: string, args: Record<string, unknown>): Record<string, unknown> {
  const canonical = name.toLowerCase();
  try {
    if (canonical === 'create_repo' || canonical.endsWith('__create_repo')) {
      requireArgs(args, ['name']);
      const repoName = str(args.name);
      if (getRepo(repoName) !== undefined) return toolFailure(`a repository named '${repoName}' already exists`);
      const repo = createRepo(repoName, str(args.description), args.private === true);
      return toolSuccess(repoJson(repo));
    }
    if (canonical === 'get_repo' || canonical.endsWith('__get_repo')) {
      requireArgs(args, ['owner', 'repo']);
      return toolSuccess(repoJson(mcpRepo(args)));
    }
    if (canonical === 'create_issue' || canonical.endsWith('__create_issue')) {
      requireArgs(args, ['owner', 'repo', 'title']);
      const repo = mcpRepo(args);
      const issue = createIssueRec(repo, { kind: 'issue', title: str(args.title), body: str(args.body) });
      return toolSuccess(issueJson(repo, issue));
    }
    if (canonical === 'list_issues' || canonical.endsWith('__list_issues')) {
      requireArgs(args, ['owner', 'repo']);
      const repo = mcpRepo(args);
      const state = str(args.state) || 'open';
      let items = [...repo.issues.values()].filter((issue) => issue.kind === 'issue');
      if (state === 'open' || state === 'closed') items = items.filter((issue) => issue.state === state);
      items.sort((a, b) => a.seq - b.seq);
      return toolSuccess({ issues: items.map((issue) => issueJson(repo, issue)) });
    }
    if (canonical === 'create_pull_request' || canonical.endsWith('__create_pull_request')) {
      requireArgs(args, ['owner', 'repo', 'title', 'head', 'base']);
      const repo = mcpRepo(args);
      const head = str(args.head).split(':').pop()!;
      const base = str(args.base).split(':').pop()!;
      if (branchTip(repo, head) === null) return toolFailure(`head branch '${head}' does not exist`);
      if (branchTip(repo, base) === null) return toolFailure(`base branch '${base}' does not exist`);
      const pull = createIssueRec(repo, { kind: 'pull', title: str(args.title), body: str(args.body), headRef: head, baseRef: base });
      return toolSuccess(pullJson(repo, pull));
    }
    if (canonical === 'merge_pull_request' || canonical.endsWith('__merge_pull_request')) {
      requireArgs(args, ['owner', 'repo']);
      const rawNumber = args.pull_number ?? args.pullNumber ?? args.number;
      if (rawNumber === undefined || rawNumber === null) throw new RpcError(-32602, 'missing required argument: pull_number');
      const repo = mcpRepo(args);
      const pull = repo.issues.get(Number(rawNumber));
      if (pull === undefined || pull.kind !== 'pull') return toolFailure(`pull request ${String(rawNumber)} not found`);
      if (pull.merged) return toolSuccess(pullJson(repo, pull));
      const outcome = mergePullRequest(repo, pull);
      if (!outcome.ok) return toolFailure(`pull request ${pull.number} cannot be merged (${outcome.reason})`);
      const merged = pullJson(repo, pull);
      merged.sha = outcome.sha;
      return toolSuccess(merged);
    }
    throw new RpcError(-32601, `unknown tool: ${name}`);
  } catch (error) {
    if (error instanceof RpcError) throw error;
    return toolFailure(error instanceof Error ? error.message : String(error));
  }
}

function mcpDispatch(message: Record<string, unknown>): Record<string, unknown> | null {
  const method = str(message.method);
  const id = message.id ?? null;
  const params = (typeof message.params === 'object' && message.params !== null ? message.params : {}) as Record<string, unknown>;
  const isNotification = !('id' in message) || message.id === undefined;
  try {
    let result: unknown;
    if (method === 'server/discover') {
      result = {
        resultType: 'complete',
        supportedVersions: MCP_REVISIONS,
        capabilities: { tools: {} },
        serverInfo: MCP_SERVER_INFO,
        _meta: { 'io.modelcontextprotocol/serverInfo': MCP_SERVER_INFO },
      };
    } else if (method === 'initialize') {
      const requested = str(params.protocolVersion);
      result = {
        protocolVersion: MCP_REVISIONS.includes(requested) ? requested : '2025-11-25',
        capabilities: { tools: {} },
        serverInfo: MCP_SERVER_INFO,
      };
    } else if (method === 'ping') {
      result = {};
    } else if (method === 'tools/list') {
      result = { tools: MCP_TOOLS };
    } else if (method === 'tools/call') {
      const toolName = str(params.name);
      const args = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Record<string, unknown>;
      result = callMcpTool(toolName, args);
    } else if (method.startsWith('notifications/')) {
      return null;
    } else {
      throw new RpcError(-32601, `method not found: ${method}`);
    }
    if (isNotification) return null;
    return { jsonrpc: '2.0', id, result };
  } catch (error) {
    if (isNotification) return null;
    if (error instanceof RpcError) return { jsonrpc: '2.0', id, error: { code: error.code, message: error.message } };
    return { jsonrpc: '2.0', id, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } };
  }
}

async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method === 'DELETE') {
    sendEmpty(res, 200);
    return;
  }
  if (req.method !== 'POST') {
    sendEmpty(res, 405);
    return;
  }
  const raw = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  if (Array.isArray(parsed)) {
    const responses: Array<Record<string, unknown>> = [];
    for (const entry of parsed) {
      if (typeof entry === 'object' && entry !== null) {
        const response = mcpDispatch(entry as Record<string, unknown>);
        if (response !== null) responses.push(response);
      }
    }
    sendJson(res, 200, responses);
    return;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } });
    return;
  }
  const response = mcpDispatch(parsed as Record<string, unknown>);
  if (response === null) {
    sendEmpty(res, 202);
    return;
  }
  sendJson(res, 200, response);
}

// ---------------------------------------------------------------- the server

/** The two URL facets the handlers read: the path, and the query as URLSearchParams. */
interface RequestUrl {
  pathname: string;
  searchParams: URLSearchParams;
}

/** Build the server. It binds nothing until the caller listens; main.ts listens on port 0. */
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    handle(req, res).catch(() => {
      try {
        if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
        else res.end();
      } catch {
        // The socket is already gone; nothing more to do.
      }
    });
  });
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // Fast path for origin-form request targets: the pathname is the part before '?' and the
  // query goes to a plain URLSearchParams, with no WHATWG URL parse on the hot path. Only a
  // target that is not origin-form (never sent by the suite) takes the full parse.
  const rawUrl = req.url ?? '/';
  let pathname: string;
  let searchParams: URLSearchParams;
  if (rawUrl.startsWith('/')) {
    const queryAt = rawUrl.indexOf('?');
    pathname = queryAt < 0 ? rawUrl : rawUrl.slice(0, queryAt);
    searchParams = new URLSearchParams(queryAt < 0 ? '' : rawUrl.slice(queryAt + 1));
  } else {
    const parsed = new URL(rawUrl, 'http://entry');
    pathname = parsed.pathname;
    searchParams = parsed.searchParams;
  }
  const requestUrl: RequestUrl = { pathname, searchParams };
  const method = req.method ?? 'GET';

  if (method === 'GET' && pathname === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (pathname === '/mcp') {
    if (!authed(req)) {
      sendJson(res, 401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } });
      return;
    }
    await handleMcp(req, res);
    return;
  }

  if (pathname === '/api/graphql') {
    if (!authed(req)) {
      sendJson(res, 401, { message: 'Unauthorized' });
      return;
    }
    await handleGraphQL(req, res);
    return;
  }

  if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
    if (!authed(req)) {
      sendJson(res, 401, { message: 'Unauthorized' });
      return;
    }
    await handleRest(req, res, requestUrl);
    return;
  }

  const segments = pathSegments(pathname);
  if (segments.length >= 3 && segments[1]!.endsWith('.git')) {
    if (!authed(req)) {
      sendPlain(res, 401, 'text/plain; charset=utf-8', Buffer.from('unauthorized\n'));
      return;
    }
    await handleGit(req, res, segments, requestUrl);
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}
