// RFC 3161 trusted timestamps, from the browser. Only the record's SHA-256 is sent to the
// time stamping authority; its signed reply (the whole TimeStampResp, DER, as it came) proves
// the record existed at `genTime`. `inspect` reads a reply: status, hash algorithm, imprint and
// nonce. `verifyToken` also checks that the TSA made it: the CMS signature over the TSTInfo, by
// a timestamping certificate that chains to a trusted root (FreeTSA's, lib/freetsa-root.ts),
// each certificate valid at genTime. Revocation is not checked; `openssl ts -verify` makes the
// same check outside the browser, as docs/evidence.md says.
//
// The DER needed is small enough to write by hand: a TimeStampReq is five values, and reading
// a TimeStampResp is walking nested SEQUENCEs down to the TSTInfo, its signer and certificates.

import { base64ToBytes, bytesEqual, hexToBytes } from './bytes';
import { FREETSA_ROOT_CA } from './freetsa-root';

export const DEFAULT_TSA_URL = 'https://freetsa.org/tsr';
const TIMEOUT_MS = 20_000;

/** Root certificates (DER) a TSA's certificate must chain to: FreeTSA's, which DEFAULT_TSA_URL
 *  answers for. Tests add their fake TSA's. */
export const trustedRoots: Uint8Array<ArrayBuffer>[] = [base64ToBytes(FREETSA_ROOT_CA.replace(/\s/g, ''))];

// OIDs, as DER content bytes
const OID_SHA256 = [0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01]; // 2.16.840.1.101.3.4.2.1
const OID_SIGNED_DATA = [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x02]; // 1.2.840.113549.1.7.2
const OID_TST_INFO = [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x09, 0x10, 0x01, 0x04]; // 1.2.840.113549.1.9.16.1.4

// The OIDs verifying a token looks up, as dotted text
const OID = {
  contentType: '1.2.840.113549.1.9.3',
  messageDigest: '1.2.840.113549.1.9.4',
  tstInfo: '1.2.840.113549.1.9.16.1.4',
  subjectKeyId: '2.5.29.14',
  basicConstraints: '2.5.29.19',
  extKeyUsage: '2.5.29.37',
  timeStamping: '1.3.6.1.5.5.7.3.8',
  rsa: '1.2.840.113549.1.1.1',
  ec: '1.2.840.10045.2.1',
  ed25519: '1.3.101.112',
};

const DIGESTS: Record<string, string> = {
  '2.16.840.1.101.3.4.2.1': 'SHA-256',
  '2.16.840.1.101.3.4.2.2': 'SHA-384',
  '2.16.840.1.101.3.4.2.3': 'SHA-512',
};

// Signature algorithm → the key algorithm it needs, and its hash (rsaEncryption, as a SignerInfo
// names it, takes the signer's digest algorithm)
const SIGNATURES: Record<string, { key: string; hash?: string }> = {
  [OID.rsa]: { key: OID.rsa },
  '1.2.840.113549.1.1.11': { key: OID.rsa, hash: 'SHA-256' },
  '1.2.840.113549.1.1.12': { key: OID.rsa, hash: 'SHA-384' },
  '1.2.840.113549.1.1.13': { key: OID.rsa, hash: 'SHA-512' },
  '1.2.840.10045.4.3.2': { key: OID.ec, hash: 'SHA-256' },
  '1.2.840.10045.4.3.3': { key: OID.ec, hash: 'SHA-384' },
  '1.2.840.10045.4.3.4': { key: OID.ec, hash: 'SHA-512' },
  [OID.ed25519]: { key: OID.ed25519 },
};

const CURVES: Record<string, { namedCurve: string; size: number }> = {
  '1.2.840.10045.3.1.7': { namedCurve: 'P-256', size: 32 },
  '1.3.132.0.34': { namedCurve: 'P-384', size: 48 },
  '1.3.132.0.35': { namedCurve: 'P-521', size: 66 },
};

