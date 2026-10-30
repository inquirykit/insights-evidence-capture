// On-demand page capture. Every artifact is hashed (SHA-256) in the browser the moment
// it's produced, before it leaves the extension; the service rejects any upload whose
// bytes don't match, then signs, chains and timestamps the record.
//
// Screenshot (screenshot.png), by the chosen scope:
//   none     no screenshot (the Basic depth: text and DOM only)
//   full     Chrome: CDP Page.captureScreenshot beyond the viewport; Firefox: tabs.captureTab({ rect })
//   visible  both: tabs.captureVisibleTab (no DevTools protocol, so no debugger bar on Chrome)
//   region   the user drags a rectangle on the page, then as `full` clipped to it
//   element  the user clicks an element, then as `region` with the element's box; element.html
//   The context menu adds two more: a text selection (selection.txt/.html, screenshot clipped
//   to it) and an image (the image file itself plus the visible viewport).
// Archives, each optional: MHTML (Chrome, CDP), SingleFile HTML (both, page.html), PDF
// (Chrome, CDP Page.printToPDF), Markdown (both, page.md). Always: dom.html, the live DOM.
//
// Before a page capture, each optional and in this order: reload the page and wait for it to
// load again; start watching its DOM (lib/page/dom-monitor.ts; dom-changes.json and a summary in
// the record); scroll through it so lazy content loads (lib/page/scroll.ts). The record says
// which ran.
//
// What runs inside the page is in lib/page/; this module runs in the background and injects it.

import type { Browser } from 'wxt/browser';

import { base64ToBytes, bytesToBase64, sha256Hex } from './bytes';
import { MONITOR_KEY } from './dom-monitor';
import { firefox } from './firefox';
import { getMainFrameResponse } from './network';
import { depthOf, type CaptureOptions, type ScreenshotScope } from './options';
import { markDomMonitor, readDomMonitor, type DomMonitorRead } from './page/dom-monitor';
import { collectPageInfo, type PageInfo } from './page/page-info';
import { pickOnPage, readSelection, type PickResult, type SelectionInfo } from './page/picker';
import { scrollThroughPage, type ScrollResult } from './page/scroll';
import {
  errorMessage,
  type ArtifactSummary,
  type ClientMetadata,
  type PageRect,
  type ReloadMetadata,
  type SelectionMetadata,
  type Uncompressed,
} from './protocol';

export interface Artifact extends ArtifactSummary {
  mediaType: string;
  capturedAt: string;
  bytes: Uint8Array<ArrayBuffer>;
  uncompressed?: Uncompressed;
}

export interface CaptureBundle {
  /** Signed with the record as it is */
  metadata: ClientMetadata;
  artifacts: Artifact[];
  warnings: string[];
}

/** What started the capture and, from the context menu, what it points at. */
export type CaptureTrigger =
  | { kind: 'page'; source: 'popup' | 'shortcut' | 'contextMenu' | 'auto' }
  | { kind: 'text'; source: 'contextMenu'; frameId: number }
  | { kind: 'image'; source: 'contextMenu'; frameId: number; srcUrl: string };

type Pending = Omit<Artifact, 'sha256' | 'size'>;

// Very tall pages exceed GPU / canvas limits and come back blank or fail.
const MAX_CAPTURE_HEIGHT = 16384;
// Screenshots are scaled down to at most this many device px per side: the most WebP holds.
// Past it Chrome's DevTools protocol returns an empty WebP and canvases crop one silently.
const MAX_SCREENSHOT_SIDE = 16383;
// Space around a text selection in its screenshot, in CSS px.
const SELECTION_PADDING = 12;
// An image picked from the context menu larger than this is not fetched.
const MAX_IMAGE_BYTES = 64 * 1024 * 1024;
// A reloaded page that has not finished loading by then is captured as it is, with a warning.
const RELOAD_TIMEOUT_MS = 30_000;
// After the reload's load event, for scripts to render what they fetch.
const RELOAD_SETTLE_MS = 1000;

const nowIso = () => new Date().toISOString();

