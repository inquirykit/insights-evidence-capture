// The browser store: captures kept in this profile, with no server. It does what the
// ai_toolkit evidence service does, in the extension's own origin:
//   • re-hashes every artifact against what the capture declared
//   • builds the same record (evidence-capture/record/v3), RFC 8785 canonical, in one chain
//   • signs it with an Ed25519 key made here (WebCrypto, never extractable)
//   • asks an RFC 3161 TSA for a token over the record hash
//   • keeps records, artifacts, tags, notes and todos in IndexedDB, and re-verifies them
// Enrichment is skipped: there is no enricher to ask. What this proves and does not prove is
// in docs/evidence.md: the key lives in the same profile as the analyst, so the timestamp token is
// the independent anchor.
//
// The background script appends and answers the popup and dashboard; the dashboard reads
// artifact bytes directly (store.ts readArtifact), as it does from a server.

import { base64ToBytes, bytesToBase64, bytesToHex, hexToBytes, sha256Hex, utf8 } from './bytes';
import { canonicalize, isCanonical } from './canonical';
import {
  ARTIFACT_NAME,
  MAX_CASE_NAME,
  MAX_NOTE,
  MAX_NOTES,
  MAX_TAG,
  MAX_TAGS,
  MAX_TODO,
  MAX_TODOS,
  normalizeTag,
} from './limits';
import type {
  AnalystNote,
  Annotation,
  AnnotationChange,
  CaptureDetail,
  CaptureRecord,
  CaptureSummary,
  Case,
  CaseTodos,
  ClientMetadata,
  Todo,
  TodoChange,
  UploadResult,
  VerifyReport,
} from './protocol';
import type { EvidenceStore, IncomingArtifact } from './store';
import { DEFAULT_TSA_URL, requestTimestamp, TsaError, verifyToken } from './tsa';

export const SCHEMA = 'evidence-capture/record/v3';
export const SERVICE_NAME = 'insights-evidence-capture';
const WORKSPACE_ID = 'browser';
const GENESIS_HASH = '0'.repeat(64);
const DEFAULT_CASE: Case = { id: 'inbox', name: 'Inbox', createdAt: '' };

export class StoreError extends Error {}

// ---------------------------------------------------------------------------
// IndexedDB

const DB_NAME = 'insights-evidence-capture';
const DB_VERSION = 1;

interface CaptureRow {
  captureId: string;
  seq: number;
  caseId: string;
  receivedAt: string;
  /** The canonical bytes, as text: what was hashed and signed */
  recordJson: string;
  recordHash: string;
  /** Hex, 64 bytes */
  signature: string;
  tsr: ArrayBuffer | null;
  tsaGenTime: string | null;
  tsaError: string | null;
  url: string | null;
  title: string | null;
}

interface ArtifactRow {
  captureId: string;
  name: string;
  mediaType: string;
  size: number;
  sha256: string;
  blob: Blob;
}

interface AnnotationRow {
  captureId: string;
  caseId: string;
  tags: string[];
  notes: AnalystNote[];
  updatedAt: string;
}

interface TodoRow {
  caseId: string;
  items: Todo[];
  updatedAt: string;
}

interface SigningKeyRow {
  key: 'signingKey';
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  publicRaw: ArrayBuffer;
  createdAt: string;
}

type StoreName = 'cases' | 'captures' | 'artifacts' | 'annotations' | 'todos' | 'meta';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  const opening: Promise<IDBDatabase> = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('cases', { keyPath: 'id' });
      const captures = db.createObjectStore('captures', { keyPath: 'captureId' });
      captures.createIndex('seq', 'seq', { unique: true });
      captures.createIndex('caseId', 'caseId');
      db.createObjectStore('artifacts', { keyPath: ['captureId', 'name'] }).createIndex('captureId', 'captureId');
      db.createObjectStore('annotations', { keyPath: 'captureId' }).createIndex('caseId', 'caseId');
      db.createObjectStore('todos', { keyPath: 'caseId' });
      db.createObjectStore('meta', { keyPath: 'key' });
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => reject(req.error ?? new StoreError('IndexedDB could not be opened'));
    req.onblocked = () => reject(new StoreError('IndexedDB is open in another extension page; close it and retry'));
  }).catch((e: unknown) => {
    dbPromise = null;
    throw e;
  });
  dbPromise = opening;
  return opening;
}

