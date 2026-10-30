# Development

## Setup

```sh
bun install
bun run dev            # launches Chrome with the extension loaded; its profile (server URL,
                       # API key, settings) is kept in .wxt/chrome-data, less its service
                       # workers, so Chrome runs the background just built
bun run dev:firefox    # launches Firefox with the extension loaded, in a fresh profile each time
```

For the server store, run an ai_toolkit server as well: see
[Running a server](server.md#running-a-server).

To skip typing the server's API key into the popup, put `WXT_DEFAULT_API_KEY=<the server's API_KEY>` in
`.env.local` (gitignored). `bun run dev` builds the key into the extension and uses it
whenever no key is saved in the popup, including a saved connection whose key field was left
empty. Production builds (`bun run build`, `bun run zip`) leave it out, so a zip you hand on
never carries it.
WXT reads `.env` files only at startup, so restart `bun run dev` after changing it.

The toolbar icon is a white viewfinder mark on an indigo tile, generated at build time from
`assets/icon.svg` by `@wxt-dev/auto-icons`.

## Project layout

WXT + React + TypeScript, built with Bun. Chrome (MV3) and Firefox (MV2). `lib/store.ts` is
what both stores do: `lib/local-store.ts` is the browser store (IndexedDB, WebCrypto Ed25519,
`lib/tsa.ts` for RFC 3161, `lib/canonical.ts` for RFC 8785) and `lib/server-store.ts` talks to
ai_toolkit. What runs inside a captured page is in `lib/page/`; what is kept in browser
storage, and under which key, is in `lib/settings.ts`.

## Builds

`bun run build` / `bun run build:firefox` → `.output/chrome-mv3` and `.output/firefox-mv2`;
`bun run zip` / `bun run zip:firefox` write release zips to `.output/`. To load a build by
hand, see [Install](../README.md#install).

## Tests

```sh
bun test               # tests/, on fake IndexedDB and fake browser storage
bun run compile        # type-checks the extension, then the tests
bun run fixtures       # remakes tests/fixtures with ai_toolkit's own code (see below; OpenSSL 3)
```

The fixtures are committed, so `bun test` needs neither ai_toolkit nor the network. Remaking them
needs an ai_toolkit checkout with its `.venv`: `bun run fixtures` looks for it at
`../../ai_toolkit`; elsewhere, run its two steps with your path:
`bun tests/fixtures/make-browser-record.ts && <ai_toolkit>/.venv/bin/python -I tests/fixtures/make-server-fixtures.py <ai_toolkit>`.

The fixtures hold the two stores to one format. `tests/fixtures/server-record/` is a record built
and signed by ai_toolkit's evidence code, with a token from a throwaway OpenSSL TSA; the
extension's canonicalizer, signature check and token reader must accept it. `browser-record/` is
one the browser store made, which `make-server-fixtures.py` checks with the server's code.
`jcs-vectors.json` holds RFC 8785 cases as the server's canonicalizer writes them. Nothing is sent
anywhere while they are made. `freetsa/` is different: a real FreeTSA token over placeholder
data, made once by hand, which the extension must verify under the root it trusts.

## Next steps worth considering

- Chrome: record raw response bodies and TLS details during capture through CDP
  (`Network.getResponseBody`, `securityDetails`) by attaching the debugger before a reload,
  and write them as WARC/WACZ (the archival standard; what ArchiveWeb.page does, with
  [warcio.js](https://github.com/webrecorder/warcio.js)).
- Have the server re-fetch the URL independently (headless browser, or Wayback Save Page Now)
  and store the result alongside the capture as a second witness.
- Summarize or tag `dom.html` with `/v1/chat/completions` and index captures in a
  `/collections` collection for semantic search across cases.
- Export a case as a zip for handing to third parties: the public key and a verification
  script, the images on each page with their EXIF data (from the MHTML), and a printable case
  report.