export async function capturePage(
  tabId: number,
  caseId: string,
  options: CaptureOptions,
  note?: string,
  trigger: CaptureTrigger = { kind: 'page', source: 'popup' },
): Promise<CaptureBundle> {
  const startedAt = nowIso();
  const tab = await browser.tabs.get(tabId);
  if (!tab.url || !/^(https?|file):/.test(tab.url)) {
    throw new Error(`This page can't be captured (${tab.url ?? 'unknown URL'})`);
  }

  const warnings: string[] = [];
  const pending: Pending[] = [];

  // Reloading and scrolling are for the page as a whole; a selection or an image is captured
  // as it is, where it is.
  const whole = trigger.kind === 'page';
  const reload = whole && options.reload ? await reloadTab(tabId, warnings) : undefined;
  const watching = options.monitorDom && (await startWatching(tabId, warnings));
  const autoScroll = whole ? options.autoScroll : 0;
  const scroll = autoScroll > 0 ? await scrollPage(tabId, autoScroll, warnings) : undefined;

  let info = await readPage(tabId, false);

  // What part of the page the screenshot shows, and what the user pointed at.
  let scope: ScreenshotScope = options.screenshot;
  let clip: PageRect | undefined;
  let selection: SelectionMetadata | undefined;

  if (trigger.kind === 'text') {
    const sel = await readSelectionIn(tabId, trigger.frameId);
    if (!sel) throw new Error('No text is selected on the page');
    // A frame's coordinates are relative to the frame, not the page: no clip for those.
    const rect = trigger.frameId === 0 ? sel.rect : undefined;
    selection = { kind: 'text', text: sel.text, xpath: sel.xpath, rect, frameId: trigger.frameId };
    pending.push(
      textArtifact('selection.txt', 'text/plain;charset=utf-8', sel.text, 'window.getSelection().toString()'),
      textArtifact('selection.html', 'text/html;charset=utf-8', sel.html, 'Range.cloneContents()'),
    );
    if (rect) {
      clip = padRect(rect, SELECTION_PADDING, info);
      scope = 'region';
    } else {
      if (trigger.frameId !== 0) warnings.push('The selection is inside a frame; screenshot shows the visible viewport');
      scope = 'visible';
    }
  } else if (trigger.kind === 'image') {
    const image = await fetchImage(trigger.srcUrl, warnings);
    if (image) pending.push(image);
    selection = { kind: 'image', srcUrl: trigger.srcUrl, frameId: trigger.frameId };
    scope = 'visible';
  } else if (scope === 'region' || scope === 'element') {
    const pick = await pickIn(tabId, scope);
    if (!pick) throw new Error('Selection cancelled');
    // The user may have scrolled or resized the window while picking: what follows (the crop
    // of a viewport screenshot above all) needs the page as it is now, not as it was before.
    const now = await readPage(tabId, false);
    if (now.documentUrl !== info.documentUrl) throw navigated(info.documentUrl, now.documentUrl);
    info = now;
    clip = clampRect(pick.rect, info);
    if (pick.element) {
      const { outerHTML, ...element } = pick.element;
      selection = { kind: 'element', rect: clip, ...element };
      pending.push(textArtifact('element.html', 'text/html;charset=utf-8', outerHTML, 'Element.outerHTML'));
    } else {
      selection = { kind: 'region', rect: clip };
    }
  }

  // From here on the page is being captured: its changes count as during the capture.
  if (watching) await markWatching(tabId);

  // Visual evidence first: closest to what the user is looking at right now.
  if (import.meta.env.FIREFOX) {
    if (scope !== 'none') pending.push(await firefoxScreenshot(tab, info, scope, clip, warnings));
  } else {
    pending.push(...(await chromeCapture(tab, info, { scope, clip, mhtml: options.mhtml, pdf: options.pdf }, warnings)));
  }

  const { html, documentUrl } = await readPage(tabId, true);
  // One document or no capture: had the page navigated in between, the screenshot of one page
  // would be signed with the DOM of another.
  if (documentUrl !== info.documentUrl) throw navigated(info.documentUrl, documentUrl);
  pending.push({
    name: 'dom.html',
    mediaType: 'text/html;charset=utf-8',
    capturedAt: nowIso(),
    method: 'scripting.executeScript:document.documentElement.outerHTML',
    bytes: new TextEncoder().encode(html ?? ''),
  });
  // Read right after the DOM: what the archives below do to the page is not the page's.
  const watched = watching ? await readWatching(tabId, warnings) : null;
  if (watched) {
    pending.push(
      textArtifact(
        'dom-changes.json',
        'application/json',
        JSON.stringify({ schema: 'evidence-capture/dom-changes/v1', ...watched }, null, 1),
        'scripting.executeScript:dom-monitor(MutationObserver, isolated world)',
      ),
    );
  }
  if (options.markdown) {
    const markdown = await pageMarkdown(tabId, warnings);
    if (markdown) pending.push(markdown);
  }
  // Last: SingleFile marks elements while it works (and unmarks them after).
  if (options.singlefile) {
    const single = await pageSingleFile(tabId, warnings);
    if (single) pending.push(single);
  }

  const artifacts = await Promise.all(
    pending.map(async (a) => ({ ...a, sha256: await sha256Hex(a.bytes), size: a.bytes.byteLength })),
  );

  // The tab's last document response is this page's only if it is for the URL this document loaded
  // from. A page back from the back/forward cache made no request, and a download or a 204 left
  // the page as it was: the last response seen is then another page's, and is left out.
  const seen = await getMainFrameResponse(tabId);
  const mainFrame = seen && sameDocument(seen.url, info.loadedUrl) ? seen : null;
  if (!seen)
    warnings.push('No document response was observed for this tab (loaded before the extension started?)');
  else if (!mainFrame)
    warnings.push(`The last document response seen in this tab is for ${seen.url}, not this page, so it is left out (back/forward cache, or a download?)`);
  else if (!sameDocument(seen.url, info.documentUrl))
    warnings.push('The page changed its URL after it loaded (history.pushState?); the document response is for the URL it loaded from');
  if (!import.meta.env.FIREFOX)
    warnings.push('TLS certificate details are not available to Chrome extensions');

  const metadata = {
    schema: 'evidence-capture/client/v1',
    caseId,
    note: note?.trim() || undefined,
    trigger: trigger.source,
    // What the user chose to save, so a missing file reads as a choice rather than a failure
    options: {
      depth: depthOf(options) ?? 'custom',
      screenshot: scope,
      mhtml: options.mhtml && !import.meta.env.FIREFOX,
      singlefile: options.singlefile,
      pdf: options.pdf && !import.meta.env.FIREFOX,
      markdown: options.markdown,
      autoScroll,
      reload: !!reload,
      monitorDom: options.monitorDom,
    },
    selection,
    reload,
    scroll,
    domMonitor: watched?.report,
    startedAt,
    finishedAt: nowIso(),
    page: {
      tabUrl: tab.url,
      documentUrl: info.documentUrl,
      title: info.title,
      characterSet: info.characterSet,
      contentType: info.contentType,
      lastModified: info.lastModified,
      referrer: info.referrer,
      viewport: info.viewport,
      scrollPosition: info.scrollPosition,
      scrollSize: { width: info.scrollWidth, height: info.scrollHeight },
      devicePixelRatio: info.devicePixelRatio,
    },
    network: { mainFrame },
    environment: await environment(),
    warnings,
    artifacts: artifacts.map(({ name, sha256, size, mediaType, capturedAt, method, uncompressed }) => ({
      name,
      sha256,
      size,
      mediaType,
      capturedAt,
      method,
      uncompressed,
    })),
  } satisfies ClientMetadata;

  return { metadata: wellFormed(metadata), artifacts, warnings };
}

