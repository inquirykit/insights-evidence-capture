// What capture.ts reads from the page before and after the screenshot, injected with
// scripting.executeScript({ func }). Like everything in lib/page/ it is serialized by source, so
// it must be self-contained (tests/page-functions.test.ts checks the rules).

export interface PageInfo {
  documentUrl: string;
  /** The URL the document was loaded from, after redirects: its navigation's. It stays the same
   *  through history.pushState and a return from the back/forward cache. Not recorded; capture.ts
   *  matches the document response with it. */
  loadedUrl: string;
  title: string;
  characterSet: string;
  contentType: string;
  lastModified: string;
  referrer: string;
  viewport: { width: number; height: number };
  scrollPosition: { x: number; y: number };
  scrollWidth: number;
  scrollHeight: number;
  devicePixelRatio: number;
  /** The live DOM with its doctype, when asked for: dom.html */
  html?: string;
}

export function collectPageInfo(includeHtml: boolean): PageInfo {
  const doc = document;
  const root = doc.documentElement;
  const dt = doc.doctype;
  const doctype = dt
    ? `<!DOCTYPE ${dt.name}${dt.publicId ? ` PUBLIC "${dt.publicId}"` : ''}${
        dt.systemId ? `${dt.publicId ? '' : ' SYSTEM'} "${dt.systemId}"` : ''
      }>\n`
    : '';
  return {
    documentUrl: location.href,
    loadedUrl: (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined)?.name || location.href,
    title: doc.title,
    characterSet: doc.characterSet,
    contentType: doc.contentType,
    lastModified: doc.lastModified,
    referrer: doc.referrer,
    viewport: { width: innerWidth, height: innerHeight },
    scrollPosition: { x: scrollX, y: scrollY },
    scrollWidth: Math.max(root.scrollWidth, doc.body?.scrollWidth ?? 0),
    scrollHeight: Math.max(root.scrollHeight, doc.body?.scrollHeight ?? 0),
    devicePixelRatio,
    html: includeHtml ? doctype + root.outerHTML : undefined,
  };
}
