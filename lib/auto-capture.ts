// Auto-capture: while it is on, every page the user visits is captured
// into the chosen case. Runs in the background script; the popup turns it on and sets it up
// (AutoCaptureSettings in options.ts).
//
// A page is captured once it has finished loading (or changed its URL in place, as single-page
// apps do), has held still for SETTLE_MS, and is the tab in front of its window: a tab behind
// isn't painted, so it has no viewport to screenshot, and may never be looked at. A page that
// loaded behind is captured when its tab comes to the front. A page whose URL and text are the
// same as when it was last captured is skipped, so moving between tabs does not capture them
// again. Private (incognito) windows, other schemes than http(s), the ai_toolkit server itself
// and the hosts the user listed are never captured; nor is a tab already being captured.

import {
  autoCaptureOptions,
  getAutoCapture,
  getAutoCaptureStats,
  getCaptureOptions,
  type AutoCaptureSettings,
  type AutoCaptureStats,
  type CaptureOptions,
} from './options';
import { pageFingerprint, type PageFingerprint } from './page/fingerprint';
import { errorMessage } from './protocol';
import { getConnection, getStoreMode, onLocalChange, readSession, removeSession, writeSession } from './settings';

// After a load or a URL change, for the page's scripts to render.
const SETTLE_MS = 2000;
// Pages remembered for skipping unchanged ones.
const MAX_SEEN = 500;

export interface AutoCaptureDeps {
  /** Resolves with the URL of the document captured */
  capture(tabId: number, options: CaptureOptions, caseId: string): Promise<{ url: string }>;
  /** True while the tab is being captured (by hand or automatically) */
  isBusy(tabId: number): boolean;
  /** Auto-capture was turned on or off */
  onToggle(enabled: boolean): void;
}

/** Registers the listeners; call synchronously at background startup. */
export function startAutoCapture(deps: AutoCaptureDeps) {
  const timers = new Map<number, ReturnType<typeof setTimeout>>();
  // One automatic capture at a time.
  let queue: Promise<unknown> = Promise.resolve();
  // Kept current from storage, so events while it is off cost nothing; null until first read.
  let enabled: boolean | null = null;
  void getAutoCapture().then((s) => (enabled = s.enabled));

  const schedule = (tabId: number) => {
    if (enabled === false || tabId < 0) return;
    clearTimeout(timers.get(tabId));
    timers.set(
      tabId,
      setTimeout(() => {
        timers.delete(tabId);
        queue = queue.then(() => attempt(tabId, deps)).catch((e) => console.error('auto-capture:', e));
      }, SETTLE_MS),
    );
  };

  browser.tabs.onUpdated.addListener((tabId, change, tab) => {
    if (change.status === 'complete' || (change.url && tab.status === 'complete')) schedule(tabId);
  });
  browser.tabs.onActivated.addListener(({ tabId }) => schedule(tabId));
  browser.tabs.onRemoved.addListener((tabId) => {
    clearTimeout(timers.get(tabId));
    timers.delete(tabId);
  });

  onLocalChange('autoCapture', (settings, previous) => {
    const was = previous?.enabled ?? false;
    const now = settings?.enabled ?? false;
    enabled = now;
    if (was === now) return;
    deps.onToggle(now);
    if (!now) return;
    // A fresh count and a fresh memory, and the page in front of each window right away.
    void setStats({ since: new Date().toISOString(), captured: 0, unchanged: 0, failed: 0 });
    void removeSession('autoCaptureSeen');
    void browser.tabs.query({ active: true }).then((tabs) => tabs.forEach((t) => t.id != null && schedule(t.id)));
  });
}

async function attempt(tabId: number, deps: AutoCaptureDeps) {
  const settings = await getAutoCapture();
  if (!settings.enabled) return;
  const tab = await browser.tabs.get(tabId).catch(() => null);
  if (!tab?.url || !tab.active || tab.status !== 'complete' || tab.incognito) return;
  if (!(await eligible(tab.url, settings)) || deps.isBusy(tabId)) return;

  const print = await fingerprint(tabId);
  if (!print) return;
  // Unchanged means: captured before, as it is now, into this case, store and depth. The same
  // page is new again in another case or at another depth.
  const key = `${await getStoreMode()}|${settings.caseId}|${settings.depth}|${settings.screenshot}\n${print.url}`;
  const seen = await getSeen();
  if (seen[key] === print.hash) {
    await updateStats((s) => s.unchanged++);
    return;
  }
  try {
    const outcome = await deps.capture(tabId, autoCaptureOptions(settings, await getCaptureOptions()), settings.caseId);
    // Remembered only when the page captured is the page fingerprinted: after a navigation in
    // between, the fingerprint says nothing about what was captured.
    if (outcome.url === print.url) {
      delete seen[key];
      seen[key] = print.hash;
      const keys = Object.keys(seen);
      for (const k of keys.slice(0, Math.max(0, keys.length - MAX_SEEN))) delete seen[k];
      await writeSession('autoCaptureSeen', seen);
    }
    await updateStats((s) => {
      s.captured++;
      s.lastUrl = print.url;
      s.lastAt = new Date().toISOString();
    });
  } catch (e) {
    await updateStats((s) => {
      s.failed++;
      s.lastError = `${print.url}: ${errorMessage(e)}`;
    });
  }
}

async function eligible(url: string, settings: AutoCaptureSettings): Promise<boolean> {
  let page: URL;
  try {
    page = new URL(url);
  } catch {
    return false;
  }
  if (page.protocol !== 'http:' && page.protocol !== 'https:') return false;
  const server = (await getConnection())?.baseUrl;
  if (server && new URL(server).origin === page.origin) return false;
  const host = page.hostname.toLowerCase().replace(/^www\./, '');
  return !settings.skipHosts.some((h) => host === h || host.endsWith(`.${h}`));
}

/** The page's URL and a quick hash of its title and text: tells whether it changed, proves nothing. */
async function fingerprint(tabId: number): Promise<PageFingerprint | null> {
  try {
    const [result] = await browser.scripting.executeScript({ target: { tabId }, func: pageFingerprint });
    return (result?.result as PageFingerprint | undefined) ?? null;
  } catch {
    return null; // a page scripts can't run in (the store, a PDF viewer...)
  }
}

async function getSeen(): Promise<Record<string, string>> {
  return (await readSession('autoCaptureSeen')) ?? {};
}

async function setStats(stats: AutoCaptureStats) {
  await writeSession('autoCaptureStats', stats);
}

async function updateStats(change: (stats: AutoCaptureStats) => void) {
  const stats = (await getAutoCaptureStats()) ?? { since: new Date().toISOString(), captured: 0, unchanged: 0, failed: 0 };
  change(stats);
  await setStats(stats);
}
