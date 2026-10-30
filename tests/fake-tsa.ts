// A stand-in for FreeTSA, answering lib/tsa.ts's TimeStampReq the way a TSA does: granted, the
// request's imprint and nonce in a TSTInfo, inside CMS SignedData signed by a timestamping
// certificate under the fake TSA's own root (Ed25519, made when this module loads). While
// `fakeTsa` stands in for fetch, lib/tsa.ts trusts that root, so its tokens verify; `stranger`
// signs the same way under a root nobody trusts. Real tokens are checked in golden.test.ts.

import { trustedRoots } from '../lib/tsa';

const OID_SHA256 = [0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01];
const OID_SIGNED_DATA = [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x02];
const OID_TST_INFO = [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x09, 0x10, 0x01, 0x04];
const OID_POLICY = [0x2a, 0x03, 0x04]; // 1.2.3.4
const OID_CONTENT_TYPE = [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x09, 0x03]; // 1.2.840.113549.1.9.3
const OID_MESSAGE_DIGEST = [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x09, 0x04]; // 1.2.840.113549.1.9.4
const OID_ED25519 = [0x2b, 0x65, 0x70]; // 1.3.101.112
const OID_COMMON_NAME = [0x55, 0x04, 0x03]; // 2.5.4.3
const OID_BASIC_CONSTRAINTS = [0x55, 0x1d, 0x13]; // 2.5.29.19
const OID_EXT_KEY_USAGE = [0x55, 0x1d, 0x25]; // 2.5.29.37
const OID_TIME_STAMPING = [0x2b, 0x06, 0x01, 0x05, 0x05, 0x07, 0x03, 0x08]; // 1.3.6.1.5.5.7.3.8

function der(tag: number, ...parts: ArrayLike<number>[]): Uint8Array<ArrayBuffer> {
  const body = Uint8Array.from(parts.flatMap((p) => Array.from(p)));
  const n = body.length;
  const len = n < 0x80 ? [n] : n < 0x100 ? [0x81, n] : [0x82, n >> 8, n & 0xff];
  return Uint8Array.from([tag, ...len, ...body]);
}

/** Each element of the SEQUENCE at the start of `buf`, whole (tag, length and content). */
function elements(buf: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  const lengthAt = (at: number) => {
    const first = buf[at]!;
    if (first < 0x80) return { len: first, head: 1 };
    const n = first & 0x7f;
    let len = 0;
    for (let i = 0; i < n; i++) len = (len << 8) | buf[at + 1 + i]!;
    return { len, head: 1 + n };
  };
  const outer = lengthAt(1);
  let at = 1 + outer.head;
  while (at < 1 + outer.head + outer.len) {
    const { len, head } = lengthAt(at + 1);
    out.push(buf.subarray(at, at + 1 + head + len));
    at += 1 + head + len;
  }
  return out;
}

const contentOf = (tlv: Uint8Array) => {
  const first = tlv[1]!;
  return tlv.subarray(first < 0x80 ? 2 : 2 + (first & 0x7f));
};

const text = (s: string) => new TextEncoder().encode(s);

/** "2026-10-25T12:00:00Z" → GeneralizedTime 20261025120000Z */
const generalizedTime = (iso: string) => text(iso.replace(/[-:T]/g, '').replace(/\.\d+/, ''));

// ---------------------------------------------------------------------------
// The authority: a root, and a timestamping certificate under it

export interface Authority {
  /** The root certificate, DER: what a verifier trusts */
  root: Uint8Array<ArrayBuffer>;
  /** The TSA's certificate, DER, which each token carries */
  certificate: Uint8Array<ArrayBuffer>;
  key: CryptoKey;
  issuer: string;
  serial: number;
}

const ED25519 = der(0x30, der(0x06, OID_ED25519));
const name = (cn: string) => der(0x30, der(0x31, der(0x30, der(0x06, OID_COMMON_NAME), der(0x0c, text(cn)))));
const sign = async (key: CryptoKey, data: Uint8Array<ArrayBuffer>) => new Uint8Array(await crypto.subtle.sign('Ed25519', key, data));
const ed25519Keys = () => crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify']) as Promise<CryptoKeyPair>;

