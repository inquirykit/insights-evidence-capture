import { startAutoCapture } from '@/lib/auto-capture';
import { bytesToBase64 } from '@/lib/bytes';
import { capturePage, type CaptureTrigger } from '@/lib/capture';
import { syncDomMonitor } from '@/lib/dom-monitor';
import { ready, retryPendingTimestamps } from '@/lib/local-store';
import { startNetworkRecorder } from '@/lib/network';
import { getAutoCapture, getCaptureOptions, switchStore, type CaptureOptions } from '@/lib/options';
import {
  errorMessage,
  type Annotation,
  type AnnotationChange,
  type BgReply,
  type BgRequest,
  type BgResponses,
  type CaptureOutcome,
  type FetchedResource,
  type Status,
} from '@/lib/protocol';
import { readJson, serverFetch, serviceJson } from '@/lib/service';
import {
  clearConnection,
  getConnection,
  getLastCaseId,
  getStoreMode,
  onLocalChange,
  setConnection,
  setLastCaseId,
  setStoreMode,
  usesDefaultKey,
} from '@/lib/settings';
import { currentStore as store } from '@/lib/store';

// A resource fetched for SingleFile larger than this is refused (it would be base64 in a message).
const MAX_RESOURCE_BYTES = 32 * 1024 * 1024;

const MENU = {
  page: 'capture-page',
  selection: 'capture-selection',
  image: 'capture-image',
} as const;

// Tabs being captured now: auto-capture leaves them alone (a reload before a capture loads the
// page again, which would otherwise look like a new visit).
const busy = new Set<number>();

export default defineBackground(() => {
  // Listeners must be registered synchronously so they survive service-worker restarts.
  startNetworkRecorder();
  installContextMenus();
  startAutoCapture({
    capture: (tabId, options, caseId) =>
      captureWithBadge(tabId, options, undefined, { kind: 'page', source: 'auto' }, caseId),
    isBusy: (tabId) => busy.has(tabId),
    onToggle: () => void restBadge(),
  });
  void restBadge();

  // Watching the DOM from document_start needs the content script registered while it is on.
  void getCaptureOptions().then((o) => syncDomMonitor(o.monitorDom));
  onLocalChange('captureOptions', (options) => void syncDomMonitor(!!options?.monitorDom));

  // Records kept here that have no trusted timestamp yet get another try at each start.
  void getStoreMode().then((mode) => {
    if (mode === 'browser') retryPendingTimestamps().catch(() => {});
  });

  browser.runtime.onMessage.addListener((msg: BgRequest, sender, sendResponse) => {
    if (sender.id !== browser.runtime.id) return false;
    const fromOwnPage = sender.url?.startsWith(browser.runtime.getURL('/')) ?? false;
    // Scripts this extension injected into a captured page may only ask for resource fetches, and
    // only from the top frame of a tab being captured now (where capture.ts runs SingleFile);
    // everything else (captures, settings) is for our own pages: popup and dashboard.
    const fromCapture = sender.frameId === 0 && sender.tab?.id != null && busy.has(sender.tab.id);
    if (msg.type === 'fetchResource' ? !fromCapture : !fromOwnPage) return false;
    handle(msg).then(
      (data) => sendResponse({ ok: true, data } satisfies BgReply<unknown>),
      (e) => sendResponse({ ok: false, error: errorMessage(e) } satisfies BgReply<unknown>),
    );
    return true; // keep the channel open for the async reply
  });

  browser.commands.onCommand.addListener(async (command) => {
    if (command !== 'capture-page') return;
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (tab?.id == null) return;
    await captureWithBadge(tab.id, await getCaptureOptions(), undefined, { kind: 'page', source: 'shortcut' }).catch(
      () => {},
    );
  });

  browser.contextMenus.onClicked.addListener(async (info, tab) => {
    if (tab?.id == null) return;
    const frameId = info.frameId ?? 0;
    const trigger: CaptureTrigger | null =
      info.menuItemId === MENU.page
        ? { kind: 'page', source: 'contextMenu' }
        : info.menuItemId === MENU.selection
          ? { kind: 'text', source: 'contextMenu', frameId }
          : info.menuItemId === MENU.image && info.srcUrl
            ? { kind: 'image', source: 'contextMenu', frameId, srcUrl: info.srcUrl }
            : null;
    if (!trigger) return;
    await captureWithBadge(tab.id, await getCaptureOptions(), undefined, trigger).catch(() => {});
  });
});