const request = <T>(r: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new StoreError('IndexedDB request failed'));
  });

const finished = (tx: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new StoreError('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new StoreError('IndexedDB transaction aborted'));
  });

async function transaction(names: StoreName | StoreName[], mode: IDBTransactionMode = 'readonly') {
  const db = await openDb();
  return db.transaction(names, mode);
}

async function getOne<T>(name: StoreName, key: IDBValidKey): Promise<T | undefined> {
  const tx = await transaction(name);
  return request(tx.objectStore(name).get(key) as IDBRequest<T | undefined>);
}

async function getAll<T>(name: StoreName, index?: string, query?: IDBValidKey | IDBKeyRange): Promise<T[]> {
  const tx = await transaction(name);
  const store = tx.objectStore(name);
  return request((index ? store.index(index) : store).getAll(query) as IDBRequest<T[]>);
}

async function putOne(name: StoreName, value: unknown): Promise<void> {
  const tx = await transaction(name, 'readwrite');
  tx.objectStore(name).put(value);
  await finished(tx);
}

const nowIso = () => new Date().toISOString();

// ---------------------------------------------------------------------------
// The signing key: made once, kept in IndexedDB as a non-extractable CryptoKey

export interface SigningKey {
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  /** The raw 32-byte public key */
  publicRaw: Uint8Array<ArrayBuffer>;
  /** SHA-256 over the raw public key, hex: how each record names the key it was signed with */
  fingerprint: string;
}

let keyPromise: Promise<SigningKey> | null = null;

export function signingKey(): Promise<SigningKey> {
  keyPromise ??= loadOrCreateKey().catch((e) => {
    keyPromise = null;
    throw e;
  });
  return keyPromise;
}

async function loadOrCreateKey(): Promise<SigningKey> {
  let row = await getOne<SigningKeyRow>('meta', 'signingKey');
  if (!row) {
    let pair: CryptoKeyPair;
    try {
      pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify'])) as CryptoKeyPair;
    } catch (e) {
      throw new StoreError(
        'This browser cannot sign records: Ed25519 is not available in WebCrypto ' +
          `(Chrome 137 or Firefox 130 and later have it). ${e instanceof Error ? e.message : ''}`.trim(),
      );
    }
    const publicRaw = await crypto.subtle.exportKey('raw', pair.publicKey);
    const fresh: SigningKeyRow = { key: 'signingKey', privateKey: pair.privateKey, publicKey: pair.publicKey, publicRaw, createdAt: nowIso() };
    // `add` fails if another context made one meanwhile; then that one is read back and kept.
    const tx = await transaction('meta', 'readwrite');
    tx.objectStore('meta').add(fresh);
    await finished(tx).catch(() => {});
    row = (await getOne<SigningKeyRow>('meta', 'signingKey')) ?? fresh;
  }
  const publicRaw = new Uint8Array(row.publicRaw);
  return { privateKey: row.privateKey, publicKey: row.publicKey, publicRaw, fingerprint: await sha256Hex(publicRaw) };
}

const sign = async (key: SigningKey, data: Uint8Array<ArrayBuffer>) =>
  new Uint8Array(await crypto.subtle.sign('Ed25519', key.privateKey, data));

const verifySignature = async (key: SigningKey, data: Uint8Array<ArrayBuffer>, signatureHex: string) => {
  try {
    const signature = hexToBytes(signatureHex);
    return signature.length === 64 && (await crypto.subtle.verify('Ed25519', key.publicKey, signature, data));
  } catch {
    return false;
  }
};