const TAG = {
  boolean: 0x01,
  integer: 0x02,
  bitString: 0x03,
  octetString: 0x04,
  null: 0x05,
  oid: 0x06,
  utf8: 0x0c,
  utcTime: 0x17,
  generalizedTime: 0x18,
  sequence: 0x30,
  set: 0x31,
  implicit0: 0x80,
  context0: 0xa0,
  context3: 0xa3,
};

const PKI_STATUS = ['granted', 'grantedWithMods', 'rejection', 'waiting', 'revocationWarning', 'revocationNotification'];

export class TsaError extends Error {}

export interface TimestampToken {
  /** The TimeStampResp, DER, exactly as the TSA sent it (record.tsr) */
  response: Uint8Array<ArrayBuffer>;
  genTime: string;
}

export interface TokenInfo {
  genTime: string;
  nonce: Uint8Array | null;
}

// ---------------------------------------------------------------------------
// Encoding

function der(tag: number, content: ArrayLike<number>): Uint8Array<ArrayBuffer> {
  const n = content.length;
  const len: number[] = [];
  if (n < 0x80) len.push(n);
  else {
    let v = n;
    while (v > 0) {
      len.unshift(v & 0xff);
      v >>>= 8;
    }
    len.unshift(0x80 | len.length);
  }
  const out = new Uint8Array(1 + len.length + n);
  out[0] = tag;
  out.set(len, 1);
  out.set(content, 1 + len.length);
  return out;
}

const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

/** A positive INTEGER from big-endian magnitude bytes. */
function integer(magnitude: Uint8Array): Uint8Array<ArrayBuffer> {
  let start = 0;
  while (start < magnitude.length - 1 && magnitude[start] === 0) start++;
  const m = magnitude.subarray(start);
  return der(TAG.integer, m[0]! & 0x80 ? concat(new Uint8Array([0]), m) : m);
}

/** TimeStampReq over `digest` (a SHA-256), with a fresh nonce, asking for the TSA's certificate. */
export function buildRequest(digest: Uint8Array): { request: Uint8Array<ArrayBuffer>; nonce: Uint8Array } {
  if (digest.length !== 32) throw new TsaError('the imprint must be a SHA-256 digest');
  const nonce = crypto.getRandomValues(new Uint8Array(8));
  nonce[0]! |= 0x01; // never zero
  const algorithm = der(TAG.sequence, concat(der(TAG.oid, OID_SHA256), der(TAG.null, [])));
  const imprint = der(TAG.sequence, concat(algorithm, der(TAG.octetString, digest)));
  const request = der(
    TAG.sequence,
    concat(integer(new Uint8Array([1])), imprint, integer(nonce), der(TAG.boolean, [0xff])),
  );
  return { request, nonce };
}

// ---------------------------------------------------------------------------
// Decoding

interface Tlv {
  tag: number;
  /** Where the tag is, and the content's bounds, within the buffer */
  at: number;
  start: number;
  end: number;
}

function read(buf: Uint8Array, at: number, limit = buf.length): Tlv {
  if (at + 2 > limit) throw new TsaError('DER truncated');
  const tag = buf[at]!;
  if ((tag & 0x1f) === 0x1f) throw new TsaError('DER multi-byte tags are not supported');
  let len = buf[at + 1]!;
  let head = 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 4 || at + 2 + n > limit) throw new TsaError('DER length invalid');
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[at + 2 + i]!;
    head += n;
  }
  const start = at + head;
  const end = start + len;
  if (end > limit) throw new TsaError('DER value runs past its container');
  return { tag, at, start, end };
}

function children(buf: Uint8Array, tlv: Tlv): Tlv[] {
  const out: Tlv[] = [];
  let at = tlv.start;
  while (at < tlv.end) {
    const child = read(buf, at, tlv.end);
    out.push(child);
    at = child.end;
  }
  return out;
}

