# Server store

With the server store, the extension uploads each capture to an
[ai_toolkit](https://github.com/inquirykit/core-ai-data-toolkit) server (a separate project),
which signs it with its own key, enriches it and keeps it on disk for every browser that
connects.

```
┌──────────────── browser ────────────────┐        ┌──────────── ai_toolkit (FastAPI) ─────────────┐
│ popup / Alt+Shift+S                     │        │ /evidence/*                                   │
│   │                                     │  HTTP  │  • re-hash every upload, reject mismatches    │
│ background                              │───────▶│  • enrich IPs/domains (/enrich) into the record│
│   • screenshot (+ MHTML on Chrome)      │ bearer │  • RFC 8785 canonical record                  │
│   • live DOM, headers, redirects, TLS   │ API_KEY│  • hash chain (prevRecordHash)                │
│   • SHA-256 of every artifact           │        │  • Ed25519 signature                          │
│                                         │        │  • RFC 3161 trusted timestamp                 │
│ settings: server URL + API key          │        │  • ArcadeDB ledger + read-only files          │
└─────────────────────────────────────────┘        │  • admin dashboard: Evidence page             │
                                                   └───────────────────────────────────────────────┘
```

## Running a server

```sh
# in an ai_toolkit checkout, with evidence enabled (see its README for install)
# .env: API_KEY=<secret>  ARCADEDB_PATH=data/arcadedb  (EVIDENCE_* settings optional)
make run                              # http://localhost:8000
```

Then choose **On a Core AI & Data toolkit server** in the popup's connection panel, with the
server's URL and its `API_KEY`.

## Connection and security

- The extension stores the server URL and API key in extension storage. Only extension
  contexts talk to the server: the background script, and the dashboard page for captured
  files (binary bodies can't cross runtime messaging). The key never reaches a web page.
- Every request carries `Authorization: Bearer <API_KEY>`. Set `API_KEY` in ai_toolkit's
  `.env`; without it any local process can use the server.
- The `/evidence` routes refuse any request whose `Origin` is a web page: only
  `chrome-extension://` and `moz-extension://` origins are accepted. To pin them to your
  exact extension, set `EVIDENCE_ALLOWED_ORIGINS`. Firefox origins use a random
  per-install UUID; `bun run dev` pins the Chrome ID to `eiejpgpjkcmacpbaoekojmdmbliaiifd`
  with the dev `key` in `wxt.config.ts`. Production builds leave the key out, as the Web Store
  requires, so an unpacked production build has an ID of its own (see `chrome://extensions`).
  The dev key is public, so anyone can build an extension with that ID: the pin narrows
  origins, it does not authenticate them.
- Keep ai_toolkit bound to `HOST=127.0.0.1` unless it must be reachable from other
  machines; then use HTTPS in front of it, since the key travels in a header.
- The signing key is a PEM file (`EVIDENCE_KEY_FILE`, `0600`). For real casework, move it
  to the macOS Keychain, a TPM/Secure Enclave or a hardware token.

## Server settings (ai_toolkit `.env`)

| Variable                   | Default                   | Purpose                                         |
|----------------------------|---------------------------|-------------------------------------------------|
| `API_KEY`                  | unset                     | required by the extension (as a bearer token)   |
| `ARCADEDB_PATH`            | `data/arcadedb`           | must be set; evidence is stored in this database|
| `EVIDENCE_DIR`             | `data/evidence`           | capture bundles and keys                        |
| `EVIDENCE_TSA_URL`         | `https://freetsa.org/tsr` | RFC 3161 TSA; empty disables                    |
| `EVIDENCE_KEY_FILE`        | `<EVIDENCE_DIR>/keys/ed25519.pem` | Ed25519 signing key, generated on first use |
| `EVIDENCE_ALLOWED_ORIGINS` | empty                     | exact extension origins; empty = any extension  |
| `EVIDENCE_ENRICH`          | `true`                    | run enrichers on capture                        |
| `EVIDENCE_ENRICH_TIMEOUT`  | `20`                      | seconds for all enrichment of one capture       |

## API

All routes need `Authorization: Bearer <API_KEY>`. Errors are `{ "error": "…" }`.

| Method | Path                                      | Purpose                                              |
|--------|-------------------------------------------|------------------------------------------------------|
| GET    | `/health`                                 | liveness (no key)                                    |
| GET    | `/evidence/cases`                         | list cases (`inbox` always exists)                   |
| POST   | `/evidence/cases`                         | `{ "name": "…" }`                                    |
| GET    | `/evidence/cases/{id}/captures`           | capture summaries, newest first                      |
| POST   | `/evidence/captures`                      | multipart: `metadata` JSON + one `file` per artifact |
| GET    | `/evidence/captures/{id}`                 | full signed record + timestamp status                |
| GET    | `/evidence/captures/{id}/artifacts/{name}`| a captured file                                      |
| GET    | `/evidence/cases/{id}/annotations`        | tags and notes of the case's captures that have any  |
| PUT    | `/evidence/captures/{id}/annotations`     | `{tags?, notes?}`: replace either list (not signed)  |
| GET    | `/evidence/cases/{id}/todos`              | the case's to-do list                                |
| PUT    | `/evidence/cases/{id}/todos`              | `{todos: [{id?, text, done}]}`: replace it (not signed) |
| GET    | `/evidence/verify`                        | chain / signature / file / TSA report                |
| GET    | `/evidence/public-key`                    | Ed25519 public key (PEM)                             |
| POST   | `/evidence/timestamp-pending`             | retry missing TSA tokens (admin key)                 |
