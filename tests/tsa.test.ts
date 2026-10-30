// lib/tsa.ts's request, its reading of replies and its verifying of who signed them;
// tests/fake-tsa.ts, which the store tests rely on, answers it as a TSA would. Real tokens are in
// golden.test.ts.

import { describe, expect, test } from 'bun:test';

import { bytesToHex, sha256Hex, utf8 } from '../lib/bytes';
import { buildRequest, inspect, requestTimestamp, trustedRoots, TsaError, verifyToken } from '../lib/tsa';
import { fake, fakeTsa, requestedDigest, stranger, timestampReply } from './fake-tsa';

const digest = async (text: string) => new Uint8Array(await crypto.subtle.digest('SHA-256', utf8(text)));

/** Where `part` first occurs in `bytes` */
const indexOf = (bytes: Uint8Array, part: Uint8Array) =>
  bytes.findIndex((_, i) => part.every((b, j) => bytes[i + j] === b));

describe('TimeStampReq', () => {
  test('asks for the digest given, with a fresh nonce each time', async () => {
    const d = await digest('lorem');
    const a = buildRequest(d);
    const b = buildRequest(d);
    expect(bytesToHex(requestedDigest(a.request))).toBe(bytesToHex(d));
    expect(bytesToHex(a.nonce)).not.toBe(bytesToHex(b.nonce));
  });

  test('takes SHA-256 digests only', () => {
    expect(() => buildRequest(new Uint8Array(20))).toThrow(TsaError);
  });
});

describe('reading a reply', () => {
  test('gives the time and the nonce, for the digest asked about', async () => {
    const d = await digest('lorem');
    const { request, nonce } = buildRequest(d);
    const info = inspect(await timestampReply(request, '2026-10-25T12:34:56.789Z'), d);
    expect(info.genTime).toBe('2026-10-25T12:34:56Z');
    expect(bytesToHex(info.nonce!)).toBe(bytesToHex(nonce).replace(/^(00)+/, ''));
    const reply = await timestampReply(request);
    expect(() => inspect(reply, new Uint8Array(32))).toThrow('does not match the record hash');
  });

  test('a refusal says so', () => {
    // PKIStatusInfo { rejection, "busy" }, no token
    const refused = Uint8Array.from([0x30, 0x0b, 0x30, 0x09, 0x02, 0x01, 0x02, 0x30, 0x04, 0x0c, 0x02, 0x6e, 0x6f]);
    expect(() => inspect(refused, new Uint8Array(32))).toThrow('TSA refused the request: rejection no');
  });

  test('a length past what 31 bits hold is refused as invalid, not misread', () => {
    // SEQUENCE with a four-byte length of 0x80000000
    const huge = Uint8Array.from([0x30, 0x84, 0x80, 0x00, 0x00, 0x00, 0x00]);
    expect(() => inspect(huge, new Uint8Array(32))).toThrow('DER value runs past its container');
  });

  test('requestTimestamp: a token for the record hash, through fetch', async () => {
    const restore = fakeTsa(() => ({ genTime: '2026-10-25T08:00:00Z' }));
    try {
      const hash = await sha256Hex(utf8('record'));
      const token = await requestTimestamp(hash, 'https://tsa.invalid/tsr');
      expect(token.genTime).toBe('2026-10-25T08:00:00Z');
      expect(inspect(token.response, await digest('record')).genTime).toBe(token.genTime);
    } finally {
      restore();
    }
  });

  test('requestTimestamp: an unreachable TSA is a TsaError', async () => {
    const restore = fakeTsa(() => ({ fail: 'offline' }));
    try {
      await expect(requestTimestamp('00'.repeat(32), 'https://tsa.invalid/tsr')).rejects.toThrow(TsaError);
    } finally {
      restore();
    }
  });
});

describe('verifying who signed it', () => {
  test('a token verifies against its TSA root, and against no other', async () => {
    const d = await digest('lorem');
    const { request } = buildRequest(d);
    const reply = await timestampReply(request, '2026-10-25T12:34:56Z');
    expect((await verifyToken(reply, d, [fake.root])).genTime).toBe('2026-10-25T12:34:56Z');
    await expect(verifyToken(reply, d)).rejects.toThrow("the TSA's certificate does not chain to a trusted root"); // FreeTSA's only
    await expect(verifyToken(reply, d, [stranger.root])).rejects.toThrow('does not chain to a trusted root');
    await expect(verifyToken(reply, new Uint8Array(32), [fake.root])).rejects.toThrow('does not match the record hash');
  });

  test('a token another TSA signed, over the right hash, is refused', async () => {
    const d = await digest('lorem');
    const forged = await timestampReply(buildRequest(d).request, '2020-01-01T00:00:00Z', stranger);
    expect(inspect(forged, d).genTime).toBe('2020-01-01T00:00:00Z'); // reads fine
    await expect(verifyToken(forged, d, [fake.root])).rejects.toThrow('does not chain to a trusted root');
  });

  test('a changed time or signature is caught', async () => {
    const d = await digest('lorem');
    const reply = await timestampReply(buildRequest(d).request, '2026-10-25T12:00:00Z');

    const later = reply.slice();
    later[indexOf(later, utf8('20261025120000Z')) + 9] = utf8('3')[0]!; // 12:00 → 13:00
    expect(inspect(later, d).genTime).toBe('2026-10-25T13:00:00Z');
    await expect(verifyToken(later, d, [fake.root])).rejects.toThrow('the TSA signature is not over this TSTInfo');

    const resigned = reply.slice();
    resigned[resigned.length - 1]! ^= 0x01; // the signature is the token's last field
    await expect(verifyToken(resigned, d, [fake.root])).rejects.toThrow('the TSA signature does not verify');
  });

  test('requestTimestamp refuses a token no trusted TSA signed', async () => {
    const restore = fakeTsa(() => ({ by: stranger }));
    try {
      await expect(requestTimestamp(await sha256Hex(utf8('record')), 'https://tsa.invalid/tsr')).rejects.toThrow(
        'does not chain to a trusted root',
      );
    } finally {
      restore();
    }
  });

  test("the root trusted by default is FreeTSA's (https://freetsa.org/files/cacert.pem)", async () => {
    expect(trustedRoots).toHaveLength(1);
    expect(await sha256Hex(trustedRoots[0]!)).toBe('a6379e7cecc05faa3cbf076013d745e327bbbaa38c0b9af22469d4701d18aabc');
  });
});