/** The public key as SubjectPublicKeyInfo PEM, for `openssl pkeyutl -verify`. */
export async function publicKeyPem(): Promise<string> {
  const key = await signingKey();
  const spki = bytesToBase64(new Uint8Array(await crypto.subtle.exportKey('spki', key.publicKey)));
  return `-----BEGIN PUBLIC KEY-----\n${spki.match(/.{1,64}/g)!.join('\n')}\n-----END PUBLIC KEY-----\n`;
}

/** Can this browser run the store? Opens the database and loads or makes the key. */
export async function ready(): Promise<{ fingerprint: string }> {
  await ensureDefaultCase();
  return { fingerprint: (await signingKey()).fingerprint };
}

// ---------------------------------------------------------------------------
// Cases

async function ensureDefaultCase(): Promise<void> {
  if (await getOne<Case>('cases', DEFAULT_CASE.id)) return;
  const tx = await transaction('cases', 'readwrite');
  tx.objectStore('cases').add({ ...DEFAULT_CASE, createdAt: nowIso() });
  await finished(tx).catch(() => {});
}

export async function listCases(): Promise<Case[]> {
  await ensureDefaultCase();
  const cases = await getAll<Case>('cases');
  return cases.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function createCase(name: string): Promise<Case> {
  const trimmed = normalizeTag(name);
  if (!trimmed || trimmed.length > MAX_CASE_NAME) throw new StoreError(`a case name is 1-${MAX_CASE_NAME} characters`);
  const created: Case = { id: crypto.randomUUID(), name: trimmed, createdAt: nowIso() };
  await putOne('cases', created);
  return created;
}

async function requireCase(caseId: string): Promise<void> {
  await ensureDefaultCase();
  if (!(await getOne<Case>('cases', caseId))) throw new StoreError('unknown case');
}

// ---------------------------------------------------------------------------
// Captures: append to the chain, list, read

// Appends are serialized: the sequence number and the previous hash come from the head. Only
// the chain step waits in the queue; the timestamp request runs outside it, so a slow TSA holds
// up no other capture.
let appendQueue: Promise<unknown> = Promise.resolve();

/** Builds, signs, stores and timestamps the next record in the chain. */
export function append(caseId: string, metadata: ClientMetadata, files: IncomingArtifact[]): Promise<UploadResult> {
  const run = appendQueue.then(() => appendNow(caseId, metadata, files));
  appendQueue = run.catch(() => {});
  return run.then(async (row) => {
    const timestamp = await timestampOne(row);
    // Others that failed earlier get another try, a few at a time, in the background.
    void retryPendingTimestamps(5).catch(() => {});
    const { captureId, seq, receivedAt, recordHash, signature } = row;
    return { captureId, seq, receivedAt, recordHash, signature, timestamp };
  });
}

async function appendNow(caseId: string, metadata: ClientMetadata, files: IncomingArtifact[]): Promise<CaptureRow> {
  await requireCase(caseId);
  const key = await signingKey();
  const verified = await verifyUploads(metadata, files);

  const head = await headOf();
  const seq = head.seq + 1;
  const captureId = crypto.randomUUID();
  const receivedAt = nowIso();
  const record: CaptureRecord = {
    schema: SCHEMA,
    seq,
    captureId,
    workspaceId: WORKSPACE_ID,
    caseId,
    receivedAt,
    prevRecordHash: head.recordHash,
    service: { name: SERVICE_NAME, version: browser.runtime.getManifest().version, signingKeySha256: key.fingerprint },
    artifacts: verified.map(({ name, mediaType, size, sha256 }) => ({ name, mediaType, size, sha256 })),
    client: metadata,
    enrichment: { skipped: true },
  };
  const recordJson = canonicalize(record);
  const data = utf8(recordJson);
  const recordHash = await sha256Hex(data);
  const signature = bytesToHex(await sign(key, data));
  const { page } = metadata;

  const row: CaptureRow = {
    captureId,
    seq,
    caseId,
    receivedAt,
    recordJson,
    recordHash,
    signature,
    tsr: null,
    tsaGenTime: null,
    tsaError: null,
    url: page?.documentUrl ?? page?.tabUrl ?? null,
    title: page?.title ?? null,
  };
  const tx = await transaction(['captures', 'artifacts'], 'readwrite');
  tx.objectStore('captures').add(row);
  for (const a of verified) tx.objectStore('artifacts').add({ ...a, captureId } satisfies ArtifactRow);
  await finished(tx);
  return row;
}

async function headOf(): Promise<{ seq: number; recordHash: string }> {
  const tx = await transaction('captures');
  const cursor = await request(tx.objectStore('captures').index('seq').openCursor(null, 'prev'));
  const last = cursor?.value as CaptureRow | undefined;
  return last ? { seq: last.seq, recordHash: last.recordHash } : { seq: 0, recordHash: GENESIS_HASH };
}

/** The files against the hashes the capture declared: every declared artifact present and
 *  hashing as declared, nothing undeclared. The same rule as the server's, and as wary: the
 *  metadata is checked as if it had come over the network, whatever its type says. */
async function verifyUploads(metadata: ClientMetadata, files: IncomingArtifact[]): Promise<ArtifactRow[]> {
  const declared = metadata.artifacts;
  if (!Array.isArray(declared) || !declared.length) throw new StoreError('metadata.artifacts must be a non-empty array');
  const remaining = new Map(files.map((f) => [f.name, f]));
  const seen = new Set<string>();
  const out: ArtifactRow[] = [];
  for (const entry of declared as { name?: unknown; sha256?: unknown; size?: unknown; mediaType?: unknown }[]) {
    const name = entry?.name;
    if (typeof name !== 'string' || !ARTIFACT_NAME.test(name)) throw new StoreError(`invalid artifact name ${JSON.stringify(name)}`);
    if (seen.has(name)) throw new StoreError(`artifact ${name} is declared twice`);
    seen.add(name);
    const file = remaining.get(name);
    if (!file) throw new StoreError(`artifact ${name} declared but not provided`);
    remaining.delete(name);
    const actual = await sha256Hex(file.bytes);
    if (typeof entry.sha256 !== 'string' || actual !== entry.sha256.toLowerCase())
      throw new StoreError(`hash mismatch for ${name}: declared ${String(entry.sha256)}, computed ${actual}`);
    if (entry.size != null && entry.size !== file.bytes.byteLength) throw new StoreError(`size mismatch for ${name}`);
    const mediaType = typeof entry.mediaType === 'string' && entry.mediaType ? entry.mediaType : 'application/octet-stream';
    // captureId is set when the row is stored: the id is made after the files are checked.
    out.push({ captureId: '', name, mediaType, size: file.bytes.byteLength, sha256: actual, blob: new Blob([file.bytes], { type: mediaType }) });
  }
  if (remaining.size) throw new StoreError(`file ${[...remaining.keys()][0]} was not declared`);
  return out;
}

const summary = (r: CaptureRow): CaptureSummary => ({
  seq: r.seq,
  captureId: r.captureId,
  receivedAt: r.receivedAt,
  url: r.url,
  title: r.title,
  recordHash: r.recordHash,
  timestampedAt: r.tsaGenTime,
});

export async function listCaptures(caseId: string): Promise<CaptureSummary[]> {
  await requireCase(caseId);
  const rows = await getAll<CaptureRow>('captures', 'caseId', caseId);
  return rows.sort((a, b) => b.seq - a.seq).map(summary);
}

export async function getCapture(captureId: string): Promise<CaptureDetail> {
  const row = await getOne<CaptureRow>('captures', captureId);
  if (!row) throw new StoreError('unknown capture');
  return {
    record: JSON.parse(row.recordJson) as CaptureRecord,
    recordHash: row.recordHash,
    signature: row.signature,
    timestamp: {
      genTime: row.tsaGenTime,
      error: row.tsaError,
      token: row.tsr ? bytesToBase64(new Uint8Array(row.tsr)) : undefined,
    },
  };
}

/** A captured file's bytes, read by the dashboard page itself. */
export async function readArtifact(captureId: string, name: string): Promise<Blob> {
  const row = await getOne<ArtifactRow>('artifacts', [captureId, name]);
  if (!row) throw new StoreError('unknown artifact');
  return row.blob;
}

// ---------------------------------------------------------------------------
// Trusted timestamps

async function timestampOne(row: CaptureRow): Promise<UploadResult['timestamp']> {
  try {
    const token = await requestTimestamp(row.recordHash, DEFAULT_TSA_URL);
    const kept = await settleTimestamp(row.captureId, { tsr: token.response.buffer, tsaGenTime: token.genTime });
    return { status: 'granted', genTime: kept.tsaGenTime ?? token.genTime, tsa: DEFAULT_TSA_URL };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.warn(`timestamping ${row.captureId} failed:`, error);
    await settleTimestamp(row.captureId, { tsaError: error }).catch(() => {});
    return { status: 'failed', error, tsa: DEFAULT_TSA_URL };
  }
}

/** Writes a timestamp outcome onto the row as it is now, in one transaction. A token already
 *  there stays (the earliest proves the most), and a failure only notes its error while there
 *  is no token: two tries for one record can overlap, the retry loop's and a fresh append's,
 *  and neither may undo the other's token. */
async function settleTimestamp(
  captureId: string,
  outcome: { tsr: ArrayBuffer; tsaGenTime: string } | { tsaError: string },
): Promise<CaptureRow> {
  const tx = await transaction('captures', 'readwrite');
  const store = tx.objectStore('captures');
  const current = (await request(store.get(captureId))) as CaptureRow | undefined;
  if (!current) throw new StoreError('unknown capture');
  if (current.tsr) {
    await finished(tx);
    return current;
  }
  const next: CaptureRow =
    'tsr' in outcome
      ? { ...current, tsr: outcome.tsr, tsaGenTime: outcome.tsaGenTime, tsaError: null }
      : { ...current, tsaError: outcome.tsaError };
  store.put(next);
  await finished(tx);
  return next;
}

let retrying: Promise<number> | null = null;

/** Another try for records without a token, oldest first; how many were granted. One loop at a
 *  time: a call while one runs joins it, so two loops never work the same rows. */
export function retryPendingTimestamps(limit = 20): Promise<number> {
  retrying ??= retryNow(limit).finally(() => {
    retrying = null;
  });
  return retrying;
}

async function retryNow(limit: number): Promise<number> {
  const rows = (await getAll<CaptureRow>('captures')).filter((r) => !r.tsr).sort((a, b) => a.seq - b.seq);
  let granted = 0;
  for (const row of rows.slice(0, limit)) {
    const current = await getOne<CaptureRow>('captures', row.captureId);
    if (!current || current.tsr) continue;
    if ((await timestampOne(current)).status === 'granted') granted++;
  }
  return granted;
}

// ---------------------------------------------------------------------------
// Verify: the whole chain, as GET /evidence/verify does

export async function verifyAll(): Promise<VerifyReport> {
  const key = await signingKey();
  const rows = (await getAll<CaptureRow>('captures')).sort((a, b) => a.seq - b.seq);
  const issues: VerifyReport['issues'] = [];
  let prevHash = GENESIS_HASH;
  let timestamped = 0;

  for (const [i, row] of rows.entries()) {
    const report = (severity: 'error' | 'warning', message: string) =>
      issues.push({ severity, seq: row.seq, captureId: row.captureId, message });
    const data = utf8(row.recordJson);
    if (row.seq !== i + 1) report('error', `sequence gap: expected seq ${i + 1}`);
    if ((await sha256Hex(data)) !== row.recordHash) report('error', 'record bytes do not match stored record hash');
    if (!(await verifySignature(key, data, row.signature))) report('error', 'signature does not verify');

    let record: CaptureRecord | null = null;
    try {
      record = JSON.parse(row.recordJson) as CaptureRecord;
    } catch (e) {
      report('error', `record is not valid JSON: ${e instanceof Error ? e.message : e}`);
    }
    if (record) {
      if (!isCanonical(row.recordJson)) report('error', 'record is not in RFC 8785 canonical form');
      if (record.prevRecordHash !== prevHash) report('error', 'chain broken: prevRecordHash does not match previous record');
      if (record.seq !== row.seq) report('error', 'seq inside record does not match log position');
      if (record.captureId !== row.captureId) report('error', 'captureId inside record does not match index');
      if (record.caseId !== row.caseId) report('error', 'caseId inside record does not match index');
      if ((record.workspaceId ?? WORKSPACE_ID) !== WORKSPACE_ID) report('error', 'workspaceId inside record does not match this store');
      if (record.service?.signingKeySha256 !== key.fingerprint) report('warning', 'record was signed by a different key');

      const stored = new Map((await getAll<ArtifactRow>('artifacts', 'captureId', row.captureId)).map((a) => [a.name, a]));
      for (const artifact of record.artifacts ?? []) {
        const file = stored.get(artifact.name);
        if (!file) report('error', `artifact ${artifact.name} unreadable`);
        else if ((await sha256Hex(new Uint8Array(await file.blob.arrayBuffer()))) !== artifact.sha256)
          report('error', `artifact ${artifact.name} has been modified`);
      }
    }

    if (!row.tsr) report('warning', `no trusted timestamp${row.tsaError ? ` (last error: ${row.tsaError})` : ''}`);
    else {
      try {
        await verifyToken(new Uint8Array(row.tsr), hexToBytes(row.recordHash));
        timestamped++;
      } catch (e) {
        report('error', `timestamp token invalid: ${e instanceof TsaError ? e.message : String(e)}`);
      }
    }
    // Continue from what the record claims, so one broken record gives one error, not a cascade.
    prevHash = row.recordHash;
  }

  return {
    ok: !issues.some((i) => i.severity === 'error'),
    records: rows.length,
    timestamped,
    headHash: rows.at(-1)?.recordHash ?? null,
    signingKeySha256: key.fingerprint,
    publicKeyPem: await publicKeyPem(),
    issues,
  };
}

// ---------------------------------------------------------------------------
// Tags and analyst notes, beside the records, never inside them

const toAnnotation = (r: AnnotationRow): Annotation => ({ captureId: r.captureId, tags: [...r.tags], notes: r.notes.map((n) => ({ ...n })), updatedAt: r.updatedAt });

export async function listAnnotations(caseId: string): Promise<Annotation[]> {
  await requireCase(caseId);
  const order = new Map((await getAll<CaptureRow>('captures', 'caseId', caseId)).map((c) => [c.captureId, c.seq]));
  const rows = await getAll<AnnotationRow>('annotations', 'caseId', caseId);
  return rows.sort((a, b) => (order.get(a.captureId) ?? 0) - (order.get(b.captureId) ?? 0)).map(toAnnotation);
}

/** Replaces the capture's tags, its notes, or both; a list left out stays. A note keeps its id
 *  and createdAt when it names a known one and gets updatedAt when its text changed. */
export async function saveAnnotations(captureId: string, change: AnnotationChange): Promise<Annotation> {
  const capture = await getOne<CaptureRow>('captures', captureId);
  if (!capture) throw new StoreError('unknown capture');
  const current = (await getOne<AnnotationRow>('annotations', captureId)) ?? { captureId, caseId: capture.caseId, tags: [], notes: [], updatedAt: '' };
  const now = nowIso();

  let tags = current.tags;
  if (change.tags !== undefined) {
    if (!Array.isArray(change.tags)) throw new StoreError('tags must be an array');
    tags = [];
    for (const raw of change.tags) {
      if (typeof raw !== 'string') throw new StoreError('a tag must be a string');
      const tag = normalizeTag(raw);
      if (!tag || tag.length > MAX_TAG) throw new StoreError(`a tag is 1-${MAX_TAG} characters`);
      if (!tags.some((t) => t.toLowerCase() === tag.toLowerCase())) tags.push(tag);
    }
    if (tags.length > MAX_TAGS) throw new StoreError(`at most ${MAX_TAGS} tags per capture`);
  }

  let notes = current.notes;
  if (change.notes !== undefined) {
    if (!Array.isArray(change.notes)) throw new StoreError('notes must be an array');
    if (change.notes.length > MAX_NOTES) throw new StoreError(`at most ${MAX_NOTES} notes per capture`);
    const known = new Map(current.notes.map((n) => [n.id, n]));
    notes = change.notes.map((note) => {
      if (typeof note?.text !== 'string' || !note.text.trim() || note.text.length > MAX_NOTE)
        throw new StoreError(`a note is 1-${MAX_NOTE} characters`);
      const before = note.id ? known.get(note.id) : undefined;
      if (!before) return { id: crypto.randomUUID(), text: note.text, createdAt: now, updatedAt: null };
      return before.text === note.text ? { ...before } : { ...before, text: note.text, updatedAt: now };
    });
  }

  const row: AnnotationRow = { captureId, caseId: capture.caseId, tags, notes, updatedAt: now };
  await putOne('annotations', row);
  return toAnnotation(row);
}

// ---------------------------------------------------------------------------
// Todos, one list per case

const toTodos = (caseId: string, row: TodoRow | undefined): CaseTodos => ({
  caseId,
  todos: (row?.items ?? []).map((t) => ({ ...t })),
  updatedAt: row?.updatedAt ?? null,
});

export async function listTodos(caseId: string): Promise<CaseTodos> {
  await requireCase(caseId);
  return toTodos(caseId, await getOne<TodoRow>('todos', caseId));
}

/** Replaces the list, in the order given. A todo keeps its id and createdAt when it names a
 *  known one (once); updatedAt is set when its text changed, doneAt when it was checked. */
export async function saveTodos(caseId: string, todos: TodoChange[]): Promise<CaseTodos> {
  await requireCase(caseId);
  if (!Array.isArray(todos)) throw new StoreError('todos must be an array');
  if (todos.length > MAX_TODOS) throw new StoreError(`at most ${MAX_TODOS} todos per case`);
  const current = await getOne<TodoRow>('todos', caseId);
  const known = new Map((current?.items ?? []).map((t) => [t.id, t]));
  const now = nowIso();
  const items: Todo[] = todos.map((todo) => {
    if (typeof todo?.text !== 'string' || !todo.text.trim() || todo.text.length > MAX_TODO)
      throw new StoreError(`a todo is 1-${MAX_TODO} characters`);
    const done = !!todo.done;
    const before = todo.id ? known.get(todo.id) : undefined;
    if (before) known.delete(before.id);
    if (!before) return { id: crypto.randomUUID(), text: todo.text, done, createdAt: now, updatedAt: null, doneAt: done ? now : null };
    const item: Todo = { ...before };
    if (item.text !== todo.text) Object.assign(item, { text: todo.text, updatedAt: now });
    if (item.done !== done) Object.assign(item, { done, doneAt: done ? now : null });
    return item;
  });
  const row: TodoRow = { caseId, items, updatedAt: now };
  await putOne('todos', row);
  return toTodos(caseId, row);
}

// ---------------------------------------------------------------------------
// Export

/** The files of a capture's bundle, as the server lays them out, for independent verification. */
export async function recordBundle(captureId: string): Promise<{ name: string; blob: Blob }[]> {
  const row = await getOne<CaptureRow>('captures', captureId);
  if (!row) throw new StoreError('unknown capture');
  const files = [
    { name: 'record.json', blob: new Blob([utf8(row.recordJson)], { type: 'application/json' }) },
    { name: 'record.sig', blob: new Blob([hexToBytes(row.signature)], { type: 'application/octet-stream' }) },
  ];
  if (row.tsr) files.push({ name: 'record.tsr', blob: new Blob([row.tsr], { type: 'application/timestamp-reply' }) });
  return files;
}

export { base64ToBytes };

export const browserStore: EvidenceStore = {
  listCases,
  createCase,
  listCaptures,
  getCapture,
  append,
  readArtifact,
  listAnnotations,
  saveAnnotations,
  listTodos,
  saveTodos,
  verify: verifyAll,
};
