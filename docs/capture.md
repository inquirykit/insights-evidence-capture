# What is captured

| Artifact / field       | Chrome                                  | Firefox                                 |
|------------------------|-----------------------------------------|-----------------------------------------|
| `screenshot.png` full / region / element | CDP `Page.captureScreenshot` with a clip, beyond the viewport | `tabs.captureTab({ rect })` |
| `screenshot.png` visible | `tabs.captureVisibleTab` (no DevTools protocol, so no debugger bar) | `tabs.captureVisibleTab` |
| `element.html`, `selection.txt`/`.html`, `image.*` | what an element, selection or image capture pointed at | same |
| `page.mhtml.gz`        | optional: CDP `Page.captureSnapshot`, gzipped | — (no API)                        |
| `page.html`            | optional: SingleFile, resources inlined, scripts removed | same                   |
| `page.pdf`             | optional: CDP `Page.printToPDF`, backgrounds on | — (`tabs.saveAsPDF` only writes to disk) |
| `dom.html`             | live DOM after scripts ran              | live DOM after scripts ran              |
| `page.md`              | optional: visible text as Markdown      | optional: visible text as Markdown      |
| `dom-changes.json`     | optional (Watch DOM changes): the latest 1000 DOM changes | same                |
| response status/headers, server IP, redirect chain | ✓                     | ✓                                       |
| TLS certificate chain  | — (not exposed to extensions)           | ✓ `webRequest.getSecurityInfo`          |
| environment            | UA, platform, time zone, extension version | same + browser build                 |

Screenshots are capped at 16384 CSS px tall, and scaled down to at most 16383 device px per
side (the most WebP can hold). A warning is recorded when a screenshot is truncated or scaled.

The MHTML embeds every image, stylesheet and frame of the page, images as base64 text, so it
is gzipped in the browser before it is hashed (30-50% smaller). Its entry in the client
metadata also records the SHA-256 and size of the MHTML itself (`uncompressed`), so the file
can be checked after `gunzip`. Captures made before this change have a plain `page.mhtml`.

`page.md` is made inside the page (`entrypoints/page-markdown.ts`): the elements that are laid
out and not hidden, open shadow roots as rendered, converted with
[Turndown](https://github.com/mixmark-io/turndown). Tables with header cells become GFM tables
(row spans are not resolved); tables used for page layout are read row by row. Iframes, images
without alt text and `data:` URLs are left out. The page is never modified: the visible
elements are copied into a detached document first. It is a reading copy; the screenshot,
`dom.html` and the MHTML remain the record of the page. If the conversion fails the capture
goes ahead without it, with a warning.

`page.html` is made inside the page by [single-file-core](https://github.com/gildas-lormeau/single-file-core)
(AGPL-3.0, `entrypoints/page-singlefile.ts`): every stylesheet, image and font is fetched and
inlined as a `data:` URL, hidden elements and unused CSS are dropped, scripts and media are
removed, so the file opens inert and looks the same offline in any browser. Resources the page
itself can't fetch (CORS) are fetched by the background with the page's cookies. Frames are
left out (the MHTML has them). SingleFile never scrolls or zooms the page here (lazy-loaded
content below the fold is there only if **Auto-scroll** loaded it), marks elements with temporary attributes while it works
and removes them after; `dom.html` is read before it runs. Like `page.md` it is a derived copy:
the screenshot, `dom.html` and the MHTML remain the record of the page.

A region or element screenshot is clipped from the page's own rendering, not stitched or
redrawn. The record keeps what was pointed at under `selection`: the rectangle in CSS px from
the page's top-left, and for an element its tag, a CSS selector, XPath and visible text; for
a text selection its text and the XPath of its container; for an image its URL. On Chrome the
DevTools protocol renders the clip even beyond the viewport; without it (and on a text
selection) the visible part is cropped from the viewport and a warning says so.

The client metadata records the choices (`options`, including the depth, the screenshot scope,
`autoScroll`, `reload` and `monitorDom`) and what started the capture (`trigger`: popup,
shortcut, contextMenu or auto), so a missing archive reads as a choice rather than a failure.
What happened to the page first is recorded too: `reload`, `scroll` and `domMonitor`.

## DOM changes

**Watch DOM changes** (`lib/page/dom-monitor.ts`, in the spirit of VouchShot) runs a
MutationObserver in the extension's isolated world, out of the page scripts' reach. While the
option is on, it is a registered content script, so every page loaded from then on is watched
from `document_start`. A page that was already open is watched from the start of the capture.
The capture marks its own start just before the screenshot and reads the watcher right after
`dom.html`. So "during capture" covers the screenshot, MHTML, PDF and DOM, and none of the
archives' own changes (SingleFile's temporary marks, the region picker's overlay) are counted.

The record's `domMonitor` gives:
- `since`: `documentStart` or `injected`.
- Change counts for three windows: `whileLoading` (the parser building the page, until
  DOMContentLoaded), `beforeCapture` and `duringCapture`. Each is broken down into
  structure, text and attribute changes, plus nodes added and removed.
- The time of the last change.
- `userEdits`: text typed, pasted or dropped into editable content (contenteditable or
  `designMode`). Page scripts fire no input events, so these are changes a person made.
- Whether `document.designMode` was on, and how many elements were `contenteditable`.

`dom-changes.json` lists the latest 1000 changes after loading. Each one has its time, phase
(before or during), a CSS path to the node, and the old and new value or the text added and
removed (cut to 200 characters). Warnings flag changes during the capture, design mode and
typed edits. The dashboard's **Page changes** panel shows the counts and the latest changes.

A MutationObserver can't tell a page script's change from another extension's or a DevTools
edit. Only typed edits identify a person. Pair it with **Reload first** to start from what the
server sent.