/** An X.509 v3 certificate, valid 2000 to 2099, with one critical extension. */
async function certificate(serial: number, issuer: string, issuerKey: CryptoKey, subject: string, subjectKey: CryptoKey, extension: Uint8Array) {
  const tbs = der(
    0x30,
    der(0xa0, der(0x02, [2])),
    der(0x02, [serial]),
    ED25519,
    name(issuer),
    der(0x30, der(0x18, text('20000101000000Z')), der(0x18, text('20991231235959Z'))),
    name(subject),
    new Uint8Array(await crypto.subtle.exportKey('spki', subjectKey)),
    der(0xa3, der(0x30, extension)),
  );
  return der(0x30, tbs, ED25519, der(0x03, [0], await sign(issuerKey, tbs)));
}

async function authority(cn: string): Promise<Authority> {
  const rootKeys = await ed25519Keys();
  const keys = await ed25519Keys();
  const issuer = `${cn} Root`;
  const isCa = der(0x30, der(0x06, OID_BASIC_CONSTRAINTS), der(0x01, [0xff]), der(0x04, der(0x30, der(0x01, [0xff]))));
  const timestampingOnly = der(0x30, der(0x06, OID_EXT_KEY_USAGE), der(0x01, [0xff]), der(0x04, der(0x30, der(0x06, OID_TIME_STAMPING))));
  return {
    root: await certificate(1, issuer, rootKeys.privateKey, issuer, rootKeys.publicKey, isCa),
    certificate: await certificate(2, issuer, rootKeys.privateKey, cn, keys.publicKey, timestampingOnly),
    key: keys.privateKey,
    issuer,
    serial: 2,
  };
}

export const fake = await authority('Fake TSA');
export const stranger = await authority('Stranger TSA');

// ---------------------------------------------------------------------------
// Tokens

/** The TimeStampResp for `request`, as lib/tsa.ts's buildRequest makes it, signed by `by`. */
export async function timestampReply(request: Uint8Array, genTime = '2026-10-25T12:00:00Z', by = fake): Promise<Uint8Array<ArrayBuffer>> {
  const [, imprint, nonce] = elements(request);
  const tstInfo = der(
    0x30,
    der(0x02, [1]),
    der(0x06, OID_POLICY),
    imprint!,
    der(0x02, [0x2a]),
    der(0x18, generalizedTime(genTime)),
    nonce!,
  );
  const signedAttrs = [
    der(0x30, der(0x06, OID_CONTENT_TYPE), der(0x31, der(0x06, OID_TST_INFO))),
    der(0x30, der(0x06, OID_MESSAGE_DIGEST), der(0x31, der(0x04, new Uint8Array(await crypto.subtle.digest('SHA-256', tstInfo))))),
  ];
  const signerInfo = der(
    0x30,
    der(0x02, [1]),
    der(0x30, name(by.issuer), der(0x02, [by.serial])),
    der(0x30, der(0x06, OID_SHA256)),
    der(0xa0, ...signedAttrs),
    ED25519,
    der(0x04, await sign(by.key, der(0x31, ...signedAttrs))),
  );
  const signedData = der(
    0x30,
    der(0x02, [3]),
    der(0x31, der(0x30, der(0x06, OID_SHA256), der(0x05))),
    der(0x30, der(0x06, OID_TST_INFO), der(0xa0, der(0x04, tstInfo))),
    der(0xa0, by.certificate),
    der(0x31, signerInfo),
  );
  return der(0x30, der(0x30, der(0x02, [0])), der(0x30, der(0x06, OID_SIGNED_DATA), der(0xa0, signedData)));
}

/** The SHA-256 a TimeStampReq asks to have timestamped. */
export function requestedDigest(request: Uint8Array): Uint8Array {
  const [, imprint] = elements(request);
  return contentOf(elements(imprint!)[1]!);
}

export type TsaAnswer = { genTime?: string; by?: Authority } | { fail: string };

/** Replaces fetch with a TSA that answers each request with what `answer` says (in order of the
 *  requests), and trusts its root; returns how to put both back. */
export function fakeTsa(answer: (call: number) => TsaAnswer | Promise<TsaAnswer>): () => void {
  const real = globalThis.fetch;
  let calls = 0;
  trustedRoots.push(fake.root);
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const what = await answer(++calls);
    if ('fail' in what) throw new TypeError(what.fail);
    const body = new Uint8Array(init!.body as Uint8Array);
    return new Response(await timestampReply(body, what.genTime, what.by), {
      headers: { 'content-type': 'application/timestamp-reply' },
    });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = real;
    const at = trustedRoots.indexOf(fake.root);
    if (at >= 0) trustedRoots.splice(at, 1);
  };
}
