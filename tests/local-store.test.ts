// The browser store (lib/local-store.ts) on fake-indexeddb, with tests/fake-tsa.ts for FreeTSA:
// the chain, the upload checks, verify, timestamps, and the rules it shares with the server.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { hexToBytes, sha256Hex, utf8 } from '../lib/bytes';
import { isCanonical } from '../lib/canonical';
import { MAX_TAG, MAX_TAGS, MAX_TODO, MAX_TODOS } from '../lib/limits';
import * as local from '../lib/local-store';
import type { ClientMetadata } from '../lib/protocol';
import type { IncomingArtifact } from '../lib/store';
import { buildRequest } from '../lib/tsa';
import { fakeTsa, stranger, timestampReply, type TsaAnswer } from './fake-tsa';

const DB_NAME = 'insights-evidence-capture';

let answer: (call: number) => TsaAnswer | Promise<TsaAnswer> = () => ({});
let restoreFetch = () => {};

beforeEach(async () => {
  answer = () => ({});
  restoreFetch = fakeTsa((call) => answer(call));
  await deleteDb();
});

afterEach(async () => {
  await local.retryPendingTimestamps(); // the background retry an append starts
  restoreFetch();
});

function deleteDb(): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('database blocked'));
  });
}

/** Changes a stored row behind the store's back, as an attacker with the profile could. */
async function tamper(store: 'captures' | 'artifacts', key: IDBValidKey, change: (row: any) => void) {
  const db = await openRaw();
  const tx = db.transaction(store, 'readwrite');
  const objects = tx.objectStore(store);
  const row = await new Promise<any>((resolve) => {
    const req = objects.get(key);
    req.onsuccess = () => resolve(req.result);
  });
  change(row);
  objects.put(row);
  await new Promise<void>((resolve) => (tx.oncomplete = () => resolve()));
  db.close();
}

async function capture(caseId = 'inbox', files: Record<string, string> = { 'dom.html': '<p>Lorem ipsum</p>' }) {
  const artifacts: NonNullable<ClientMetadata['artifacts']> = [];
  const incoming: IncomingArtifact[] = [];
  for (const [name, text] of Object.entries(files)) {
    const bytes = utf8(text);
    artifacts.push({ name, sha256: await sha256Hex(bytes), size: bytes.byteLength, method: 'test', mediaType: 'text/html' });
    incoming.push({ name, mediaType: 'text/html', bytes });
  }
  const metadata: ClientMetadata = {
    schema: 'evidence-capture/client/v1',
    caseId,
    page: { documentUrl: 'https://example.com/page', title: 'Lorem ipsum' },
    artifacts,
  };
  return { metadata, incoming };
}

const appendOne = async (caseId = 'inbox') => {
  const { metadata, incoming } = await capture(caseId);
  return local.append(caseId, metadata, incoming);
};

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};

const until = async (condition: () => boolean) => {
  for (let i = 0; i < 200 && !condition(); i++) await new Promise((r) => setTimeout(r, 5));
  if (!condition()) throw new Error('timed out');
};

