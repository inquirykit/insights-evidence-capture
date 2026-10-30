// lib/canonical.ts against RFC 8785 and against the server's canonicalizer: the expected bytes in
// fixtures/jcs-vectors.json were made by rfc8785, the library ai_toolkit signs with.

import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import { canonicalize, isCanonical } from '../lib/canonical';

interface Vector {
  input: string;
  canonical: string | null;
  /** The server's error, when it refused the value */
  refused?: string;
}

const vectors = (await Bun.file(join(import.meta.dir, 'fixtures', 'jcs-vectors.json')).json()) as Vector[];

describe('the same bytes as the server', () => {
  for (const v of vectors.filter((v) => v.canonical !== null)) {
    test(v.input.slice(0, 60), () => {
      expect(canonicalize(JSON.parse(v.input))).toBe(v.canonical!);
      expect(isCanonical(v.canonical!)).toBe(true);
    });
  }

  test('the RFC 8785 example, as the RFC prints it', () => {
    const input = vectors[0]!.input;
    expect(canonicalize(JSON.parse(input))).toBe(
      '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],' +
        '"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}',
    );
  });
});

describe('what the server refuses', () => {
  for (const v of vectors.filter((v) => v.refused && v.refused !== 'IntegerDomainError')) {
    test(`refused here too: ${v.input}`, () => {
      expect(() => canonicalize(JSON.parse(v.input))).toThrow('lone surrogate');
    });
  }

  // Known difference, kept visible: JSON.stringify writes an integer from 2^53 up to 1e21 in full,
  // the server reads that as an int, and rfc8785 refuses ints past 2^53. The browser store would
  // sign such a value; the server would refuse the upload. No field of a record holds one today.
  for (const v of vectors.filter((v) => v.refused === 'IntegerDomainError')) {
    test(`taken here, refused by the server: ${v.input}`, () => {
      expect(canonicalize(JSON.parse(v.input))).toBe(JSON.stringify(JSON.parse(v.input)));
    });
  }
});

describe('canonicalize', () => {
  test('leaves out undefined members and writes undefined array items as null', () => {
    expect(canonicalize({ b: undefined, a: [undefined, 1] })).toBe('{"a":[null,1]}');
  });

  test('refuses NaN, Infinity and what JSON has no form for', () => {
    expect(() => canonicalize(NaN)).toThrow();
    expect(() => canonicalize({ x: Infinity })).toThrow();
    expect(() => canonicalize(() => 1)).toThrow();
    expect(() => canonicalize(1n)).toThrow();
  });

  test('isCanonical: false for whitespace, unsorted keys, other number forms, bad JSON', () => {
    expect(isCanonical('{"a":1}')).toBe(true);
    expect(isCanonical('{"a": 1}')).toBe(false);
    expect(isCanonical('{"b":1,"a":2}')).toBe(false);
    expect(isCanonical('[1.0]')).toBe(false);
    expect(isCanonical('{')).toBe(false);
  });
});
