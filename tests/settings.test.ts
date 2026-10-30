// lib/settings.ts on WXT's fake browser storage: the connection, the store choice and the typed
// storage helpers every module keeps its values with.

import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { fakeBrowser } from 'wxt/testing/fake-browser';

import * as options from '../lib/options';
import * as settings from '../lib/settings';

beforeEach(() => fakeBrowser.reset());

describe('the server connection', () => {
  test('server URLs are made into an origin and a path', () => {
    expect(settings.normalizeBaseUrl('localhost:8000')).toBe('http://localhost:8000');
    expect(settings.normalizeBaseUrl(' https://host.example/api/ ')).toBe('https://host.example/api');
    expect(settings.normalizeBaseUrl('')).toBe(settings.DEFAULT_BASE_URL);
    expect(() => settings.normalizeBaseUrl('http://host?x=1')).toThrow('must not contain a query');
    expect(() => settings.normalizeBaseUrl('http://')).toThrow('Invalid server URL');
  });

  test("the build's key on the default URL until one is saved", async () => {
    // tests/setup.ts sets WXT_DEFAULT_API_KEY, as .env.local does in development
    expect(await settings.getConnection()).toEqual({ baseUrl: settings.DEFAULT_BASE_URL, apiKey: 'test-default-key', savedAt: '' });
    expect(await settings.usesDefaultKey()).toBe(true);
  });

  test('a saved key is used; an empty one falls back to the built-in key; undefined keeps it', async () => {
    await settings.setConnection('host.example:9000', ' secret ');
    expect(await settings.getConnection()).toMatchObject({ baseUrl: 'http://host.example:9000', apiKey: 'secret' });
    expect(await settings.usesDefaultKey()).toBe(false);

    await settings.setConnection('host.example:9001');
    expect(await settings.getConnection()).toMatchObject({ baseUrl: 'http://host.example:9001', apiKey: 'secret' });

    await settings.setConnection('host.example:9001', '');
    expect(await settings.getConnection()).toMatchObject({ baseUrl: 'http://host.example:9001', apiKey: 'test-default-key' });

    await settings.clearConnection();
    expect((await settings.getConnection())?.baseUrl).toBe(settings.DEFAULT_BASE_URL);
  });
});

describe('the user settings', () => {
  test('the server store until the browser is chosen', async () => {
    expect(await settings.getStoreMode()).toBe('server');
    await settings.setStoreMode('browser');
    expect(await settings.getStoreMode()).toBe('browser');
    await settings.writeLocal('store', 'nonsense' as 'server');
    expect(await settings.getStoreMode()).toBe('server');
  });

  test('last case and watch terms', async () => {
    expect(await settings.getLastCaseId()).toBeNull();
    expect(await settings.getWatchTerms()).toEqual([]);
    await settings.setLastCaseId('case-1');
    await settings.setWatchTerms(['lorem', 'ipsum']);
    expect(await settings.getLastCaseId()).toBe('case-1');
    expect(await settings.getWatchTerms()).toEqual(['lorem', 'ipsum']);
  });

  test('a session value per tab, under its own key', async () => {
    const key = settings.mainFrameKey(7);
    expect(key).toBe('net:7');
    await settings.writeSession(key, { requestId: '1', url: 'https://example.com/', redirects: [] });
    expect((await settings.readSession(key))?.url).toBe('https://example.com/');
    await settings.removeSession(key);
    expect(await settings.readSession(key)).toBeUndefined();
    expect(await settings.readLocal('lastCaseId')).toBeUndefined(); // the areas are apart
  });
});

describe('switching stores', () => {
  test('cases chosen in one store go back to the Inbox when captures go to another', async () => {
    await settings.setLastCaseId('server-case');
    await options.setAutoCapture({ ...(await options.getAutoCapture()), enabled: true, caseId: 'server-case' });

    await options.switchStore(() => settings.setStoreMode('server')); // where it was
    expect(await settings.getLastCaseId()).toBe('server-case');
    expect((await options.getAutoCapture()).caseId).toBe('server-case');

    await options.switchStore(() => settings.setStoreMode('browser'));
    expect(await settings.getLastCaseId()).toBeNull();
    expect(await options.getAutoCapture()).toMatchObject({ enabled: true, caseId: 'inbox' });
  });

  test('another server is another store; a new key for the same one is not', async () => {
    const connect = (url: string, key: string) => async () => void (await settings.setConnection(url, key));
    await settings.setConnection('host.example:9000', 'key-1');
    await settings.setLastCaseId('case-1');

    await options.switchStore(connect('host.example:9000', 'key-2'));
    expect(await settings.getLastCaseId()).toBe('case-1');

    await options.switchStore(connect('other.example:9000', 'key-2'));
    expect(await settings.getLastCaseId()).toBeNull();

    await settings.setLastCaseId('case-2');
    await options.switchStore(settings.clearConnection); // back to the built-in server
    expect(await settings.getLastCaseId()).toBeNull();
    expect(await settings.readLocal('autoCapture')).toBeUndefined(); // never set, still unset
  });
});

describe('change listeners', () => {
  test('hear their key, in their area, with the old value, until stopped', async () => {
    const heard = mock();
    const stop = settings.onLocalChange('watchTerms', heard);
    await settings.setWatchTerms(['a']);
    await settings.setWatchTerms(['a', 'b']);
    await settings.setLastCaseId('other key');
    await settings.writeSession('autoCaptureSeen', {}); // other area
    stop();
    await settings.setWatchTerms([]);
    expect(heard.mock.calls).toEqual([
      [['a'], undefined],
      [['a', 'b'], ['a']],
    ]);
  });

  test('session changes are heard apart', async () => {
    const heard = mock();
    const stop = settings.onSessionChange('autoCaptureStats', heard);
    const stats = { since: '2026-10-25T00:00:00Z', captured: 1, unchanged: 0, failed: 0 };
    await settings.writeSession('autoCaptureStats', stats);
    stop();
    expect(heard).toHaveBeenCalledWith(stats, undefined);
  });
});