/** The right-click entries. Recreated on every start, which is harmless and keeps Chrome's
 *  service worker and Firefox's background page on the same footing. */
function installContextMenus() {
  const documentUrlPatterns = ['http://*/*', 'https://*/*', 'file:///*'];
  browser.contextMenus
    .removeAll()
    .then(() => {
      browser.contextMenus.create({ id: MENU.page, title: 'Capture page as evidence', contexts: ['page'], documentUrlPatterns });
      browser.contextMenus.create({
        id: MENU.selection,
        title: 'Capture selection as evidence',
        contexts: ['selection'],
        documentUrlPatterns,
      });
      browser.contextMenus.create({ id: MENU.image, title: 'Capture image as evidence', contexts: ['image'], documentUrlPatterns });
    })
    .catch((e) => console.error('context menus:', e));
}

// ---------------------------------------------------------------------------
// Messages from the popup and the dashboard, answered by the store in use (lib/store.ts)

async function handle(msg: BgRequest): Promise<BgResponses[BgRequest['type']]> {
  switch (msg.type) {
    case 'status':
      return status();
    case 'setConnection':
      await switchStore(async () => {
        await setConnection(msg.baseUrl, msg.apiKey);
        await setStoreMode('server');
      });
      return status();
    case 'setStore':
      await switchStore(() => setStoreMode(msg.store));
      return status();
    case 'disconnect':
      await switchStore(clearConnection);
      return status();
    case 'listCases':
      return (await store()).listCases();
    case 'createCase': {
      const created = await (await store()).createCase(msg.name);
      await setLastCaseId(created.id);
      return created;
    }
    case 'listCaptures':
      return (await store()).listCaptures(msg.caseId);
    case 'getCapture':
      return (await store()).getCapture(msg.captureId);
    case 'capture':
      await setLastCaseId(msg.caseId);
      return captureAndUpload(msg.tabId, msg.caseId, msg.options, msg.note, undefined, msg.tags);
    case 'captureDetached':
      await setLastCaseId(msg.caseId);
      void captureWithBadge(
        msg.tabId,
        msg.options,
        msg.note,
        { kind: 'page', source: 'popup' },
        msg.caseId,
        msg.tags,
      ).catch(() => {});
      return null;
    case 'listAnnotations':
      return (await store()).listAnnotations(msg.caseId);
    case 'saveAnnotations':
      return saveAnnotations(msg.captureId, { tags: msg.tags, notes: msg.notes });
    case 'listTodos':
      return (await store()).listTodos(msg.caseId);
    case 'saveTodos':
      return (await store()).saveTodos(msg.caseId, msg.todos);
    case 'verify':
      return (await store()).verify();
    case 'fetchResource':
      return fetchResource(msg.url, msg.headers);
  }
}

/** Browser store: online once the database opens and the signing key loads. Server store, a
 *  two-step check: GET /health needs no key and tells reachability; GET /evidence/cases
 *  validates the key and that evidence storage is enabled on the server. */
async function status(): Promise<Status> {
  const mode = await getStoreMode();
  const connection = await getConnection();
  const base = {
    store: mode,
    connection: connection && {
      baseUrl: connection.baseUrl,
      hasKey: connection.apiKey.length > 0,
      defaultKey: await usesDefaultKey(),
    },
    lastCaseId: await getLastCaseId(),
  };
  if (mode === 'browser') {
    try {
      await ready();
      return { ...base, service: 'online', server: { name: 'This browser', version: browser.runtime.getManifest().version } };
    } catch (e) {
      return { ...base, service: 'offline', error: errorMessage(e) };
    }
  }
  if (!connection) return { ...base, service: 'unconfigured' };
  try {
    const health = await readJson<{ name?: string; service?: string; version?: string }>(
      await serverFetch('/health'),
    );
    await serviceJson('/cases');
    return {
      ...base,
      service: 'online',
      server: { name: health.name ?? health.service, version: health.version },
    };
  } catch (e) {
    return { ...base, service: 'offline', error: errorMessage(e) };
  }
}

