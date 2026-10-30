// Injected into the captured page by capture.ts: returns the page as one self-contained HTML
// file, made with SingleFile's core (https://github.com/gildas-lormeau/single-file-core,
// AGPL-3.0). Every stylesheet, image and font is fetched and inlined as a data: URL, so the
// file reads the same offline in any browser. It is the page archive on Firefox, which has
// no MHTML, and a readable second archive on Chrome.
//
// SingleFile marks elements with temporary attributes while it works and removes them before
// it returns; capture.ts reads dom.html before this runs so those marks never reach it.
// Scripts are dropped from the copy (blockScripts) so the archive is inert when opened.

import * as singlefile from 'single-file-core/single-file.js';

import type { BgReply, BgRequest, FetchedResource } from '@/lib/protocol';

/** Fetches a resource from the page's context, as the page itself would; when CORS or a
 *  network error blocks that, through the background, which has host permissions. */
async function fetchResource(url: string, init: { headers?: Record<string, string> } = {}) {
  try {
    const response = await fetch(url, {
      headers: init.headers,
      cache: 'force-cache',
      referrerPolicy: 'strict-origin-when-cross-origin',
    });
    if (response.ok || response.status < 500) return response;
  } catch {
    // fall through to the background
  }
  const reply = (await browser.runtime.sendMessage({
    type: 'fetchResource',
    url,
    headers: init.headers,
  } satisfies BgRequest)) as BgReply<FetchedResource> | undefined;
  if (!reply?.ok) throw new Error(reply?.error ?? 'background fetch failed');
  const { status, headers, body } = reply.data;
  const bin = atob(body);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  // Response.url is read-only and empty here; SingleFile falls back to the requested URL.
  return new Response(bytes, { status, headers });
}

export default defineUnlistedScript(async () => {
  singlefile.init({ fetch: fetchResource, frameFetch: fetchResource });
  const page = await singlefile.getPageData({
    // The copy, not the page: hidden elements, unused CSS and alternative sources are dropped.
    removeHiddenElements: true,
    removeUnusedStyles: true,
    removeUnusedFonts: true,
    removeAlternativeFonts: true,
    removeAlternativeMedias: true,
    removeAlternativeImages: true,
    groupDuplicateImages: true,
    compressHTML: false,
    // Frames would need SingleFile's frame scripts in every frame; MHTML (Chrome) has them.
    removeFrames: true,
    // Never scroll or zoom the page to trigger lazy content: the capture must not change it.
    loadDeferredContent: false,
    blockScripts: true,
    blockVideos: true,
    blockAudios: true,
    maxResourceSizeEnabled: true,
    maxResourceSize: 10, // MB per resource
    networkTimeout: 30_000,
    insertMetaCSP: true,
    insertSingleFileComment: true,
    insertCanonicalLink: true,
    saveFavicon: true,
    acceptHeaders: {
      font: 'application/font-woff2;q=1.0,application/font-woff;q=0.9,*/*;q=0.8',
      image: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
      stylesheet: 'text/css,*/*;q=0.1',
      script: '*/*',
      document: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      video: 'video/webm,video/ogg,video/*;q=0.9,application/ogg;q=0.7,audio/*;q=0.6,*/*;q=0.5',
      audio: 'audio/webm,audio/ogg,audio/wav,audio/*;q=0.9,application/ogg;q=0.7,video/*;q=0.6,*/*;q=0.5',
    },
  });
  return page.content as string;
});
