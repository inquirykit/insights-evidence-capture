# Evidence and verification

## Where captures are stored

**Store captures**, first in the popup's connection panel, is a choice for the whole browser
profile; a case lives in one store, and switching shows the other store's cases.

- **In this browser.** Nothing to run. The extension does what the server would: it re-hashes
  every artifact against what the capture declared, builds the same record
  (`evidence-capture/record/v3`, `workspaceId: "browser"`), serializes it as RFC 8785
  canonical JSON, chains it to the previous record, signs it with an Ed25519 key and asks
  FreeTSA for an RFC 3161 token over the record hash. Records, artifacts, tags, notes and todos
  live in the extension's IndexedDB. Enrichment is skipped (`enrichment: {"skipped": true}`):
  there is no enricher to ask. The dashboard, Verify ledger, tags, notes and todos work the same.
- **On a Core AI & Data toolkit server.** See [Server store](server.md): the server signs with
  its own key, enriches, keeps read-only files, and serves every browser that connects.

The browser store needs Ed25519 in WebCrypto: Chrome 137, Firefox 130 or later. The key is
made on first use, non-extractable, and kept in IndexedDB beside the records; it never leaves
the profile. **Verify ledger** offers it as `ed25519.pub.pem`.

What the browser store proves is narrower than the server's. The key lives in the same
profile as the analyst, so a signature shows the record was not changed after it was made,
not that the analyst did not shape it; the trusted timestamp is the independent anchor, and
the chain still catches edits, reordering and deletions. **Verify ledger** checks each token as
`openssl ts -verify` does: the TSA's signature, and its certificate up to FreeTSA's root, which
the extension carries (`lib/freetsa-root.ts`); a token anyone else signed is an error, whatever
hash and time it holds. Revocation is not checked. The data is only as durable as the
profile: *Clear site data*, a removed extension or a lost profile deletes it. Export what
matters: a capture's **Integrity** panel downloads `record.json`, `record.sig` and
`record.tsr`, and its **Files** panel each artifact, in the layout the server uses, so the
OpenSSL commands under [Verifying](#verifying) apply unchanged (with the public key from
**Verify ledger**). A later upload of browser-kept captures to a server is not built yet.

## Evidence model

1. **Hash at the source.** The extension computes the SHA-256 of each artifact in the
   browser, before upload. The server recomputes it and rejects any mismatch.
2. **Enrichment inside the record.** The server looks up the page's server IP, the
   document host and every host in the redirect chain through its enrichers (`/enrich`)
   and stores the results in the record, so what was known about those values at capture
   time is signed with the capture. A failed lookup is recorded as an error, never
   dropped.
3. **Canonical, signed record.** The server wraps the client metadata, the verified
   artifact hashes, the enrichment, the receive time and the previous record's hash into
   one JSON record (`evidence-capture/record/v3`). It serializes the record as RFC 8785
   canonical JSON and signs it with Ed25519.
4. **Hash chain.** Each record contains `prevRecordHash`. Editing, reordering or deleting
   any earlier record breaks the chain.
5. **Trusted timestamp.** The record hash is sent to an RFC 3161 TSA (default: FreeTSA).
   Only the hash leaves the machine. The signed token proves the record existed at that
   time, which rules out back-dating. Set `EVIDENCE_TSA_URL=` (empty) to disable this.
   Records that failed to get a timestamp are retried on a schedule and via
   `POST /evidence/timestamp-pending`.
6. **Ledger plus files.** The chain lives in ai_toolkit's embedded ArcadeDB (types
   `ev_case`, `ev_capture`). Each capture is also stored as a self-contained bundle in
   `EVIDENCE_DIR/captures/<id>/`:
   ```
   artifacts/…      read-only captured files
   record.json      the exact bytes that were hashed and signed
   record.sig       raw Ed25519 signature
   record.tsr       RFC 3161 TimeStampResp
   ```

## Verifying

`GET /evidence/verify` (or **Verify log** on the popup's Recent tab, or the Evidence page of the admin
dashboard) checks the chain, canonical form, signatures, files and TSA imprints. The server
reads a token's imprint only; check who signed it with `openssl ts -verify` below. (For
captures kept in the browser, **Verify ledger** checks that too.)

Independent verification with OpenSSL 3. macOS's `/usr/bin/openssl` is LibreSSL
without Ed25519 support, so use `brew install openssl` for this:

```sh
cd <EVIDENCE_DIR>/captures/<id>
# public key: GET /evidence/public-key, or <EVIDENCE_DIR>/keys/ed25519.pub.pem
openssl pkeyutl -verify -pubin -inkey ed25519.pub.pem -rawin -in record.json -sigfile record.sig
# trusted timestamp (FreeTSA CA: https://freetsa.org/files/cacert.pem + tsa.crt)
openssl ts -verify -data record.json -in record.tsr -CAfile cacert.pem -untrusted tsa.crt
# artifacts
shasum -a 256 artifacts/*        # compare with record.json → artifacts[].sha256
# the MHTML inside page.mhtml.gz: compare with client.artifacts[].uncompressed.sha256
gunzip -c artifacts/page.mhtml.gz | shasum -a 256
```

## What this does and does not prove

- ✅ Nothing has changed since the moment of capture: not the artifacts, the metadata,
  the note, the enrichment, the order of captures, or the capture time.
- ✅ Which tool, version and signing key produced each capture.
- ⚠️ Deleting the **newest** records can't be detected from the chain alone. Record
  `headHash` from `/evidence/verify` somewhere external, or rely on the TSA tokens.
- ❌ Tags, analyst notes and todos are not signed: they are the case's work, kept apart and editable.
- ❌ It cannot prove the page wasn't altered *inside the browser* before capture. DevTools,
  other extensions or the page's own scripts can all change it. Mitigations:
  - **Reload first**, so the capture starts from what the server sent;
  - **Watch DOM changes**, so the record shows what changed, when, and whether anyone typed into
    the page;
  - use a dedicated browser profile with only this extension installed;
  - compare `dom.html` against the recorded response headers and the MHTML;
  - have an independent party re-fetch the page (e.g. the Wayback Machine or a headless
    fetch from the server).

  Proving origin cryptographically needs TLS attestation (e.g. TLSNotary).
