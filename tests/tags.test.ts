// Tags as the user types them (lib/protocol.ts) and as they are styled (lib/tags.ts): what the
// stores accept, from either side.

import { beforeEach, describe, expect, test } from 'bun:test';
import { fakeBrowser } from 'wxt/testing/fake-browser';

import { MAX_TAG, normalizeTag } from '../lib/limits';
import { mergeTags, parseTags } from '../lib/protocol';
import { defaultColor, defOf, getTagDefs, rememberTags, tagKey } from '../lib/tags';

beforeEach(() => fakeBrowser.reset());

describe('typed tags', () => {
  test('split, trimmed, collapsed, kept once, the first spelling winning', () => {
    expect(parseTags('a, b,  b ')).toEqual(['a', 'b']);
    expect(parseTags(' Lorem   Ipsum ,lorem ipsum, ,')).toEqual(['Lorem Ipsum']);
    expect(mergeTags(['Dolor'], ['dolor', 'sit'])).toEqual(['Dolor', 'sit']);
  });

  test('cut to what the stores take, where the stores would refuse', () => {
    const [tag] = parseTags('x'.repeat(MAX_TAG + 10));
    expect(tag).toHaveLength(MAX_TAG);
  });

  test('normalizeTag: the one rule for spelling', () => {
    expect(normalizeTag('\t a \n  b ')).toBe('a b');
  });
});

describe('tag looks', () => {
  test('one key whatever the spelling; an unstyled tag takes a colour from its name, never gray', () => {
    expect(tagKey('  Lorem  IPSUM')).toBe('lorem ipsum');
    expect(defaultColor('Lorem')).toBe(defaultColor('lorem '));
    for (const name of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) expect(defaultColor(name)).not.toBe('gray');
  });

  test('rememberTags makes new tags known and leaves styled ones alone', async () => {
    await rememberTags(['Lorem']);
    const defs = await getTagDefs();
    expect(defs['lorem']).toEqual({ name: 'Lorem', color: defaultColor('Lorem'), icon: null });
    defs['lorem'] = { ...defs['lorem']!, color: 'gray', icon: 'star' };
    await fakeBrowser.storage.local.set({ tagDefs: defs });
    await rememberTags(['LOREM', 'ipsum']);
    const after = await getTagDefs();
    expect(defOf(after, 'lorem')).toMatchObject({ color: 'gray', icon: 'star' });
    expect(Object.keys(after)).toEqual(['lorem', 'ipsum']);
  });
});
