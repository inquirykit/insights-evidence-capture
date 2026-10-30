# Privacy and permissions

The extension sends data to these and nothing else:

- **FreeTSA** (`https://freetsa.org/tsr`), with the browser store: the SHA-256 of each record,
  for its trusted timestamp. Nothing else of the capture leaves the profile.
- **Your server**, with the server store: the whole capture (its files, the page, network and
  environment metadata, the note) and your API key, plus the dashboard's reads, tags, notes
  and todos.
- **The captured site**: a single HTML file or an image capture may fetch the page's own
  resources again, from where the page loads them and with the page's cookies, as the page
  itself would.

There is no analytics or telemetry, and no code is loaded from elsewhere: everything the
extension runs is in the build. On Firefox the manifest declares this as `websiteContent` and
`browsingActivity` (`data_collection_permissions`).

| Permission                      | Why                                                                 |
|---------------------------------|---------------------------------------------------------------------|
| `<all_urls>` (host)             | capture whichever page you choose: run the capture code in it and read its response headers; also reaches the server wherever it runs |
| `activeTab`                     | when you limit the extension's site access in Chrome, the shortcut and right-click entries still work on the tab they act on |
| `tabs`                          | the tabs' URLs and titles, for the record and for auto-capture      |
| `scripting`                     | runs the capture code in the page: DOM, Markdown, SingleFile, the region picker, the DOM watcher |
| `storage`                       | settings, the server URL and API key, tag colours and watch terms   |
| `webRequest`                    | response status and headers, server IP and redirects                |
| `contextMenus`                  | the right-click entries                                             |
| `debugger` (Chrome)             | the DevTools protocol, for screenshots beyond the viewport, MHTML and PDF; Chrome shows its debugging bar while it is attached |
| `webRequestBlocking` (Firefox)  | reading the TLS certificate chain with `getSecurityInfo()`          |
