// What a capture saves, how much of the page the screenshot covers and what happens to the
// page first (scrolling, reloading, watching its DOM). Chosen in the popup and kept in
// extension storage, so the keyboard shortcut and the context menu capture the same way.
// Auto-capture has settings of its own, at the end. Both are kept under their keys in
// settings.ts.

import { getConnection, getStoreMode, readLocal, readSession, removeLocal, writeLocal } from './settings';

/** How much of the page the screenshot shows.
 *  none: no screenshot; full: the whole document; visible: the viewport as it is; region: the
 *  user drags a rectangle; element: the user clicks an element. Region and element start a
 *  pick on the page before the capture. */
export type ScreenshotScope = 'none' | 'full' | 'visible' | 'region' | 'element';

export const SCREENSHOT_SCOPES: { value: ScreenshotScope; label: string; title: string }[] = [
  { value: 'none', label: 'None', title: 'No screenshot' },
  { value: 'full', label: 'Full page', title: 'The whole document, top to bottom' },
  { value: 'visible', label: 'Visible', title: 'The viewport exactly as it looks now' },
  { value: 'region', label: 'Region', title: 'Drag a rectangle on the page' },
  { value: 'element', label: 'Element', title: 'Click an element on the page' },
];

export interface CaptureOptions {
  screenshot: ScreenshotScope;
  /** Chrome only: the page archive with every image, stylesheet and frame (often MBs) */
  mhtml: boolean;
  /** A self-contained HTML copy made with SingleFile (page.html): works in every browser */
  singlefile: boolean;
  /** Chrome only: the page printed to PDF (page.pdf) */
  pdf: boolean;
  /** The page's visible text as Markdown (page.md) */
  markdown: boolean;
  /** Before a page capture, scroll through the page for up to this many seconds so content that
   *  loads on scroll is there, then back to where the user was. 0: never scroll */
  autoScroll: number;
  /** Reload the page first and capture it as it comes back: what the server sends, without
   *  changes made to the page since it loaded */
  reload: boolean;
  /** Record the DOM changes up to the end of the capture (dom-changes.json, a summary in the
   *  record). Pages loaded while it is on are watched from the start */
  monitorDom: boolean;
}

/** How long auto-scroll may run. It stops sooner at the bottom of a page that stops growing. */
export const AUTO_SCROLL_LIMITS: { value: number; label: string; title: string }[] = [
  { value: 0, label: 'Off', title: 'Capture the page as it is, without scrolling it' },
  { value: 10, label: '10 s', title: 'Scroll to the bottom (at most 10 s) so lazy content loads, then back' },
  { value: 30, label: '30 s', title: 'Scroll to the bottom (at most 30 s) so lazy content loads, then back' },
  { value: 60, label: '60 s', title: 'Scroll on for up to a minute: long feeds that keep loading' },
];

/** How deep a capture goes, from the page's text to every format there is. Each depth is a
 *  preset of the options; changing one of them by hand makes the options custom. dom.html is
 *  saved at every depth: the dashboard's search and selectors read it. */
export type CaptureDepth = 'basic' | 'standard' | 'full' | 'max';

type FileOptions = Pick<CaptureOptions, 'mhtml' | 'singlefile' | 'pdf' | 'markdown'>;

const PRESETS: Record<CaptureDepth, FileOptions & { screenshot: boolean }> = {
  basic: { screenshot: false, mhtml: false, singlefile: false, pdf: false, markdown: true },
  standard: { screenshot: true, mhtml: false, singlefile: false, pdf: false, markdown: true },
  // Firefox has no MHTML, so SingleFile is its page archive.
  full: { screenshot: true, mhtml: true, singlefile: import.meta.env.FIREFOX, pdf: false, markdown: true },
  max: { screenshot: true, mhtml: true, singlefile: true, pdf: true, markdown: true },
};

const ARCHIVE = import.meta.env.FIREFOX ? 'single HTML file' : 'MHTML archive';

export const CAPTURE_DEPTHS: { value: CaptureDepth; label: string; title: string }[] = [
  { value: 'basic', label: 'Basic', title: 'Text and DOM, no screenshot: for content and keyword analysis' },
  { value: 'standard', label: 'Standard', title: 'A screenshot, the text and the DOM' },
  { value: 'full', label: 'Full', title: `A screenshot, the ${ARCHIVE}, the text and the DOM` },
  // Firefox has no MHTML or PDF, so there Max would save no more than Full.
  ...(import.meta.env.FIREFOX
    ? []
    : [
        {
          value: 'max' as const,
          label: 'Max',
          title: 'Everything: screenshot, MHTML, single HTML file, PDF, text, DOM',
        },
      ]),
];

// The options this browser acts on: Firefox has no MHTML or PDF.
const APPLICABLE = (['mhtml', 'singlefile', 'pdf', 'markdown'] as const).filter(
  (key) => !import.meta.env.FIREFOX || (key !== 'mhtml' && key !== 'pdf'),
);

/** The options at `depth`. A screenshot keeps the scope already chosen, if there is one; what
 *  happens before the capture (scrolling, reloading, watching) is not part of a depth. */
