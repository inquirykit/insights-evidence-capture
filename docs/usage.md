# Using the extension

## Popup

Click the toolbar icon. On first run the popup asks where to store captures: **In this
browser**, or **On a Core AI & Data toolkit server** with its URL (default `http://localhost:8000`) and
its `API_KEY`. Click the connection pill at any time to change it. The info button beside the
name shows the version and a link to the source of the Core AI & Data toolkit (ai_toolkit),
[inquirykit/core-ai-data-toolkit](https://github.com/inquirykit/core-ai-data-toolkit). Pick a case, add a note and tags if you like, and click **Capture this page**.
The note is signed with the capture. Tags are not: they go to the capture's annotations (see
[Tags and notes](#tags-and-notes)), where they can be changed later.

The popup has four tabs: **Capture** (case, note, tags, depth, screenshot and the capture
button; it opens on this one), **Options** (Also save, Auto-scroll, Integrity), **Auto**
([auto-capture](#auto-capture)) and **Recent** (the case's last 10 captures and **Verify
log**). **Dashboard**, at the end of the tab bar, opens the [dashboard](#dashboard) in a tab of
its own. Tags typed in the popup become coloured chips (see [Tags and notes](#tags-and-notes));
the tags you have used before are offered as you type.

**Depth** sets how much a capture saves, from text alone to every format. `dom.html` and the
page, network and environment metadata are saved at every depth.

| Depth        | Saves                                                        | Use it for                          |
|--------------|--------------------------------------------------------------|-------------------------------------|
| **Basic**    | Markdown text, DOM; no screenshot                            | content and keyword analysis, bulk research |
| **Standard** | + screenshot                                                 | everyday captures                   |
| **Full**     | + page archive: MHTML (Chrome), single HTML file (Firefox)   | evidence you may need to replay (default) |
| **Max**      | + MHTML, single HTML file and PDF (Chrome only)              | everything, when size doesn't matter |

A depth is a preset of the **Screenshot** choice below it and the **Also save** choices on the
Options tab; changing one of those by hand shows the depth as *Custom*. A depth keeps the screenshot scope you chose.

**Screenshot** chooses how much of the page the screenshot shows: **none**, the **full page**, the
**visible** viewport as it is, a **region** you drag on the page, or an **element** you click
(its HTML is saved too, as `element.html`). Region and element close the popup so you can
point at the page; Esc cancels, and the toolbar badge shows ✓ or ! when the capture is done.
**Also save** adds archives to every capture: the MHTML page archive (Chrome only, often
several MB), a single self-contained HTML file made with SingleFile (both browsers), a PDF
(Chrome only) and a Markdown copy of the page's visible text. The choices are remembered.

**Auto-scroll** (Off, 10 s, 30 s, 60 s) scrolls through the page before a page capture, in
steps of most of a viewport, so content that loads on scroll (lazy images, feeds) is in the
document. It stops at the bottom once the page stops growing for 1.5 s, or at the time limit
on a feed that never ends. It also finds a web app's own scrolling pane when the document
itself doesn't scroll. It then scrolls back to where you were and waits up to 3 s for images
still loading. The record keeps what it did under `scroll`: steps, time, the height before and
after, and whether it reached the end. A warning says when the limit stopped it.

**Integrity** has two choices:
- **Reload first** reloads the page and captures it as it comes back, waiting up to 30 s for
  it to load and 1 s more for its scripts. Changes made to the page since it loaded are gone
  from the capture: DevTools edits, text typed into it, other extensions' changes. The record
  keeps when the reload was asked for and when the page loaded again (`reload`).
- **Watch DOM changes** records what changed in the document before and during the capture.
  See [DOM changes](capture.md#dom-changes).

Selection and image captures never scroll or reload.

**Alt+Shift+S** captures into the last used case with the same choices. The right-click
menu offers **Capture page**, **Capture selection** (the selected text and its HTML, with the
screenshot clipped to it) and **Capture image** (the image file itself, plus the visible
viewport), all into the last used case.

## Auto-capture

**Auto-capture**, on the popup's Auto tab, captures every page you visit into
the case selected when you turn it on. **Capture into … instead** moves it to the case now
selected. It has its own depth, its own screenshot setting (visible viewport or full page) and
a **Skip sites** list; a site listed also covers its subdomains. While it is on, the toolbar
badge reads **REC**, the Auto tab shows a red light, and the tab counts the pages captured,
skipped as unchanged, and failed.

- A page is captured 2 s after it finishes loading, or after it changes its URL in place as
  single-page apps do. It must be the tab in front of its window: a tab behind isn't painted,
  so it has no viewport to screenshot. A page that loaded in a background tab is captured
  when you bring that tab to the front.
- A page whose URL and text (title plus `innerText`, hashed) haven't changed since its last
  automatic capture into the same case, store and depth is skipped, so switching between tabs
  doesn't capture them again. The last 500 pages are remembered, for the browser session, and
  forgotten when auto-capture is turned on again.
- Never captured: private windows, anything but `http(s)`, the ai_toolkit server's own
  origin, the sites in the skip list, and a tab that is already being captured.
- Automatic captures never scroll or reload the page you are reading. They follow **Watch DOM
  changes** from the main options, and are recorded with `trigger: "auto"`.
- On Chrome the default screenshot is the visible viewport. A full-page screenshot (and the
  MHTML or PDF of the Full and Max depths) needs the DevTools protocol, whose debugging bar
  would appear during each capture.

A visible-viewport screenshot is refused if the tab isn't in front of its window just before
and just after it is taken, so another tab's viewport is never signed as this page's. This
applies to every capture.

## Dashboard

**Dashboard** in the popup's tab bar (or a click on any recent capture, or on the result after
a capture) opens a full-tab view of your cases. It
reads everything from the store in use; your watch terms and how your tags look stay in this
browser profile, whichever store that is.

The sidebar lists the cases, and above them two views across all of them:

- **All cases**: each case with its pages, sites, open todos, most used tags, last capture and
  creation date; **New case** adds one. A tag there opens the case's pages with that tag. The server
  has no way to rename or delete a case.
- **Tags**: every tag in every case, with its pages and the cases it is in, plus the tags
  made here that no page has yet. **Edit** gives a tag a colour (ten, as circles) and an icon
  (fifteen, or a plain dot), renames it, or deletes it. Renaming and deleting change every
  page that has the tag; renaming to a tag that exists merges the two, after a confirmation.
  **New tag** makes one ahead of use, so it is offered while tagging.

In a case:

- **Pages**: every capture in the case as a screenshot card, grouped by day, with its HTTP
  status, timestamp state, note, tags, analyst-note count, selector count and an **auto**
  badge for automatic captures. The search box (`/`) matches titles, URLs, notes, tags
  *and the text of the captured pages*. The **Tags** row filters to the pages that have all
  the tags picked. Export the list as CSV (with trigger, tags and analyst notes).
- **Selectors**: identifiers pulled out of every page's `dom.html`, with the pages each one
  was found on: emails, phone numbers, social profiles (X, Facebook, Instagram, LinkedIn,
  GitHub, Telegram, TikTok, YouTube, Reddit, Threads, Bluesky), Bitcoin addresses
  (checksum-verified), Ethereum addresses, onion addresses, IPv4 addresses and linked
  sites. **Watch for** adds your own terms (names, usernames, numbers): each one is
  matched as a whole word, case-insensitively, across every page. Export as CSV.
- **Sites**: each host captured, its server IPs and what the enrichers said about them at
  capture time. A click on a host shows its pages.
- **Todos**: the case's to-do list, for what is left to check, ask for or follow up. Type one
  and press Enter; check it off, edit it (pencil: Enter saves, Esc cancels) or delete it. Done
  todos are listed apart, the latest first, and **Clear done** deletes them after a
  confirmation. The tab counts the open ones, and the search box filters them. It works before
  the case has any captures. Like tags and notes, todos are kept by the server beside the case,
  never in a signed record (`GET`/`PUT /evidence/cases/{id}/todos`); each keeps when it was
  added, edited and done. Up to 500 per case, each up to 2000 characters.
- **A capture**: the full screenshot beside the signed record, made readable: tags and
  analyst notes (editable), note, reload and auto-scroll, selectors on the page, page
  changes, record hash / signature / trusted timestamp, the files with their SHA-256 (open,
  view source, download), response headers, redirects, TLS (Firefox), enrichment and
  environment. `←` / `→` step through the case and `Esc` goes back.
- **Verify ledger** in the sidebar re-checks the whole chain.

## Tags and notes

Tags and analyst notes belong to the case's work, not to the evidence. The store keeps them
beside the signed records (on the server, an `annotations` table per workspace), never inside them, so adding
or changing them alters no record, signature or timestamp. The **Tags & notes** panel of a
capture adds tags (Enter, a comma, or leaving the field; the case's tags and your known tags
are offered) and removes them (×). It adds notes (**Add note**, or ⌘/Ctrl+Enter), each with
its time, and deletes them after a confirmation.

Every tag shows as a chip tinted with its colour, with its icon or a dot: on page cards, in the
Tags filter, in a capture's panel, on the overview pages and in the popup. A tag nobody has
styled takes a colour from its name. Colours and icons are kept in the extension's storage
(`tagDefs`, by tag lower-cased), like the watch terms: they stay in this browser profile and
are not sent to the server. A tag typed into the popup or a capture is remembered there, so it
is offered later.

Tags are trimmed, inner spaces collapsed, and de-duplicated without regard to case (the first
spelling stays). Each is 1–64 characters, up to 64 per capture. A note holds up to 20000
characters, up to 200 notes per capture. The note typed in the popup at capture time is
different: it is part of the signed record and never changes.

Captured HTML is only ever parsed inertly (`DOMParser`) or shown as source; it is never
rendered in the extension's origin, where its scripts would run with the extension's
privileges. Records, thumbnails and page scans are cached for the life of the tab, since a
signed capture never changes.