async function captureAndUpload(
  tabId: number,
  caseId: string,
  options: CaptureOptions,
  note?: string,
  trigger?: CaptureTrigger,
  tags?: string[],
): Promise<CaptureOutcome> {
  if (busy.has(tabId)) throw new Error('This tab is already being captured');
  busy.add(tabId);
  try {
    const bundle = await capturePage(tabId, caseId, options, note, trigger);
    const upload = await (await store()).append(
      caseId,
      bundle.metadata,
      bundle.artifacts.map(({ name, mediaType, bytes }) => ({ name, mediaType, bytes })),
    );

    // Tags are the case's to change later, so they are kept beside the signed record, not in it.
    const warnings = [...bundle.warnings];
    if (tags?.length) {
      await saveAnnotations(upload.captureId, { tags }).catch((e) =>
        warnings.push(`The capture is stored, but its tags were not saved: ${errorMessage(e)}`),
      );
    }

    const { documentUrl = '', title = '' } = bundle.metadata.page ?? {};
    return {
      upload,
      url: documentUrl,
      title,
      artifacts: bundle.artifacts.map(({ name, sha256, size, method }) => ({ name, sha256, size, method })),
      warnings,
    };
  } finally {
    busy.delete(tabId);
  }
}

async function saveAnnotations(captureId: string, change: AnnotationChange): Promise<Annotation> {
  return (await store()).saveAnnotations(captureId, change);
}

/** A capture with no popup to report to (shortcut, context menu, detached pick, auto-capture):
 *  the badge shows ✓ or !, and the details are in the console and the dashboard. Failures are
 *  logged here and thrown on, for callers that count them. */
async function captureWithBadge(
  tabId: number,
  options: CaptureOptions,
  note: string | undefined,
  trigger: CaptureTrigger,
  caseId?: string,
  tags?: string[],
): Promise<CaptureOutcome> {
  try {
    await flashBadge('…', '#656d76', 0);
    const outcome = await captureAndUpload(
      tabId,
      caseId ?? (await getLastCaseId()) ?? 'inbox',
      options,
      note,
      trigger,
      tags,
    );
    if (outcome.warnings.length) console.warn('capture warnings:', outcome.warnings);
    await flashBadge('✓', '#1a7f37');
    return outcome;
  } catch (e) {
    console.error('capture failed:', e);
    await flashBadge('!', '#cf222e');
    throw e;
  }
}

/** Fetches a page resource for SingleFile with the page's cookies, as the page would. Only
 *  used when the page's own fetch was blocked, typically by CORS. A cached copy only once the
 *  server says it is current: the archive is the resource as it is now. */
async function fetchResource(url: string, headers?: Record<string, string>): Promise<FetchedResource> {
  if (!/^(https?|data):/.test(url)) throw new Error(`unsupported URL scheme`);
  const response = await fetch(url, {
    headers,
    credentials: 'include',
    cache: 'no-cache',
    referrerPolicy: 'strict-origin-when-cross-origin',
  });
  const length = Number(response.headers.get('content-length') ?? 0);
  if (length > MAX_RESOURCE_BYTES) throw new Error(`resource larger than ${MAX_RESOURCE_BYTES} bytes`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_RESOURCE_BYTES) throw new Error(`resource larger than ${MAX_RESOURCE_BYTES} bytes`);
  const kept: Record<string, string> = {};
  for (const name of ['content-type', 'content-length', 'last-modified', 'etag', 'date', 'cache-control']) {
    const value = response.headers.get(name);
    if (value) kept[name] = value;
  }
  return { status: response.status, url: response.url, headers: kept, body: bytesToBase64(bytes) };
}

// MV3 (Chrome) has `action`; Firefox builds are MV2 and use `browserAction`.
const action = () => browser.action ?? browser.browserAction;
// Each flash outlives the ones before it: only the latest one's timer puts the badge back.
let flashes = 0;

async function flashBadge(text: string, color: string, clearAfterMs = 4000) {
  const flash = ++flashes;
  await action().setBadgeBackgroundColor({ color });
  await action().setBadgeText({ text });
  if (clearAfterMs) setTimeout(() => flash === flashes && void restBadge(), clearAfterMs);
}

/** The badge between captures: REC while auto-capture is on, nothing otherwise. */
async function restBadge() {
  const { enabled } = await getAutoCapture();
  await action().setBadgeBackgroundColor({ color: '#cf222e' });
  await action().setBadgeText({ text: enabled ? 'REC' : '' });
}