describe('appending', () => {
  test('a signed v3 record, chained from the genesis hash, with its timestamp', async () => {
    const { metadata, incoming } = await capture();
    const upload = await local.append('inbox', metadata, incoming);
    expect(upload.seq).toBe(1);
    expect(upload.timestamp.status).toBe('granted');

    const { record, recordHash, timestamp } = await local.getCapture(upload.captureId);
    expect(record.schema).toBe(local.SCHEMA);
    expect(record.prevRecordHash).toBe('0'.repeat(64));
    expect(record.workspaceId).toBe('browser');
    expect(record.enrichment).toEqual({ skipped: true });
    expect(record.client).toEqual(metadata);
    expect(record.service.signingKeySha256).toBe((await local.ready()).fingerprint);
    expect(recordHash).toBe(upload.recordHash);
    expect(timestamp.token).toBeString();

    const [summary] = await local.listCaptures('inbox');
    expect(summary).toMatchObject({ captureId: upload.captureId, url: 'https://example.com/page', title: 'Lorem ipsum' });
  });

  test('each record chains to the one before, across cases, and the chain verifies', async () => {
    const other = await local.createCase('  Second   case ');
    expect(other.name).toBe('Second case');
    const a = await appendOne();
    const b = await appendOne(other.id);
    const c = await appendOne();
    expect([a.seq, b.seq, c.seq]).toEqual([1, 2, 3]);
    expect((await local.getCapture(b.captureId)).record.prevRecordHash).toBe(a.recordHash);
    expect((await local.getCapture(c.captureId)).record.prevRecordHash).toBe(b.recordHash);
    expect((await local.listCaptures('inbox')).map((s) => s.seq)).toEqual([3, 1]);

    const report = await local.verifyAll();
    expect(report).toMatchObject({ ok: true, records: 3, timestamped: 3, headHash: c.recordHash, issues: [] });
    expect(report.publicKeyPem).toStartWith('-----BEGIN PUBLIC KEY-----');
  });

  test('files that do not match the metadata are refused, and nothing is chained', async () => {
    const cases: [string, (m: ClientMetadata, f: IncomingArtifact[]) => void, string][] = [
      ['hash', (m) => (m.artifacts![0]!.sha256 = '0'.repeat(64)), 'hash mismatch for dom.html'],
      ['size', (m) => (m.artifacts![0]!.size = 1), 'size mismatch for dom.html'],
      ['undeclared', (_m, f) => f.push({ name: 'extra.txt', mediaType: 'text/plain', bytes: utf8('x') }), 'file extra.txt was not declared'],
      ['missing', (_m, f) => f.pop(), 'artifact dom.html declared but not provided'],
      ['twice', (m) => m.artifacts!.push({ ...m.artifacts![0]! }), 'artifact dom.html is declared twice'],
      ['name', (m, f) => ((m.artifacts![0]!.name = '../x'), (f[0]!.name = '../x')), 'invalid artifact name'],
      ['none', (m) => (m.artifacts = []), 'metadata.artifacts must be a non-empty array'],
    ];
    for (const [, spoil, message] of cases) {
      const { metadata, incoming } = await capture();
      spoil(metadata, incoming);
      await expect(local.append('inbox', metadata, incoming)).rejects.toThrow(message);
    }
    expect(await local.listCaptures('inbox')).toEqual([]);
    const { metadata, incoming } = await capture();
    expect((await local.append('inbox', metadata, incoming)).seq).toBe(1);
  });

  test('into a case that does not exist is refused', async () => {
    const { metadata, incoming } = await capture('nope');
    await expect(local.append('nope', metadata, incoming)).rejects.toThrow('unknown case');
  });

  test('recordBundle gives the exact signed bytes and the raw signature', async () => {
    const { metadata, incoming } = await capture();
    const upload = await local.append('inbox', metadata, incoming);
    const files = Object.fromEntries((await local.recordBundle(upload.captureId)).map((f) => [f.name, f.blob]));
    const json = await files['record.json']!.text();
    expect(isCanonical(json)).toBe(true);
    expect(await sha256Hex(utf8(json))).toBe(upload.recordHash);
    expect(files['record.sig']!.size).toBe(64);
    expect(files['record.tsr']!.size).toBeGreaterThan(0);
  });
});

describe('verify', () => {
  test('finds a changed artifact', async () => {
    const { metadata, incoming } = await capture();
    const upload = await local.append('inbox', metadata, incoming);
    await tamper('artifacts', [upload.captureId, 'dom.html'], (row) => (row.blob = new Blob(['<p>changed</p>'])));
    const report = await local.verifyAll();
    expect(report.ok).toBe(false);
    expect(report.issues.map((i) => i.message)).toEqual(['artifact dom.html has been modified']);
  });

  test('finds a changed record, and one broken record gives one error, not a cascade', async () => {
    const first = await appendOne();
    await appendOne();
    await tamper('captures', first.captureId, (row) => (row.recordJson = row.recordJson.replace('Lorem ipsum', 'Lorem ipsuM')));
    const messages = (await local.verifyAll()).issues.filter((i) => i.severity === 'error').map((i) => `${i.seq}: ${i.message}`);
    // The token covers the hash stored beside the record, and the next record chains to it: only
    // the changed bytes are reported.
    expect(messages).toEqual(['1: record bytes do not match stored record hash', '1: signature does not verify']);
  });
});