/** The same value with every string well-formed UTF-16: a lone surrogate (an emoji cut in half
 *  by a limit, or one a page put in its title) becomes U+FFFD. RFC 8785 has no encoding for one;
 *  the server's canonicalizer refuses it, and so does canonical.ts. */
function wellFormed<T>(value: T): T {
  if (typeof value === 'string') return value.toWellFormed() as T;
  if (Array.isArray(value)) return value.map(wellFormed) as T;
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k.toWellFormed(), wellFormed(v)])) as T;
  return value;
}

// ---------------------------------------------------------------------------
// Before the capture: reload, watch, scroll

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Reloads the tab and waits for it to load again: whatever was changed in the page since it
 *  loaded (DevTools edits, text typed into it, other extensions) is gone from the capture. */
async function reloadTab(tabId: number, warnings: string[]): Promise<ReloadMetadata> {
  const requestedAt = nowIso();
  const loaded = new Promise<string | null>((resolve) => {
    // A load already under way finishes first; only the reload's own "complete" counts.
    let reloading = false;
    const listener = (id: number, change: Browser.tabs.OnUpdatedInfo) => {
      if (id !== tabId) return;
      if (change.status === 'loading') reloading = true;
      else if (change.status === 'complete' && reloading) done(nowIso());
    };
    const timer = setTimeout(() => done(null), RELOAD_TIMEOUT_MS);
    function done(at: string | null) {
      clearTimeout(timer);
      browser.tabs.onUpdated.removeListener(listener);
      resolve(at);
    }
    browser.tabs.onUpdated.addListener(listener);
  });
  await browser.tabs.reload(tabId);
  const loadedAt = await keepAlive(loaded);
  if (!loadedAt)
    warnings.push(`The page had not finished loading ${RELOAD_TIMEOUT_MS / 1000} s after the reload; captured as it was`);
  await sleep(RELOAD_SETTLE_MS);
  return { requestedAt, loadedAt };
}

