// lib/store.ts: the store in use follows the setting, and readArtifact reaches the right one,
// IndexedDB for the browser store and the evidence API (with the key) for the server.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { fakeBrowser } from 'wxt/testing/fake-browser';

import { sha256Hex, utf8 } from '../lib/bytes';
import { browserStore, retryPendingTimestamps } from '../lib/local-store';
import { serverStore } from '../lib/server-store';
import { setConnection, setStoreMode } from '../lib/settings';
import { currentStore, readArtifact } from '../lib/store';

const realFetch = globalThis.fetch;
let requests: Request[] = [];

beforeEach(() => {
  fakeBrowser.reset();
  requests = [];
});

afterEach(async () => {
  await retryPendingTimestamps(); // the background retry an append starts, before fetch goes back
  globalThis.fetch = realFetch;
});

/** A server that answers with `respond`, keeping each request. */
function server(respond: (request: Request) => Response) {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push(request);
    return respond(request);
  }) as typeof fetch;
}

test('the server store until the browser store is chosen', async () => {
  expect(await currentStore()).toBe(serverStore);
  await setStoreMode('browser');
  expect(await currentStore()).toBe(browserStore);
});

test('append to the server: the metadata and one part per file, POSTed to the evidence API', async () => {
  await setConnection('host.example:9000', 'secret');
  server(() => Response.json({ captureId: 'c1', seq: 1, receivedAt: '2026-10-25T00:00:00Z', recordHash: 'ab', signature: 'cd', timestamp: { status: 'disabled' } }));
  const bytes = utf8('<p>lorem</p>');
  const metadata = { caseId: 'case-1', artifacts: [{ name: 'dom.html', sha256: await sha256Hex(bytes), size: bytes.byteLength, method: 'test' }] };
  const upload = await serverStore.append('case-1', metadata, [{ name: 'dom.html', mediaType: 'text/html', bytes }]);
  expect(upload.captureId).toBe('c1');
  const [request] = requests;
  expect(`${request!.method} ${request!.url}`).toBe('POST http://host.example:9000/evidence/captures');
  expect(request!.headers.get('authorization')).toBe('Bearer secret');
  const form = await request!.formData();
  expect(JSON.parse(String(form.get('metadata')))).toEqual(metadata);
  const files = form.getAll('file') as File[];
  expect(files.map((f) => f.name)).toEqual(['dom.html']);
  expect(files[0]!.type).toStartWith('text/html'); // Bun's Blob adds a charset
  expect(await files[0]!.text()).toBe('<p>lorem</p>');
});

describe('readArtifact', () => {
  test('from the server: the evidence API, with the key, names escaped', async () => {
    await setConnection('host.example:9000', 'secret');
    server(() => new Response('<p>lorem</p>', { headers: { 'content-type': 'text/html' } }));
    const blob = await readArtifact('a/b', 'dom.html');
    expect(await blob.text()).toBe('<p>lorem</p>');
    expect(requests[0]!.url).toBe('http://host.example:9000/evidence/captures/a%2Fb/artifacts/dom.html');
    expect(requests[0]!.headers.get('authorization')).toBe('Bearer secret');
  });

  test("from the server: its error, when it refuses", async () => {
    server(() => Response.json({ error: 'unknown artifact' }, { status: 404 }));
    await expect(readArtifact('x', 'dom.html')).rejects.toThrow('unknown artifact');
    server(() => Response.json({ detail: 'bad key' }, { status: 401 }));
    await expect(readArtifact('x', 'dom.html')).rejects.toThrow('bad key (HTTP 401). Check the API key.');
  });

  test('from this browser: IndexedDB, no request made', async () => {
    await setStoreMode('browser');
    server(() => {
      throw new TypeError('offline'); // the TSA too: the capture is kept without a token
    });
    const bytes = utf8('<p>kept here</p>');
    const metadata = {
      caseId: 'inbox',
      artifacts: [{ name: 'dom.html', sha256: await sha256Hex(bytes), size: bytes.byteLength, method: 'test' }],
    };
    const upload = await (await currentStore()).append('inbox', metadata, [{ name: 'dom.html', mediaType: 'text/html', bytes }]);
    const tsaCalls = requests.length;
    expect(await (await readArtifact(upload.captureId, 'dom.html')).text()).toBe('<p>kept here</p>');
    expect(requests.length).toBe(tsaCalls);
  });
});