const content = <T extends ArrayBufferLike>(buf: Uint8Array<T>, tlv: Tlv) => buf.subarray(tlv.start, tlv.end);
/** The whole TLV: tag, length and content */
const whole = <T extends ArrayBufferLike>(buf: Uint8Array<T>, tlv: Tlv) => buf.subarray(tlv.at, tlv.end);
const expect = (tlv: Tlv | undefined, tag: number, what: string): Tlv => {
  if (!tlv || tlv.tag !== tag) throw new TsaError(`${what}: expected tag 0x${tag.toString(16)}, found ${tlv ? `0x${tlv.tag.toString(16)}` : 'nothing'}`);
  return tlv;
};
const smallInt = (buf: Uint8Array, tlv: Tlv) => content(buf, tlv).reduce((n, b) => n * 256 + b, 0);
const unsigned = <T extends ArrayBufferLike>(bytes: Uint8Array<T>) => {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) start++;
  return bytes.subarray(start);
};

/** OID content bytes → dotted text, e.g. 1.2.840.113549.1.9.4 */
function oidText(bytes: Uint8Array): string {
  const arcs: number[] = [];
  let value = 0;
  for (const b of bytes) {
    value = value * 128 + (b & 0x7f);
    if (!(b & 0x80)) {
      arcs.push(value);
      value = 0;
    }
  }
  const first = arcs.shift() ?? 0;
  const root = first < 80 ? Math.floor(first / 40) : 2;
  return [root, first - root * 40, ...arcs].join('.');
}

const oidOf = (buf: Uint8Array, tlv: Tlv | undefined, what: string) => oidText(content(buf, expect(tlv, TAG.oid, what)));
/** The algorithm OID of an AlgorithmIdentifier */
const algorithmOf = (buf: Uint8Array, tlv: Tlv | undefined, what: string) =>
  oidOf(buf, children(buf, expect(tlv, TAG.sequence, what))[0], what);