export function withDepth(options: CaptureOptions, depth: CaptureDepth): CaptureOptions {
  const { screenshot, ...files } = PRESETS[depth];
  const scope = options.screenshot === 'none' ? 'full' : options.screenshot;
  return { ...options, ...files, screenshot: screenshot ? scope : 'none' };
}

/** The depth the options amount to, or null when they were set by hand to no preset. */
export function depthOf(options: CaptureOptions): CaptureDepth | null {
  const matches = (preset: (typeof PRESETS)[CaptureDepth]) =>
    preset.screenshot === (options.screenshot !== 'none') &&
    APPLICABLE.every((key) => preset[key] === options[key]);
  return CAPTURE_DEPTHS.find((d) => matches(PRESETS[d.value]))?.value ?? null;
}

// Full: what every capture saved before there were depths.
const DEFAULT_OPTIONS: CaptureOptions = {
  ...PRESETS.full,
  screenshot: 'full',
  autoScroll: 0,
  reload: false,
  monitorDom: false,
};

export async function getCaptureOptions(): Promise<CaptureOptions> {
  return { ...DEFAULT_OPTIONS, ...(await readLocal('captureOptions')) };
}

export async function setCaptureOptions(options: CaptureOptions): Promise<void> {
  await writeLocal('captureOptions', options);
}

// ---------------------------------------------------------------------------
// Auto-capture: every page the user visits, into one case (lib/auto-capture.ts does it)

/** The screenshots an automatic capture can take: there is no one to point at a region. */
export type AutoScreenshotScope = Extract<ScreenshotScope, 'full' | 'visible'>;

export interface AutoCaptureSettings {
  enabled: boolean;
  caseId: string;
  depth: CaptureDepth;
  /** Used when the depth has a screenshot */
  screenshot: AutoScreenshotScope;
  /** Hosts never captured automatically; each one covers its subdomains too */
  skipHosts: string[];
}

// Visible: a full-page screenshot on Chrome needs the DevTools protocol, whose debugging bar
// would come and go on every page visited.
const DEFAULT_AUTO_CAPTURE: AutoCaptureSettings = {
  enabled: false,
  caseId: 'inbox',
  depth: 'standard',
  screenshot: import.meta.env.FIREFOX ? 'full' : 'visible',
  skipHosts: [],
};

export async function getAutoCapture(): Promise<AutoCaptureSettings> {
  return { ...DEFAULT_AUTO_CAPTURE, ...(await readLocal('autoCapture')) };
}

export async function setAutoCapture(settings: AutoCaptureSettings): Promise<void> {
  await writeLocal('autoCapture', settings);
}

/** Where a case id means something: this browser, or one server. */
async function caseSpace(): Promise<string> {
  return (await getStoreMode()) === 'browser' ? 'browser' : `server ${(await getConnection())?.baseUrl ?? ''}`;
}

/** Makes `change` to where captures are kept. Cases are a store's own, so when captures go to
 *  another store or server afterwards, the last case and auto-capture's case, unknown there, go
 *  back to the Inbox that every store has; else the shortcut, the context menu and every
 *  automatic capture would fail on a case that isn't there. */
export async function switchStore(change: () => Promise<void>): Promise<void> {
  const before = await caseSpace();
  await change();
  if ((await caseSpace()) === before) return;
  await removeLocal('lastCaseId');
  const auto = await readLocal('autoCapture');
  if (auto?.caseId && auto.caseId !== DEFAULT_AUTO_CAPTURE.caseId)
    await writeLocal('autoCapture', { ...auto, caseId: DEFAULT_AUTO_CAPTURE.caseId });
}

/** What an automatic capture saves. It never scrolls or reloads the page the user is reading;
 *  watching the DOM is one setting for every capture, as pages are watched from their start. */
export function autoCaptureOptions(settings: AutoCaptureSettings, manual: CaptureOptions): CaptureOptions {
  const { screenshot, ...files } = PRESETS[settings.depth] ?? PRESETS.standard;
  return {
    ...files,
    screenshot: screenshot ? settings.screenshot : 'none',
    autoScroll: 0,
    reload: false,
    monitorDom: manual.monitorDom,
  };
}

/** "a.example, https://b.example/x" → ["a.example", "b.example"] */
export function parseHosts(text: string): string[] {
  const hosts = text
    .split(/[\s,]+/)
    .map((part) => {
      const t = part.trim().toLowerCase();
      if (!t) return '';
      try {
        return new URL(/^[a-z]+:\/\//.test(t) ? t : `http://${t}`).hostname.replace(/^www\./, '');
      } catch {
        return '';
      }
    })
    .filter(Boolean);
  return [...new Set(hosts)];
}

/** What auto-capture did since it was turned on; kept in storage.session by the background. */
export interface AutoCaptureStats {
  since: string;
  captured: number;
  /** Pages skipped because their text had not changed since they were last captured */
  unchanged: number;
  failed: number;
  lastUrl?: string;
  lastAt?: string;
  lastError?: string;
}

export async function getAutoCaptureStats(): Promise<AutoCaptureStats | null> {
  return (await readSession('autoCaptureStats')) ?? null;
}
