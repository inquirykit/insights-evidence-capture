// Preloaded by `bun test` (bunfig.toml), and imported first by the fixture scripts: the globals
// the extension's code expects, faked. `browser` is WXT's fake (storage, runtime), IndexedDB is
// fake-indexeddb's; WebCrypto (with Ed25519), Blob and fetch are Bun's own.

import 'fake-indexeddb/auto';
import { fakeBrowser } from 'wxt/testing/fake-browser';

// settings.ts reads the built-in key when it loads, as `bun run dev` builds it in (COMMAND
// 'serve'). Bun has loaded .env.local by now; the tests never see the developer's key, but a
// fixed one.
process.env.COMMAND = 'serve';
process.env.WXT_DEFAULT_API_KEY = 'test-default-key';

fakeBrowser.runtime.getManifest = () => ({ manifest_version: 3, name: 'Insights & Evidence Capture', version: '0.1.0-test' });
Object.assign(globalThis, { browser: fakeBrowser });

// No test reaches the network, FreeTSA least of all: a test that needs fetch puts its own in place
// and puts this one back.
globalThis.fetch = (async (input: string | URL | Request) => {
  throw new TypeError(`no network in tests (${input instanceof Request ? input.url : String(input)})`);
}) as unknown as typeof fetch;
