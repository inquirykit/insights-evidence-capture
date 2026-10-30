// Records made elsewhere, checked here: fixtures/server-record/ was built and signed by
// ai_toolkit's own code, with a timestamp token from an OpenSSL TSA; fixtures/browser-record/ was
// made by the browser store, and make-server-fixtures.py checked it with the server's code.
// Regenerate both with `bun run fixtures`. fixtures/freetsa/ is a real FreeTSA token.

import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import { base64ToBytes, hexToBytes, sha256Hex } from '../lib/bytes';
import { canonicalize, isCanonical } from '../lib/canonical';
import * as limits from '../lib/limits';
import { SCHEMA } from '../lib/local-store';
import type { CaptureRecord } from '../lib/protocol';
import { inspect, TsaError, verifyToken } from '../lib/tsa';

const fixtures = join(import.meta.dir, 'fixtures');
const bytesOf = async (path: string) => new Uint8Array(await Bun.file(join(fixtures, path)).arrayBuffer());

const pemBytes = (pem: string) => base64ToBytes(pem.replace(/-----[^-]+-----|\s/g, ''));

async function publicKey(pem: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('spki', pemBytes(pem), 'Ed25519', true, ['verify']);
}

describe('a record the server made', async () => {
  const data = await bytesOf('server-record/record.json');
  const text = new TextDecoder().decode(data);
  const signature = await bytesOf('server-record/record.sig');
  const key = await publicKey(await Bun.file(join(fixtures, 'server-record/ed25519.pub.pem')).text());
  const expected = (await Bun.file(join(fixtures, 'server-record/expected.json')).json()) as {
    schema: string;
    recordHash: string;
    signingKeySha256: string;
    genTime: string;
  };

  test('is canonical by the browser canonicalizer too', () => {
    expect(isCanonical(text)).toBe(true);
  });

  test('re-serializing the parsed record gives the signed bytes back, as the dashboard export does', () => {
    expect(canonicalize(JSON.parse(text))).toBe(text);
  });

  test('hashes to the record hash', async () => {
    expect(await sha256Hex(data)).toBe(expected.recordHash);
  });

  test('its signature verifies with WebCrypto, and not over other bytes', async () => {
    expect(await crypto.subtle.verify('Ed25519', key, signature, data)).toBe(true);
    const changed = data.slice();
    changed[changed.length - 2] = changed[changed.length - 2]! ^ 1;
    expect(await crypto.subtle.verify('Ed25519', key, signature, changed)).toBe(false);
  });

  test('names its key the way the browser store names its own', async () => {
    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', key));
    const record = JSON.parse(text) as CaptureRecord;
    expect(await sha256Hex(raw)).toBe(expected.signingKeySha256);
    expect(record.service.signingKeySha256).toBe(expected.signingKeySha256);
  });

  test('its timestamp token reads as the server read it, and covers this record only', async () => {
    const tsr = await bytesOf('server-record/record.tsr');
    const info = inspect(tsr, hexToBytes(expected.recordHash));
    expect(info.genTime).toBe(expected.genTime);
    expect(info.nonce).not.toBeNull();
    expect(() => inspect(tsr, new Uint8Array(32))).toThrow(TsaError);
  });

  test('its timestamp token verifies under the TSA CA it was made with, and not under FreeTSA', async () => {
    const tsr = await bytesOf('server-record/record.tsr');
    const ca = pemBytes(await Bun.file(join(fixtures, 'server-record/tsa-ca.pem')).text());
    // An RSA TSA certificate under an Ed25519 CA, as `openssl ts -verify` accepted it
    expect((await verifyToken(tsr, hexToBytes(expected.recordHash), [ca])).genTime).toBe(expected.genTime);
    await expect(verifyToken(tsr, hexToBytes(expected.recordHash))).rejects.toThrow('does not chain to a trusted root');
  });

  test('has the shape the dashboard reads', () => {
    const record = JSON.parse(text) as CaptureRecord;
    expect(record.schema).toBe(SCHEMA);
    expect(expected.schema).toBe(SCHEMA);
    expect(record.seq).toBe(1);
    expect(record.prevRecordHash).toBe('0'.repeat(64));
    expect('items' in record.enrichment && record.enrichment.items.length).toBe(1);
    expect(record.client.page?.scrollPosition).toEqual({ x: 0, y: 0 });
    expect(record.artifacts.map((a) => a.name)).toEqual(['dom.html']);
  });
});

describe('a record the browser store made', async () => {
  const data = await bytesOf('browser-record/record.json');
  const record = JSON.parse(new TextDecoder().decode(data)) as CaptureRecord;

  test('verifies here as it did with the server code', async () => {
    const key = await publicKey(await Bun.file(join(fixtures, 'browser-record/ed25519.pub.pem')).text());
    expect(await crypto.subtle.verify('Ed25519', key, await bytesOf('browser-record/record.sig'), data)).toBe(true);
    expect(record.workspaceId).toBe('browser');
    expect(record.enrichment).toEqual({ skipped: true });
  });

  test('lists the file it was made with', async () => {
    const dom = await bytesOf('browser-record/artifacts/dom.html');
    expect(record.artifacts).toEqual([
      { name: 'dom.html', mediaType: 'text/html;charset=utf-8', size: dom.byteLength, sha256: await sha256Hex(dom) },
    ]);
  });
});

// fixtures/freetsa/data.tsr is FreeTSA's reply to a request over data.txt, as the extension sends
// one (made once, by hand: `openssl ts -query -data data.txt -sha256 -cert`, posted to
// https://freetsa.org/tsr). Its TSA certificate is ECDSA P-384 under FreeTSA's RSA root.
describe('a token FreeTSA made', async () => {
  const tsr = await bytesOf('freetsa/data.tsr');
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', await bytesOf('freetsa/data.txt')));

  test('verifies under the root the extension trusts', async () => {
    expect((await verifyToken(tsr, digest)).genTime).toBe('2026-10-29T20:59:43Z');
  });

  test('covers its data only, and a changed byte breaks it', async () => {
    await expect(verifyToken(tsr, new Uint8Array(32))).rejects.toThrow('does not match the record hash');
    const changed = tsr.slice();
    changed[changed.length - 5]! ^= 0x01;
    await expect(verifyToken(changed, digest)).rejects.toThrow('the TSA signature does not verify');
  });
});

test("the server's limits are lib/limits.ts's", async () => {
  const server = (await Bun.file(join(fixtures, 'server-limits.json')).json()) as Record<string, number>;
  const { MAX_ARTIFACT_NAME, ...rest } = server;
  expect(rest).toEqual({
    MAX_CASE_NAME: limits.MAX_CASE_NAME,
    MAX_TAG: limits.MAX_TAG,
    MAX_TAGS: limits.MAX_TAGS,
    MAX_NOTE: limits.MAX_NOTE,
    MAX_NOTES: limits.MAX_NOTES,
    MAX_TODO: limits.MAX_TODO,
    MAX_TODOS: limits.MAX_TODOS,
  });
  expect(limits.ARTIFACT_NAME.test('a'.repeat(MAX_ARTIFACT_NAME!))).toBe(true);
  expect(limits.ARTIFACT_NAME.test('a'.repeat(MAX_ARTIFACT_NAME! + 1))).toBe(false);
});