/** The page's DOM watcher: there already when the page loaded with the option on, else
 *  started now. False when it can't run here. */
async function startWatching(tabId: number, warnings: string[]): Promise<boolean> {
  try {
    await browser.scripting.executeScript({ target: { tabId }, files: ['/dom-monitor.js'] });
    return true;
  } catch (e) {
    warnings.push(`DOM changes were not watched: ${errorMessage(e)}`);
    return false;
  }
}

async function markWatching(tabId: number) {
  await browser.scripting
    .executeScript({ target: { tabId }, func: markDomMonitor, args: [MONITOR_KEY] })
    .catch(() => {});
}

/** The watcher's report and change log, with warnings for what a reviewer should know. */
async function readWatching(tabId: number, warnings: string[]): Promise<DomMonitorRead | null> {
  try {
    const [result] = await browser.scripting.executeScript({
      target: { tabId },
      func: readDomMonitor,
      args: [MONITOR_KEY],
    });
    const watched = (result?.result as DomMonitorRead | null | undefined) ?? null;
    if (!watched) throw new Error('the watcher was gone (did the page navigate?)');
    const { report } = watched;
    if (report.duringCapture.records > 0)
      warnings.push(
        `The page changed while it was captured: ${report.duringCapture.records} DOM changes ` +
          'between the screenshot and dom.html (see dom-changes.json)',
      );
    if (report.designMode)
      warnings.push('The page was in design mode (document.designMode = "on"): all of its text could be edited in place');
    if (report.userEdits > 0)
      warnings.push(
        `Text was typed, pasted or dropped into editable content on the page ${report.userEdits} ` +
          `time${report.userEdits === 1 ? '' : 's'} while it was watched`,
      );
    return watched;
  } catch (e) {
    warnings.push(`DOM changes could not be read: ${errorMessage(e)}`);
    return null;
  }
}