describe('verify, against splicing', () => {
  test('finds a validly signed record from another chain put in place of the real one', async () => {
    // Chain A: two records. Keep its second one, signed and timestamped, with its file.
    await appendOne();
    const second = await appendOne();
    const rows = await rawRows(second.captureId);
    // Chain B, with the same key: a different first record, then A's second spliced in after it.
    await deleteDb();
    const { metadata, incoming } = await capture('inbox', { 'dom.html': '<p>another first page</p>' });
    await local.append('inbox', metadata, incoming);
    await putRows(rows);

    const errors = (await local.verifyAll()).issues.filter((i) => i.severity === 'error');
    // Its bytes, signature, sequence and token are all in order: only the chain gives it away.
    expect(errors.map((i) => `${i.seq}: ${i.message}`)).toEqual(['2: chain broken: prevRecordHash does not match previous record']);
  });
});

async function openRaw(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function rawRows(captureId: string): Promise<{ capture: unknown; artifacts: unknown[] }> {
  const db = await openRaw();
  const tx = db.transaction(['captures', 'artifacts']);
  const get = <T>(r: IDBRequest<T>) => new Promise<T>((resolve) => (r.onsuccess = () => resolve(r.result)));
  const capture = await get(tx.objectStore('captures').get(captureId));
  const artifacts = await get(tx.objectStore('artifacts').index('captureId').getAll(captureId));
  db.close();
  return { capture, artifacts };
}

async function putRows(rows: { capture: unknown; artifacts: unknown[] }) {
  const db = await openRaw();
  const tx = db.transaction(['captures', 'artifacts'], 'readwrite');
  tx.objectStore('captures').put(rows.capture);
  for (const a of rows.artifacts) tx.objectStore('artifacts').put(a);
  await new Promise<void>((resolve) => (tx.oncomplete = () => resolve()));
  db.close();
}

describe('timestamps', () => {
  test('a failed one is retried later, and the record verifies once it has one', async () => {
    answer = () => ({ fail: 'TSA down' });
    const { metadata, incoming } = await capture();
    const upload = await local.append('inbox', metadata, incoming);
    expect(upload.timestamp).toMatchObject({ status: 'failed' });
    expect(upload.timestamp.error).toContain('TSA down');
    await local.retryPendingTimestamps();
    const report = await local.verifyAll();
    expect(report.ok).toBe(true); // a missing token is a warning
    expect(report.issues[0]?.message).toStartWith('no trusted timestamp (last error: contacting TSA');

    answer = () => ({ genTime: '2026-10-25T09:00:00Z' });
    expect(await local.retryPendingTimestamps()).toBe(1);
    expect((await local.getCapture(upload.captureId)).timestamp).toMatchObject({ genTime: '2026-10-25T09:00:00Z', error: null });
    expect((await local.verifyAll()).timestamped).toBe(1);
  });

  test('two tries at once: the first token stays, and neither a later token nor a failure undoes it', async () => {
    const replies = [deferred<TsaAnswer>(), deferred<TsaAnswer>(), deferred<TsaAnswer>()];
    let calls = 0;
    answer = (call) => {
      calls = call;
      return replies[call - 1]?.promise ?? { fail: 'no more' };
    };
    const { metadata, incoming } = await capture();
    const appending = local.append('inbox', metadata, incoming);
    await until(() => calls === 1); // the append's own try
    const retrying = local.retryPendingTimestamps();
    await until(() => calls === 2); // the retry loop's, for the same record

    replies[0]!.resolve({ genTime: '2026-10-25T10:00:00Z' });
    const upload = await appending;
    expect(upload.timestamp).toMatchObject({ status: 'granted', genTime: '2026-10-25T10:00:00Z' });
    replies[1]!.resolve({ fail: 'late failure' });
    await retrying;
    expect((await local.getCapture(upload.captureId)).timestamp).toMatchObject({ genTime: '2026-10-25T10:00:00Z', error: null });
  });

  test('verify refuses a token put in its place that FreeTSA did not sign, though it covers the record', async () => {
    const upload = await appendOne();
    // What someone with the profile could store: a token over the right hash, with any time they like
    const forged = await timestampReply(buildRequest(hexToBytes(upload.recordHash)).request, '2020-01-01T00:00:00Z', stranger);
    await tamper('captures', upload.captureId, (row) => (row.tsr = forged.buffer));
    const report = await local.verifyAll();
    expect(report).toMatchObject({ ok: false, timestamped: 0 });
    expect(report.issues.map((i) => i.message)).toEqual([
      "timestamp token invalid: the TSA's certificate does not chain to a trusted root",
    ]);
  });
});

describe('tags, notes and todos: beside the records, by the server rules', () => {
  test('tags are trimmed, collapsed and kept once whatever their case', async () => {
    const upload = await appendOne();
    const saved = await local.saveAnnotations(upload.captureId, { tags: ['  lorem   ipsum ', 'LOREM IPSUM', 'dolor'] });
    expect(saved.tags).toEqual(['lorem ipsum', 'dolor']);
    await expect(local.saveAnnotations(upload.captureId, { tags: ['x'.repeat(MAX_TAG + 1)] })).rejects.toThrow('a tag is 1-64 characters');
    await expect(local.saveAnnotations(upload.captureId, { tags: Array.from({ length: MAX_TAGS + 1 }, (_, i) => `t${i}`) })).rejects.toThrow('at most 64 tags');
    expect((await local.listAnnotations('inbox')).map((a) => a.tags)).toEqual([['lorem ipsum', 'dolor']]);
    expect((await local.getCapture(upload.captureId)).recordHash).toBe(upload.recordHash); // the record is untouched
  });

  test('notes keep their id and creation time; an edit is dated, one left out is gone', async () => {
    const upload = await appendOne();
    const [a, b] = (await local.saveAnnotations(upload.captureId, { notes: [{ text: 'one' }, { text: 'two' }] })).notes;
    const after = await local.saveAnnotations(upload.captureId, { notes: [{ id: a!.id, text: 'one, edited' }] });
    expect(after.notes).toEqual([{ ...a!, text: 'one, edited', updatedAt: expect.any(String) }]);
    expect(after.notes.some((n) => n.id === b!.id)).toBe(false);
    expect(after.tags).toEqual([]); // a list left out of the change stays as it was
  });

  test('todos keep their ids, and record when they were edited and done', async () => {
    const first = await local.saveTodos('inbox', [{ text: 'check the archive', done: false }, { text: 'ask', done: true }]);
    const [check, ask] = first.todos;
    expect(check).toMatchObject({ done: false, doneAt: null, updatedAt: null });
    expect(ask!.doneAt).toBeString();
    const next = await local.saveTodos('inbox', [{ id: check!.id, text: 'check the archive again', done: true }]);
    expect(next.todos).toEqual([{ ...check!, text: 'check the archive again', done: true, updatedAt: expect.any(String), doneAt: expect.any(String) }]);
    await expect(local.saveTodos('inbox', [{ text: 'x'.repeat(MAX_TODO + 1), done: false }])).rejects.toThrow('a todo is 1-2000 characters');
    await expect(local.saveTodos('inbox', Array.from({ length: MAX_TODOS + 1 }, () => ({ text: 'x', done: false })))).rejects.toThrow('at most 500 todos');
    await expect(local.listTodos('nope')).rejects.toThrow('unknown case');
  });

  test('cases: the inbox is always there, names are checked', async () => {
    expect((await local.listCases()).map((c) => c.id)).toEqual(['inbox']);
    await expect(local.createCase('   ')).rejects.toThrow('a case name is 1-200 characters');
    await expect(local.createCase('x'.repeat(201))).rejects.toThrow('a case name is 1-200 characters');
  });
});
