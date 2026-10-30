// The rules for lib/page/: its functions run inside the captured page, most of them passed to
// scripting.executeScript({ func }), which sends the function's source alone. Anything it uses
// from its module (an import, a constant, a helper, another export) is missing there, and the
// capture fails only at run time. So, in every file:
//   • imports are types only (erased from the build);
//   • at the top level, only exported functions and types: no constants, helpers or other code;
//   • an exported function never calls another;
//   • each one's source parses on its own;
//   • every injection (lib/capture.ts, lib/auto-capture.ts) passes as many args as its function
//     takes: the types let `args` be left out, and the function would then run with undefined.

import { describe, expect, test } from 'bun:test';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

const DIR = join(import.meta.dir, '..', 'lib', 'page');
const files = (await readdir(DIR)).filter((f) => f.endsWith('.ts')).sort();

/** The file's top-level lines: those starting at column 0 that aren't comments or closers. */
function topLevel(source: string): string[] {
  const out: string[] = [];
  let inComment = false;
  for (const line of source.split('\n')) {
    if (inComment) {
      if (line.includes('*/')) inComment = false;
      continue;
    }
    if (/^\s*\/\*/.test(line) && !line.includes('*/')) {
      inComment = true;
      continue;
    }
    if (/^\s|^$|^\/\/|^\/\*.*\*\/\s*$|^[}\])]/.test(line)) continue;
    out.push(line);
  }
  return out;
}

const ALLOWED = /^(import type |export (async )?function \w+|export (interface|type) \w+|(interface|type) \w+)/;

test('lib/page has its files', () => {
  expect(files).toEqual(['dom-monitor.ts', 'fingerprint.ts', 'page-info.ts', 'picker.ts', 'scroll.ts']);
});

for (const file of files) {
  describe(`lib/page/${file}`, async () => {
    const source = await Bun.file(join(DIR, file)).text();
    const module = (await import(join(DIR, file))) as Record<string, unknown>;
    const functions = Object.entries(module).filter((entry): entry is [string, Function] => typeof entry[1] === 'function');

    test('imports types only, and has nothing at the top level but exported functions and types', () => {
      const multiLineImport = /^import type \{$/;
      const offending = topLevel(source).filter((line) => !ALLOWED.test(line) && !multiLineImport.test(line));
      expect(offending).toEqual([]);
      expect(source).not.toMatch(/^import (?!type )/m);
    });

    test('exports functions, each one standing alone', () => {
      expect(functions.length).toBeGreaterThan(0);
      for (const [name, fn] of functions) {
        const code = fn.toString();
        for (const [other] of functions) {
          if (other !== name) expect(code, `${name} uses ${other}`).not.toMatch(new RegExp(`\\b${other}\\b`));
        }
        expect(code).not.toContain('import(');
        expect(() => new Function(`return (${code})`)(), `${name} parses alone`).not.toThrow();
      }
    });
  });
}

describe('injections pass what their function takes', async () => {
  const pageFunctions = new Map<string, Function>();
  for (const file of files) {
    for (const [name, value] of Object.entries(await import(join(DIR, file))))
      if (typeof value === 'function') pageFunctions.set(name, value);
  }
  for (const caller of ['capture.ts', 'auto-capture.ts']) {
    const source = await Bun.file(join(DIR, '..', caller)).text();
    test(`lib/${caller}`, () => {
      const injections = [...source.matchAll(/func: (\w+)(?:,\s*args: \[([^\]]*)\])?/g)];
      expect(injections.length).toBeGreaterThan(0);
      for (const [, name, args] of injections) {
        const fn = pageFunctions.get(name!);
        expect(fn, `${name} comes from lib/page`).toBeDefined();
        const given = args === undefined ? 0 : args.split(',').filter((a) => a.trim()).length;
        expect(given, `${name} takes ${fn!.length} args`).toBe(fn!.length);
      }
    });
  }
});