/** YYYYMMDDHHMMSS[.fff]Z → ISO 8601 in UTC, milliseconds only when there are any. */
function generalizedTimeToIso(text: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:[.,](\d+))?Z$/.exec(text);
  if (!m) throw new TsaError(`unsupported GeneralizedTime ${text}`);
  const ms = m[7] ? m[7].padEnd(3, '0').slice(0, 3) : '';
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${ms && ms !== '000' ? `.${ms}` : ''}Z`;
}

interface Token {
  info: TokenInfo;
  signedData: Tlv;
  /** The TSTInfo, DER: what the TSA signed */
  tstInfo: Uint8Array<ArrayBuffer>;
}

function readToken(buf: Uint8Array<ArrayBuffer>, digest: Uint8Array): Token {
  const resp = expect(read(buf, 0), TAG.sequence, 'TimeStampResp');
  const [statusInfo, token] = children(buf, resp);
  const statusParts = children(buf, expect(statusInfo, TAG.sequence, 'PKIStatusInfo'));
  const status = smallInt(buf, expect(statusParts[0], TAG.integer, 'PKIStatus'));
  if (status > 1) {
    const texts = statusParts[1]?.tag === TAG.sequence
      ? children(buf, statusParts[1]).map((s) => new TextDecoder().decode(content(buf, s)))
      : [];
    throw new TsaError(`TSA refused the request: ${PKI_STATUS[status] ?? status} ${texts.join(' ')}`.trim());
  }
  if (!token) throw new TsaError('TSA response has no token');

  const [contentType, wrapped] = children(buf, expect(token, TAG.sequence, 'ContentInfo'));
  if (!bytesEqual(content(buf, expect(contentType, TAG.oid, 'contentType')), new Uint8Array(OID_SIGNED_DATA)))
    throw new TsaError('token is not CMS SignedData');
  const signedData = expect(children(buf, expect(wrapped, TAG.context0, 'content'))[0], TAG.sequence, 'SignedData');
  const encap = expect(children(buf, signedData)[2], TAG.sequence, 'EncapsulatedContentInfo');
  const [eContentType, eContent] = children(buf, encap);
  if (!bytesEqual(content(buf, expect(eContentType, TAG.oid, 'eContentType')), new Uint8Array(OID_TST_INFO)))
    throw new TsaError('token content is not a TSTInfo');
  const tstBytes = content(buf, expect(children(buf, expect(eContent, TAG.context0, 'eContent'))[0], TAG.octetString, 'eContent'));

  const tst = children(tstBytes, expect(read(tstBytes, 0), TAG.sequence, 'TSTInfo'));
  const imprint = children(tstBytes, expect(tst[2], TAG.sequence, 'MessageImprint'));
  const algorithm = children(tstBytes, expect(imprint[0], TAG.sequence, 'AlgorithmIdentifier'));
  if (!bytesEqual(content(tstBytes, expect(algorithm[0], TAG.oid, 'hash algorithm')), new Uint8Array(OID_SHA256)))
    throw new TsaError('token imprint is not SHA-256');
  if (!bytesEqual(content(tstBytes, expect(imprint[1], TAG.octetString, 'hashedMessage')), digest))
    throw new TsaError('token imprint does not match the record hash');
  const genTime = generalizedTimeToIso(
    new TextDecoder().decode(content(tstBytes, expect(tst[4], TAG.generalizedTime, 'genTime'))),
  );
  // After genTime: accuracy (SEQUENCE), ordering (BOOLEAN), nonce (INTEGER), tsa, extensions
  const nonce = tst.slice(5).find((t) => t.tag === TAG.integer);
  return { info: { genTime, nonce: nonce ? unsigned(content(tstBytes, nonce)) : null }, signedData, tstInfo: tstBytes };
}

/** Decodes a TimeStampResp and checks that its token covers `digest` (a SHA-256). Who signed it
 *  is verifyToken's to check. */
export function inspect(response: Uint8Array<ArrayBuffer>, digest: Uint8Array): TokenInfo {
  return readToken(response, digest).info;
}

// ---------------------------------------------------------------------------
// Verifying: the signature, and the certificates up to a trusted root

interface Certificate {
  /** TBSCertificate, DER: what the issuer signed */
  tbs: Uint8Array<ArrayBuffer>;
  signatureAlgorithm: string;
  signature: Uint8Array<ArrayBuffer>;
  serial: Uint8Array;
  /** Names, DER */
  issuer: Uint8Array;
  subject: Uint8Array;
  notBefore: number;
  notAfter: number;
  /** SubjectPublicKeyInfo, DER, as WebCrypto imports it */
  spki: Uint8Array<ArrayBuffer>;
  keyAlgorithm: string;
  curve: string | null;
  /** By OID: whether critical, and the extnValue's content (DER) */
  extensions: Map<string, { critical: boolean; value: Uint8Array }>;
}

/** A certificate's UTCTime (YYMMDDHHMMSSZ, 1950 to 2049) or GeneralizedTime, in ms since the epoch */
function certificateTime(buf: Uint8Array, tlv: Tlv | undefined): number {
  if (tlv?.tag === TAG.utcTime) {
    const text = new TextDecoder().decode(content(buf, tlv));
    return Date.parse(generalizedTimeToIso(`${Number(text.slice(0, 2)) < 50 ? '20' : '19'}${text}`));
  }
  return Date.parse(generalizedTimeToIso(new TextDecoder().decode(content(buf, expect(tlv, TAG.generalizedTime, 'Time')))));
}

function readCertificate(buf: Uint8Array<ArrayBuffer>, tlv: Tlv): Certificate {
  const [tbs, signatureAlgorithm, signature] = children(buf, expect(tlv, TAG.sequence, 'Certificate'));
  const fields = children(buf, expect(tbs, TAG.sequence, 'TBSCertificate'));
  // TBSCertificate: [0] version (absent in v1), serialNumber, signature, issuer, validity, subject,
  // subjectPublicKeyInfo, then [1] and [2] unique IDs and [3] extensions, each optional
  const [serial, , issuer, validity, subject, spki, ...rest] = fields[0]?.tag === TAG.context0 ? fields.slice(1) : fields;
  const [notBefore, notAfter] = children(buf, expect(validity, TAG.sequence, 'Validity'));
  const spkiTlv = expect(spki, TAG.sequence, 'SubjectPublicKeyInfo');
  const keyAlgorithm = children(buf, expect(children(buf, spkiTlv)[0], TAG.sequence, 'AlgorithmIdentifier'));

  const extensions: Certificate['extensions'] = new Map();
  const wrapped = rest.find((t) => t.tag === TAG.context3);
  for (const extension of wrapped ? children(buf, expect(children(buf, wrapped)[0], TAG.sequence, 'Extensions')) : []) {
    // Extension: extnID, critical (BOOLEAN, left out when false), extnValue
    const [id, ...more] = children(buf, expect(extension, TAG.sequence, 'Extension'));
    extensions.set(oidOf(buf, id, 'extnID'), {
      critical: more[0]?.tag === TAG.boolean && content(buf, more[0])[0] !== 0,
      value: content(buf, expect(more.at(-1), TAG.octetString, 'extnValue')),
    });
  }

  return {
    tbs: whole(buf, expect(tbs, TAG.sequence, 'TBSCertificate')),
    signatureAlgorithm: algorithmOf(buf, signatureAlgorithm, 'signatureAlgorithm'),
    // After the count of unused bits, which is 0 for a signature
    signature: content(buf, expect(signature, TAG.bitString, 'signatureValue')).subarray(1),
    serial: content(buf, expect(serial, TAG.integer, 'serialNumber')),
    issuer: whole(buf, expect(issuer, TAG.sequence, 'issuer')),
    subject: whole(buf, expect(subject, TAG.sequence, 'subject')),
    notBefore: certificateTime(buf, notBefore),
    notAfter: certificateTime(buf, notAfter),
    spki: whole(buf, spkiTlv),
    keyAlgorithm: oidOf(buf, keyAlgorithm[0], 'key algorithm'),
    curve: keyAlgorithm[1]?.tag === TAG.oid ? oidText(content(buf, keyAlgorithm[1])) : null,
    extensions,
  };
}

const validAt = (cert: Certificate, time: number) => cert.notBefore <= time && time <= cert.notAfter;

function isCa(cert: Certificate): boolean {
  const constraints = cert.extensions.get(OID.basicConstraints);
  if (!constraints) return false;
  // BasicConstraints: cA (BOOLEAN, left out when false), pathLenConstraint
  const first = children(constraints.value, expect(read(constraints.value, 0), TAG.sequence, 'BasicConstraints'))[0];
  return first?.tag === TAG.boolean && content(constraints.value, first)[0] !== 0;
}

/** Whether a SignerInfo's sid names `cert`: by issuer and serial number, or by subject key identifier. */
function identifies(buf: Uint8Array, sid: Tlv | undefined, cert: Certificate): boolean {
  if (sid?.tag === TAG.sequence) {
    const [issuer, serial] = children(buf, sid);
    return !!issuer && !!serial && bytesEqual(whole(buf, issuer), cert.issuer) && bytesEqual(content(buf, serial), cert.serial);
  }
  if (sid?.tag === TAG.implicit0) {
    const keyId = cert.extensions.get(OID.subjectKeyId);
    return !!keyId && bytesEqual(content(keyId.value, expect(read(keyId.value, 0), TAG.octetString, 'SubjectKeyIdentifier')), content(buf, sid));
  }
  return false;
}

/** An ECDSA signature as WebCrypto takes it, r and s at `size` bytes each, from DER's SEQUENCE of two INTEGERs. */
function ecdsaRaw(signature: Uint8Array, size: number): Uint8Array<ArrayBuffer> {
  const [r, s, ...extra] = children(signature, expect(read(signature, 0), TAG.sequence, 'ECDSA signature'));
  if (extra.length) throw new TsaError('ECDSA signature malformed');
  const out = new Uint8Array(2 * size);
  for (const [i, part] of [r, s].entries()) {
    const n = unsigned(content(signature, expect(part, TAG.integer, 'ECDSA signature')));
    if (n.length > size) throw new TsaError('ECDSA signature malformed');
    out.set(n, (i + 1) * size - n.length);
  }
  return out;
}

/** Whether `signature` over `data` verifies with `cert`'s key, by the signature algorithm named;
 *  `digestHash` is the hash for rsaEncryption, which names none. */
async function verifySignature(
  cert: Certificate,
  algorithm: string,
  digestHash: string | null,
  signature: Uint8Array<ArrayBuffer>,
  data: Uint8Array<ArrayBuffer>,
): Promise<boolean> {
  const fits = SIGNATURES[algorithm];
  if (!fits) throw new TsaError(`unsupported signature algorithm ${algorithm}`);
  if (fits.key !== cert.keyAlgorithm) throw new TsaError(`signature algorithm ${algorithm} does not fit a ${cert.keyAlgorithm} key`);
  const hash = fits.hash ?? digestHash;
  if (fits.key === OID.rsa) {
    if (!hash) throw new TsaError(`signature algorithm ${algorithm} names no hash`);
    const key = await crypto.subtle.importKey('spki', cert.spki, { name: 'RSASSA-PKCS1-v1_5', hash }, false, ['verify']);
    return crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature, data);
  }
  if (fits.key === OID.ec) {
    const curve = CURVES[cert.curve ?? ''];
    if (!curve || !hash) throw new TsaError(`unsupported elliptic curve ${cert.curve}`);
    const key = await crypto.subtle.importKey('spki', cert.spki, { name: 'ECDSA', namedCurve: curve.namedCurve }, false, ['verify']);
    return crypto.subtle.verify({ name: 'ECDSA', hash }, key, ecdsaRaw(signature, curve.size), data);
  }
  const key = await crypto.subtle.importKey('spki', cert.spki, 'Ed25519', false, ['verify']);
  return crypto.subtle.verify('Ed25519', key, signature, data);
}

/** From the TSA's certificate up to one of `roots`, through CA certificates the token carries,
 *  each valid at `time` (genTime). */
async function checkChain(signer: Certificate, carried: Certificate[], roots: Certificate[], time: number): Promise<void> {
  let cert = signer;
  for (let depth = 0; depth < 4; depth++) {
    if (!validAt(cert, time)) throw new TsaError("a certificate of the TSA's was not valid at genTime");
    for (const root of roots) {
      if (!bytesEqual(root.subject, cert.issuer) || !validAt(root, time)) continue;
      if (await verifySignature(root, cert.signatureAlgorithm, null, cert.signature, cert.tbs)) return;
    }
    const issuer = carried.find((c) => c !== cert && isCa(c) && bytesEqual(c.subject, cert.issuer));
    if (!issuer || !(await verifySignature(issuer, cert.signatureAlgorithm, null, cert.signature, cert.tbs))) break;
    cert = issuer;
  }
  throw new TsaError("the TSA's certificate does not chain to a trusted root");
}

/** Decodes a TimeStampResp and checks that its token covers `digest` (a SHA-256) and was signed
 *  by a TSA certified by one of `roots`: the signed attributes name the TSTInfo and carry its
 *  digest, the signer's certificate is for timestamping only, and it and each certificate above
 *  it were valid at genTime. */
export async function verifyToken(
  response: Uint8Array<ArrayBuffer>,
  digest: Uint8Array,
  roots: Uint8Array<ArrayBuffer>[] = trustedRoots,
): Promise<TokenInfo> {
  const buf = response;
  const { info, signedData, tstInfo } = readToken(buf, digest);

  // SignedData: version, digestAlgorithms, encapContentInfo, [0] certificates, [1] crls, signerInfos
  const parts = children(buf, signedData);
  const certificateSet = parts.find((t) => t.tag === TAG.context0);
  const certificates = certificateSet
    ? children(buf, certificateSet).filter((t) => t.tag === TAG.sequence).map((t) => readCertificate(buf, t))
    : [];
  const signers = children(buf, expect(parts.at(-1), TAG.set, 'SignerInfos'));
  if (signers.length !== 1) throw new TsaError(`token has ${signers.length} signers, expected one`);
  // SignerInfo: version, sid, digestAlgorithm, [0] signedAttrs, signatureAlgorithm, signature, [1] unsignedAttrs
  const [, sid, digestAlgorithm, signedAttrs, signatureAlgorithm, signature] = children(buf, expect(signers[0], TAG.sequence, 'SignerInfo'));
  const digestOid = algorithmOf(buf, digestAlgorithm, 'digestAlgorithm');
  const hash = DIGESTS[digestOid];
  if (!hash) throw new TsaError(`unsupported digest algorithm ${digestOid}`);

  const attributesTlv = expect(signedAttrs, TAG.context0, 'signedAttrs');
  const attributes = new Map<string, Tlv | undefined>();
  for (const attribute of children(buf, attributesTlv)) {
    const [type, values] = children(buf, expect(attribute, TAG.sequence, 'Attribute'));
    attributes.set(oidOf(buf, type, 'attrType'), children(buf, expect(values, TAG.set, 'attrValues'))[0]);
  }
  if (oidOf(buf, attributes.get(OID.contentType), 'contentType attribute') !== OID.tstInfo)
    throw new TsaError('the signed attributes do not name a TSTInfo');
  const tstDigest = new Uint8Array(await crypto.subtle.digest(hash, tstInfo));
  if (!bytesEqual(content(buf, expect(attributes.get(OID.messageDigest), TAG.octetString, 'messageDigest attribute')), tstDigest))
    throw new TsaError('the TSA signature is not over this TSTInfo');

  const signer = certificates.find((c) => identifies(buf, sid, c));
  if (!signer) throw new TsaError("the token does not carry the TSA's certificate");
  const usage = signer.extensions.get(OID.extKeyUsage);
  const purposes = usage ? children(usage.value, expect(read(usage.value, 0), TAG.sequence, 'ExtKeyUsage')).map((t) => oidOf(usage.value, t, 'KeyPurposeId')) : [];
  if (!usage?.critical || purposes.join() !== OID.timeStamping) throw new TsaError("the TSA's certificate is not for timestamping only");

  // The signature is over the signed attributes as DER, tagged as the SET they are
  const signed = buf.slice(attributesTlv.at, attributesTlv.end);
  signed[0] = TAG.set;
  const signatureBytes = content(buf, expect(signature, TAG.octetString, 'signature'));
  if (!(await verifySignature(signer, algorithmOf(buf, signatureAlgorithm, 'signatureAlgorithm'), hash, signatureBytes, signed)))
    throw new TsaError('the TSA signature does not verify');

  await checkChain(signer, certificates, roots.map((der) => readCertificate(der, read(der, 0))), Date.parse(info.genTime));
  return info;
}

/** Asks the TSA for a token over the record whose SHA-256 is `recordHash` (hex), and verifies it. */
export async function requestTimestamp(recordHash: string, url = DEFAULT_TSA_URL): Promise<TimestampToken> {
  const digest = hexToBytes(recordHash);
  const { request, nonce } = buildRequest(digest);
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/timestamp-query' },
      body: request,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: 'error',
    });
  } catch (e) {
    throw new TsaError(`contacting TSA ${url}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (res.status >= 400) throw new TsaError(`TSA ${url} answered HTTP ${res.status}`);
  const response = new Uint8Array(await res.arrayBuffer());
  const info = await verifyToken(response, digest);
  if (!info.nonce || !bytesEqual(info.nonce, unsigned(nonce))) throw new TsaError('TSA response nonce does not match request');
  return { response, genTime: info.genTime };
}
