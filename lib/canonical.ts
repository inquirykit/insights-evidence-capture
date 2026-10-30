// RFC 8785 (JSON Canonicalization Scheme): one byte sequence for a JSON value, so a record
// hashes and signs the same wherever it is serialized. The server (ai_toolkit, rfc8785) and
// the browser store both use it; a verifier re-serializes a parsed record and compares.
//
// RFC 8785 is defined in terms of ECMAScript's JSON.stringify for strings and numbers; what
// it adds is object keys sorted by UTF-16 code units and no whitespace.

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export function canonicalize(value: unknown): string {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'string') return str(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('canonical JSON cannot hold NaN or Infinity');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((v) => canonicalize(v === undefined ? null : v)).join(',')}]`;
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    // JavaScript compares strings by UTF-16 code unit, which is the order RFC 8785 asks for.
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${keys.map((k) => `${str(k)}:${canonicalize(obj[k])}`).join(',')}}`;
  }
  throw new Error(`canonical JSON cannot hold a ${typeof value}`);
}

/** RFC 8785 serializes strings as UTF-8, which has no encoding for a lone surrogate; the
 *  server's canonicalizer (rfc8785) refuses one, and so does this, so both stores agree. */
function str(text: string): string {
  if (!text.isWellFormed()) throw new Error('canonical JSON cannot hold a lone surrogate');
  return JSON.stringify(text);
}

/** Whether `text` is exactly the canonical form of the JSON it holds. */
export function isCanonical(text: string): boolean {
  try {
    return canonicalize(JSON.parse(text)) === text;
  } catch {
    return false;
  }
}