async function scrollPage(tabId: number, seconds: number, warnings: string[]): Promise<ScrollResult | undefined> {
  try {
    const [result] = await keepAlive(
      browser.scripting.executeScript({ target: { tabId }, func: scrollThroughPage, args: [seconds * 1000] }),
    );
    const scroll = result?.result as ScrollResult | undefined;
    if (!scroll) throw new Error('the page returned nothing');
    if (!scroll.reachedEnd)
      warnings.push(`Auto-scroll stopped at its ${seconds} s limit before the end of the page`);
    return scroll;
  } catch (e) {
    warnings.push(`The page could not be scrolled: ${errorMessage(e)}`);
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Picking on the page

async function pickIn(tabId: number, mode: 'region' | 'element'): Promise<PickResult | null> {
  // The page must be in front for the user to see the overlay.
  await browser.tabs.update(tabId, { active: true });
  const [result] = await keepAlive(
    browser.scripting.executeScript({ target: { tabId }, func: pickOnPage, args: [mode] }),
  );
  return (result?.result as PickResult | null | undefined) ?? null;
}

async function readSelectionIn(tabId: number, frameId: number): Promise<SelectionInfo | null> {
  const [result] = await browser.scripting.executeScript({
    target: { tabId, frameIds: [frameId] },
    func: readSelection,
  });
  return (result?.result as SelectionInfo | null | undefined) ?? null;
}

/** Chrome stops an idle service worker after about 30 s; a user taking their time on the
 *  page must not end the capture. Extension API calls reset that clock. */
async function keepAlive<T>(work: Promise<T>): Promise<T> {
  const timer = setInterval(() => void browser.runtime.getPlatformInfo(), 20_000);
  try {
    return await work;
  } finally {
    clearInterval(timer);
  }
}

function clampRect(rect: PageRect, info: PageInfo): PageRect {
  const x = Math.max(0, Math.min(rect.x, info.scrollWidth - 1));
  const y = Math.max(0, Math.min(rect.y, info.scrollHeight - 1));
  return {
    x,
    y,
    width: Math.max(1, Math.min(rect.width, info.scrollWidth - x)),
    height: Math.max(1, Math.min(rect.height, info.scrollHeight - y, MAX_CAPTURE_HEIGHT)),
  };
}

function padRect(rect: PageRect, pad: number, info: PageInfo): PageRect {
  return clampRect(
    { x: rect.x - pad, y: rect.y - pad, width: rect.width + 2 * pad, height: rect.height + 2 * pad },
    info,
  );
}

const describeClip = (clip: PageRect) => `${clip.x},${clip.y} ${clip.width}×${clip.height}`;

// ---------------------------------------------------------------------------
// Chrome: DevTools protocol

interface ChromeWants {
  scope: ScreenshotScope;
  clip?: PageRect;
  mhtml: boolean;
  pdf: boolean;
}

async function chromeCapture(
  tab: Browser.tabs.Tab,
  info: PageInfo,
  wants: ChromeWants,
  warnings: string[],
): Promise<Pending[]> {
  // The viewport alone needs no DevTools protocol, and so shows no debugger bar.
  const shot = wants.scope !== 'none';
  const viewportOnly = async () => (shot ? [await visibleViewportScreenshot(tab, info, wants.clip, warnings)] : []);
  const needsCdp = (shot && wants.scope !== 'visible') || wants.mhtml || wants.pdf;
  if (!needsCdp) return viewportOnly();

  const target = { tabId: tab.id! };
  try {
    await browser.debugger.attach(target, '1.3');
  } catch (e) {
    warnings.push(
      `DevTools protocol unavailable (${errorMessage(e)}); ` +
        `${shot ? 'captured the visible viewport only, ' : ''}no MHTML or PDF`,
    );
    return viewportOnly();
  }

  const send = async <T>(method: string, params?: Record<string, unknown>): Promise<T> =>
    (await browser.debugger.sendCommand(target, method, params)) as T;
  try {
    const out: Pending[] = [];
    if (wants.scope === 'visible') {
      out.push(await visibleViewportScreenshot(tab, info, undefined, warnings));
    } else if (shot) {
      let clip = wants.clip;
      if (!clip) {
        const { cssContentSize } = await send<{ cssContentSize: { width: number; height: number } }>(
          'Page.getLayoutMetrics',
        );
        clip = { x: 0, y: 0, width: Math.ceil(cssContentSize.width), height: Math.ceil(cssContentSize.height) };
        if (clip.height > MAX_CAPTURE_HEIGHT) {
          warnings.push(
            `Page is ${clip.height}px tall; screenshot truncated to ${MAX_CAPTURE_HEIGHT}px (MHTML is complete)`,
          );
          clip.height = MAX_CAPTURE_HEIGHT;
        }
      }
      // The clip scale multiplies devicePixelRatio: 1 is full resolution.
      const scale = shrinkToFit(clip.width, clip.height, info.devicePixelRatio, warnings);
      const shot = await send<{ data: string }>('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: true,
        clip: { ...clip, scale },
      });
      const what = wants.scope === 'full' ? 'full page' : `${wants.scope} ${describeClip(clip)}`;
      out.push(
        screenshotArtifact(
          `cdp:Page.captureScreenshot(captureBeyondViewport, clip=${what}, scale=${scale})`,
          base64ToBytes(shot.data),
        ),
      );
    }

    if (wants.mhtml) {
      const snapshot = await send<{ data: string }>('Page.captureSnapshot', { format: 'mhtml' });
      out.push(
        // Its images are base64 text and its CSS compresses well: gzip saves 30-50%.
        await gzipped({
          name: 'page.mhtml',
          mediaType: 'multipart/related',
          capturedAt: nowIso(),
          method: 'cdp:Page.captureSnapshot(mhtml)',
          bytes: new TextEncoder().encode(snapshot.data),
        }),
      );
    }

    if (wants.pdf) {
      try {
        const pdf = await send<{ data: string }>('Page.printToPDF', {
          printBackground: true,
          preferCSSPageSize: true,
        });
        const bytes = base64ToBytes(pdf.data);
        if (bytes.byteLength === 0) throw new Error('the browser returned an empty PDF');
        out.push({
          name: 'page.pdf',
          mediaType: 'application/pdf',
          capturedAt: nowIso(),
          method: 'cdp:Page.printToPDF(printBackground, preferCSSPageSize)',
          bytes,
        });
      } catch (e) {
        warnings.push(`No PDF of the page: ${errorMessage(e)}`);
      }
    }
    return out;
  } finally {
    await browser.debugger.detach(target).catch(() => {});
  }
}

/** The viewport as shown. With a clip, the part of it inside the viewport, cropped here. */
async function visibleViewportScreenshot(
  tab: Browser.tabs.Tab,
  info: PageInfo,
  clip: PageRect | undefined,
  warnings: string[],
): Promise<Pending> {
  // captureVisibleTab shows whatever tab is in front of the window: never sign another page's
  // viewport as this one's, should the user switch tabs (auto-capture runs while they browse).
  // The window is read now, not at the start of the capture: a tab dragged into a window of its
  // own since then is active there, while the old window's front tab is someone else's page.
  const before = await browser.tabs.get(tab.id!);
  if (!before.active) throw new Error('The tab is not in front of its window, so its viewport cannot be captured');
  const dataUrl = await browser.tabs.captureVisibleTab(before.windowId, { format: 'png' });
  const after = await browser.tabs.get(tab.id!);
  if (!after.active || after.windowId !== before.windowId)
    throw new Error('The tab left the front of its window during the screenshot');
  const bytes = await dataUrlToBytes(dataUrl);
  if (!clip) return screenshotArtifact('tabs.captureVisibleTab', bytes);

  const viewport = {
    x: info.scrollPosition.x,
    y: info.scrollPosition.y,
    width: info.viewport.width,
    height: info.viewport.height,
  };
  const x1 = Math.max(clip.x, viewport.x);
  const y1 = Math.max(clip.y, viewport.y);
  const x2 = Math.min(clip.x + clip.width, viewport.x + viewport.width);
  const y2 = Math.min(clip.y + clip.height, viewport.y + viewport.height);
  if (x2 - x1 < 1 || y2 - y1 < 1) {
    warnings.push('The selection is outside the visible viewport; screenshot shows the viewport instead');
    return screenshotArtifact('tabs.captureVisibleTab', bytes);
  }
  if (x1 !== clip.x || y1 !== clip.y || x2 !== clip.x + clip.width || y2 !== clip.y + clip.height)
    warnings.push('The selection extends past the visible viewport; screenshot shows the visible part');

  const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
  // Device px per CSS px, as the browser really rendered them.
  const ratio = bitmap.width / viewport.width;
  const sx = Math.round((x1 - viewport.x) * ratio);
  const sy = Math.round((y1 - viewport.y) * ratio);
  const sw = Math.max(1, Math.round((x2 - x1) * ratio));
  const sh = Math.max(1, Math.round((y2 - y1) * ratio));
  const canvas = new OffscreenCanvas(sw, sh);
  canvas.getContext('2d')!.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
  bitmap.close();
  const cropped = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
  return screenshotArtifact(
    `tabs.captureVisibleTab + crop(${describeClip({ x: x1, y: y1, width: x2 - x1, height: y2 - y1 })})`,
    cropped,
  );
}

// ---------------------------------------------------------------------------
// Firefox: captureTab with a page-relative rect renders any part of the document

async function firefoxScreenshot(
  tab: Browser.tabs.Tab,
  info: PageInfo,
  scope: ScreenshotScope,
  clip: PageRect | undefined,
  warnings: string[],
): Promise<Pending> {
  if (scope === 'visible') return visibleViewportScreenshot(tab, info, undefined, warnings);

  let rect = clip;
  if (!rect) {
    rect = { x: 0, y: 0, width: Math.max(1, info.scrollWidth), height: Math.max(1, info.scrollHeight) };
    if (rect.height > MAX_CAPTURE_HEIGHT) {
      warnings.push(`Page is ${rect.height}px tall; screenshot truncated to ${MAX_CAPTURE_HEIGHT}px`);
      rect.height = MAX_CAPTURE_HEIGHT;
    }
  }
  // Firefox canvases also hold at most roughly 124M pixels in total.
  const dpr = info.devicePixelRatio;
  const scale = dpr * shrinkToFit(rect.width, rect.height, dpr, warnings, 124_000_000);

  const dataUrl = await firefox.tabs.captureTab(tab.id!, { format: 'png', rect, scale });
  const what = scope === 'full' ? 'full document' : `${scope} ${describeClip(rect)}`;
  return screenshotArtifact(
    `tabs.captureTab(rect=${what}, scale=${scale.toFixed(4)})`,
    await dataUrlToBytes(dataUrl),
  );
}

// ---------------------------------------------------------------------------
// Screenshots, either browser

/** The factor, at most 1, that keeps a `width` × `height` CSS px screenshot taken at `dpr`
 *  within MAX_SCREENSHOT_SIDE per side and `maxPixels` in all. Warns when it shrinks. */
function shrinkToFit(width: number, height: number, dpr: number, warnings: string[], maxPixels = Infinity) {
  const w = width * dpr;
  const h = height * dpr;
  const fit = Math.min(1, MAX_SCREENSHOT_SIDE / w, MAX_SCREENSHOT_SIDE / h, Math.sqrt(maxPixels / (w * h)));
  if (fit >= 1) return 1;
  // Rounded down so the browser's own rounding can't land a pixel past the limit.
  const shrink = Math.floor(fit * 1e4) / 1e4;
  warnings.push(
    `Screenshot scaled down to ${Math.round(w * shrink)}×${Math.round(h * shrink)}px ` +
      `(${+(dpr * shrink).toFixed(4)} px per CSS px instead of ${dpr}) to fit the size limit`,
  );
  return shrink;
}

/** Browsers can fail without an error here (Chrome returns an empty image past a format's
 *  size limit), and an empty screenshot must never be hashed and signed. */
function screenshotArtifact(method: string, bytes: Uint8Array<ArrayBuffer>): Pending {
  if (bytes.byteLength === 0) throw new Error(`The browser returned an empty screenshot (${method})`);
  return { name: 'screenshot.png', mediaType: 'image/png', capturedAt: nowIso(), method, bytes };
}

// ---------------------------------------------------------------------------
// The image under the context menu

const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/svg+xml': 'svg',
  'image/bmp': 'bmp',
  'image/x-icon': 'ico',
  'image/apng': 'apng',
};

