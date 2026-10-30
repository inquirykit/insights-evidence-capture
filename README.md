# Insights & Evidence Capture

![status: alpha](https://img.shields.io/badge/status-alpha-orange)
![version: 0.5.0-alpha.8](https://img.shields.io/badge/version-0.5.0--alpha.8-blue)

A browser extension for Chrome and Firefox that captures web pages as evidence you can verify
later. Each capture is hashed in the browser, written into a signed, hash-chained record and
given an RFC 3161 trusted timestamp, so a change made after the capture shows.

Captures are kept in one of two stores, chosen per browser profile:

- **In this browser** (the browser store): the extension signs, chains and timestamps them
  itself. Nothing else to run.
- **On a server** (the server store): [ai_toolkit](https://github.com/inquirykit/core-ai-data-toolkit),
  the Core AI & Data toolkit, a separate project, signs them, enriches them and shares them
  between browsers. See [Server store](docs/server.md).

## Features

- **Screenshots** of the full page, the visible viewport, a region you drag or an element you
  click.
- **Page archives**: MHTML (Chrome), a single self-contained HTML file, a PDF (Chrome) and the
  visible text as Markdown.
- **Network details**: response status and headers, server IP, redirects, and the TLS
  certificate chain (Firefox).
- **Integrity options**: reload the page before capture, and record what changed in the DOM,
  including text someone typed.
- **Auto-capture** of every page you visit into a case, with a list of sites to skip.
- **Dashboard** of cases, with full-text search, tags, analyst notes, todos, and identifiers
  found on the pages (emails, phone numbers, social profiles, crypto addresses and more).
- **Verification** in the extension, or with standard OpenSSL commands. What a capture proves,
  and what it cannot: [Evidence and verification](docs/evidence.md#what-this-does-and-does-not-prove).

## Install

It isn't in the Chrome Web Store or on Firefox Add-ons yet, so build it from source with
[Bun](https://bun.sh):

```sh
bun install
bun run build            # Chrome:  .output/chrome-mv3
bun run build:firefox    # Firefox: .output/firefox-mv2
```

- **Chrome**: open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**
  and pick `.output/chrome-mv3`.
- **Firefox**: open `about:debugging#/runtime/this-firefox`, click **Load Temporary Add-on…**
  and pick `.output/firefox-mv2/manifest.json`. Firefox removes it when it quits.

The extension needs Chrome 111 or Firefox 119 or later; captures kept in the browser need
Chrome 137 or Firefox 130 (Ed25519 in WebCrypto).

## Use

Click the toolbar icon. The first time, choose where to keep captures: **In this browser**
needs nothing else; **On a Core AI & Data toolkit server** asks for its URL and API key. Pick
a case, add a note and tags if you like, and click **Capture this page**. **Alt+Shift+S** and
the right-click menu capture into the last used case. **Dashboard** opens your cases in a tab.

On Chrome, a full-page screenshot, MHTML or PDF goes through the DevTools protocol, so Chrome
shows its debugging bar while the capture runs.

## Documentation

| Page                                           | What's in it                                                       |
|------------------------------------------------|--------------------------------------------------------------------|
| [Using the extension](docs/usage.md)           | the popup, depth and screenshot choices, auto-capture, the dashboard, tags and notes |
| [What is captured](docs/capture.md)            | every file and field, per browser; DOM change tracking             |
| [Evidence and verification](docs/evidence.md)  | the two stores; how records are signed, chained and timestamped; verifying with OpenSSL; what it proves |
| [Privacy and permissions](docs/privacy.md)     | what leaves the browser, and why each permission is needed         |
| [Server store](docs/server.md)                 | running ai_toolkit for the extension: security, settings, API      |
| [Development](docs/development.md)             | dev setup, project layout, tests and fixtures, next steps          |

## Privacy

With the browser store, nothing of a capture is sent anywhere but the SHA-256 of each record,
to FreeTSA for the timestamp. With the server store, captures go to the server you set up.
With either, a single HTML file or an image capture may fetch the page's own resources again
from the site, as the page itself would. There is no analytics or telemetry. Details, and why each permission is needed:
[Privacy and permissions](docs/privacy.md).

## License

MIT: see [LICENSE](LICENSE). A build also contains the core of
[SingleFile](https://github.com/gildas-lormeau/single-file-core) (in `page-singlefile.js`),
which is AGPL-3.0-or-later, so a build you hand on is under that license's terms too, among
them offering its source. The Inter font is under the SIL Open Font License
(`assets/fonts/LICENSE-Inter.txt`).
