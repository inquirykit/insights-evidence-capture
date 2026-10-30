// A record made by the browser store (lib/local-store.ts), written as the server lays a capture
// out, for make-server-fixtures.py to check with the server's own code. Run by `bun run fixtures`.
// No timestamp token: tests/setup.ts leaves fetch unable to reach the TSA, so nothing leaves the
// machine.

import '../setup';

import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { sha256Hex } from '../../lib/bytes';
import { append, publicKeyPem, readArtifact, recordBundle } from '../../lib/local-store';
import type { ClientMetadata } from '../../lib/protocol';

const OUT = join(import.meta.dir, 'browser-record');

const dom = new TextEncoder().encode(
  '<!DOCTYPE html>\n<html><head><title>Lorem ipsum</title></head><body><p>Dolor sit amet \u{1F600}</p></body></html>',
);
const metadata = {
  schema: 'evidence-capture/client/v1',
  caseId: 'inbox',
  note: 'Lorem ipsum café',
  trigger: 'popup',
  options: { depth: 'basic', screenshot: 'none', mhtml: false, singlefile: false, pdf: false, markdown: false, autoScroll: 0, reload: false, monitorDom: false },
  startedAt: '2026-10-25T12:00:00.000Z',
  finishedAt: '2026-10-25T12:00:00.250Z',
  page: {
    tabUrl: 'https://example.com/page',
    documentUrl: 'https://example.com/page',
    title: 'Lorem ipsum',
    viewport: { width: 1280, height: 800 },
    scrollPosition: { x: 0, y: 0 },
    scrollSize: { width: 1280, height: 2400 },
    devicePixelRatio: 1.25,
  },
  network: { mainFrame: null },
  warnings: [],
  artifacts: [
    {
      name: 'dom.html',
      sha256: await sha256Hex(dom),
      size: dom.byteLength,
      mediaType: 'text/html;charset=utf-8',
      capturedAt: '2026-10-25T12:00:00.200Z',
      method: 'scripting.executeScript:document.documentElement.outerHTML',
    },
  ],
} satisfies ClientMetadata;

const upload = await append('inbox', metadata, [{ name: 'dom.html', mediaType: 'text/html;charset=utf-8', bytes: dom }]);

await rm(OUT, { recursive: true, force: true });
await mkdir(join(OUT, 'artifacts'), { recursive: true });
for (const file of await recordBundle(upload.captureId)) {
  await writeFile(join(OUT, file.name), new Uint8Array(await file.blob.arrayBuffer()));
}
await writeFile(join(OUT, 'ed25519.pub.pem'), await publicKeyPem());
await writeFile(join(OUT, 'artifacts', 'dom.html'), new Uint8Array(await (await readArtifact(upload.captureId, 'dom.html')).arrayBuffer()));
console.log(`browser record written: seq ${upload.seq}, ${upload.recordHash}`);