/** Fetches the image as the page would (with its cookies). The bytes are the file the
 *  server sends now, which is normally the one shown; the screenshot shows the rendering.
 *  A cached copy is only used once the server says it is current (no-cache): `force-cache`
 *  would hand back an earlier capture's bytes, however stale, as today's. */
async function fetchImage(srcUrl: string, warnings: string[]): Promise<Pending | null> {
  try {
    if (!/^(https?|data):/.test(srcUrl)) throw new Error(`unsupported URL scheme (${srcUrl.slice(0, 40)})`);
    const response = await fetch(srcUrl, { credentials: 'include', cache: 'no-cache' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0) throw new Error('empty response');
    if (bytes.byteLength > MAX_IMAGE_BYTES) throw new Error(`larger than ${MAX_IMAGE_BYTES / 1024 / 1024} MB`);
    const mediaType = (response.headers.get('content-type') ?? 'application/octet-stream').split(';')[0]?.trim() || 'application/octet-stream';
    const ext = IMAGE_EXTENSIONS[mediaType] ?? 'bin';
    return {
      name: `image.${ext}`,
      mediaType,
      capturedAt: nowIso(),
      method: `fetch(${srcUrl.startsWith('data:') ? 'data: URL' : 'srcUrl'}, credentials=include, cache=no-cache)`,
      bytes,
    };
  } catch (e) {
    warnings.push(`The image could not be fetched: ${errorMessage(e)}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// In-page reading

const navigated = (from: string, to: string) =>
  new Error(`The page navigated during the capture (${from} → ${to}); capture it again`);

/** Whether two URLs name one document: the fragment is never requested. */
const sameDocument = (a: string, b: string) => a.split('#')[0] === b.split('#')[0];

async function readPage(tabId: number, includeHtml: boolean): Promise<PageInfo> {
  const [result] = await browser.scripting.executeScript({
    target: { tabId },
    func: collectPageInfo,
    args: [includeHtml],
  });
  if (!result?.result) throw new Error('Could not read the page (is it still loading?)');
  return result.result as PageInfo;
}

/** The page's visible text as Markdown, converted in the page by entrypoints/page-markdown.ts.
 *  A convenience copy: when it fails the capture goes ahead without it, with a warning. */
async function pageMarkdown(tabId: number, warnings: string[]): Promise<Pending | null> {
  try {
    const text = await runScriptFile(tabId, '/page-markdown.js');
    return textArtifact(
      'page.md',
      'text/markdown;charset=utf-8',
      text,
      'scripting.executeScript:page-markdown.js(visible elements, Turndown)',
    );
  } catch (e) {
    warnings.push(`No Markdown copy of the page: ${errorMessage(e)}`);
    return null;
  }
}

/** The page as one self-contained HTML file, made in the page by entrypoints/page-singlefile.ts. */
async function pageSingleFile(tabId: number, warnings: string[]): Promise<Pending | null> {
  try {
    const html = await keepAlive(runScriptFile(tabId, '/page-singlefile.js'));
    return textArtifact(
      'page.html',
      'text/html;charset=utf-8',
      html,
      'scripting.executeScript:page-singlefile.js(single-file-core, resources inlined, scripts removed)',
    );
  } catch (e) {
    warnings.push(`No SingleFile copy of the page: ${errorMessage(e)}`);
    return null;
  }
}

async function runScriptFile(tabId: number, file: '/page-markdown.js' | '/page-singlefile.js'): Promise<string> {
  const [result] = await browser.scripting.executeScript({ target: { tabId }, files: [file] });
  if (typeof result?.result !== 'string') throw new Error('the page returned no text');
  return result.result;
}

function textArtifact(name: string, mediaType: string, text: string, method: string): Pending {
  return { name, mediaType, capturedAt: nowIso(), method, bytes: new TextEncoder().encode(text) };
}

// ---------------------------------------------------------------------------
// Helpers

async function environment() {
  const manifest = browser.runtime.getManifest();
  return {
    userAgent: navigator.userAgent,
    browser: import.meta.env.FIREFOX ? await firefox.runtime.getBrowserInfo() : { name: 'chromium' },
    platform: await browser.runtime.getPlatformInfo(),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    extension: { id: browser.runtime.id, version: manifest.version },
  };
}

/** The artifact as a .gz file. The record keeps the original's hash and size too, so the
 *  file can still be checked after `gunzip`. */
async function gzipped(a: Pending): Promise<Pending> {
  const stream = new Blob([a.bytes]).stream().pipeThrough(new CompressionStream('gzip'));
  return {
    ...a,
    name: `${a.name}.gz`,
    mediaType: 'application/gzip',
    method: `${a.method} + gzip`,
    bytes: new Uint8Array(await new Response(stream).arrayBuffer()),
    uncompressed: { mediaType: a.mediaType, sha256: await sha256Hex(a.bytes), size: a.bytes.byteLength },
  };
}

async function dataUrlToBytes(dataUrl: string): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await (await fetch(dataUrl)).arrayBuffer());
}
