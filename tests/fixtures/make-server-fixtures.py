"""Golden fixtures made with ai_toolkit's own evidence code, so the extension's tests check it
against what the server does, byte for byte, and the server's code checks what the extension makes.

    bun run fixtures        (needs ai_toolkit with its .venv at ../../ai_toolkit, or its path as
                             the argument, and OpenSSL 3)

Writes, next to this file:
  jcs-vectors.json   JSON texts and their RFC 8785 form by the server's canonicalizer (rfc8785)
  server-record/     a v3 record as the server builds and signs it: record.json, record.sig,
                     ed25519.pub.pem, record.tsr (from a throwaway TSA made here: nothing is
                     sent anywhere), its CA and certificate, and expected.json
  server-limits.json the limits the server enforces, read from its source
Then checks browser-record/ (made first by make-browser-record.ts) with the server's rules:
canonical form, hash, signature, the upload check of its client metadata.

The content is placeholder text; the keys are made for the run and the private ones discarded.
"""

import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
OPENSSL = shutil.which("openssl", path="/opt/homebrew/opt/openssl@3/bin:/usr/local/opt/openssl@3/bin") or "openssl"

ai_toolkit = Path(sys.argv[1] if len(sys.argv) > 1 else HERE.parents[3] / "ai_toolkit").resolve()
sys.path.insert(0, str(ai_toolkit))

import rfc8785  # noqa: E402  (from ai_toolkit's environment)

from evidence import record, signing  # noqa: E402
from evidence import tsa as server_tsa  # noqa: E402

# ---------------------------------------------------------------------------
# RFC 8785 vectors: the RFC's own examples plus the cases the records meet

VECTORS = [
    # RFC 8785 3.2.2: literals, numbers and string escapes
    '{"numbers": [333333333.33333329, 1E30, 4.50, 2e-3, 0.000000000000000000000000001],'
    ' "string": "\\u20ac$\\u000F\\u000aA\'\\u0042\\u0022\\u005c\\\\\\"\\/", "literals": [null, true, false]}',
    # RFC 8785 3.2.3: keys sorted by UTF-16 code units, not code points
    '{"\\u20ac": "Euro Sign", "\\r": "Carriage Return", "\\ufb33": "Hebrew Letter Dalet With Dagesh",'
    ' "1": "One", "\\ud83d\\ude00": "Emoji: Grinning Face", "\\u0080": "Control", "\\u00f6": "Latin Small Letter O With Diaeresis"}',
    # Numbers as ECMAScript prints them
    "[0, -0, 1, -1, 0.1, 1.5, 100, 1e21, 1e-7, 1e-6, 9007199254740991, 5e-324, 1.7976931348623157e308]",
    "[1.25, 2.5, 0.30000000000000004, 1234.5678, -0.000001]",
    # An integer past 2^53 written out in full, as JSON.stringify writes those below 1e21: Python
    # reads it as an int, which rfc8785 refuses; the browser's canonicalizer takes it as a number.
    "[9007199254740992]",
    "[100000000000000000000]",
    # Nesting, empty containers, whitespace
    '{ "b" : [ ] , "a" : { } , "c" : [ { "z" : 1 , "y" : [ null ] } ] }',
    # Strings: control characters, non-ASCII, astral
    '["\\u0000\\u001f\\u007f", "tab\\there", "caf\\u00e9 \\u2615", "\\ud83d\\ude00 lorem", "<\\/script>", "\\u2028\\u2029"]',
    # A lone surrogate has no UTF-8 encoding: both canonicalizers refuse it
    '["\\ud800"]',
    '{"\\udc00": 1}',
]


def make_vectors() -> None:
    out = []
    for text in VECTORS:
        try:
            out.append({"input": text, "canonical": rfc8785.dumps(json.loads(text)).decode("utf-8")})
        except Exception as e:  # what rfc8785 can't encode
            out.append({"input": text, "canonical": None, "refused": type(e).__name__})
    (HERE / "jcs-vectors.json").write_text(json.dumps(out, indent=1, ensure_ascii=False) + "\n")


# ---------------------------------------------------------------------------
# A record as the server makes it

DOM = '<!DOCTYPE html>\n<html><head><title>Lorem ipsum</title></head><body><h1>Lorem ipsum</h1>' \
      '<p>Dolor sit amet, info@example.com, https://example.com/page</p></body></html>'.encode()

CLIENT = {
    "schema": "evidence-capture/client/v1",
    "caseId": "inbox",
    "note": "Lorem ipsum \U0001F600 café",
    "trigger": "popup",
    "options": {"depth": "basic", "screenshot": "none", "mhtml": False, "singlefile": False, "pdf": False,
                "markdown": False, "autoScroll": 0, "reload": False, "monitorDom": False},
    "startedAt": "2026-10-25T12:00:00.000Z",
    "finishedAt": "2026-10-25T12:00:00.250Z",
    "page": {"tabUrl": "https://example.com/page", "documentUrl": "https://example.com/page",
             "title": "Lorem ipsum", "characterSet": "UTF-8", "contentType": "text/html",
             "lastModified": "10/25/2026 12:00:00", "referrer": "",
             "viewport": {"width": 1280, "height": 800}, "scrollPosition": {"x": 0, "y": 0},
             "scrollSize": {"width": 1280, "height": 2400}, "devicePixelRatio": 1.25},
    "network": {"mainFrame": None},
    "environment": {"userAgent": "Mozilla/5.0 (placeholder)", "browser": {"name": "chromium"},
                    "platform": {"os": "mac", "arch": "arm64"}, "timeZone": "UTC",
                    "extension": {"id": "eiejpgpjkcmacpbaoekojmdmbliaiifd", "version": "0.1.0"}},
    "warnings": [],
    "artifacts": [{"name": "dom.html", "sha256": hashlib.sha256(DOM).hexdigest(), "size": len(DOM),
                   "mediaType": "text/html;charset=utf-8", "capturedAt": "2026-10-25T12:00:00.200Z",
                   "method": "scripting.executeScript:document.documentElement.outerHTML"}],
}

ENRICHMENT = {
    "startedAt": "2026-10-25T12:00:00.300Z",
    "finishedAt": "2026-10-25T12:00:00.400Z",
    "items": [{"value": "example.com", "type": "domain",
               "results": {"merged": {"asn": 64500, "score": 0.1, "country": "ZZ"}, "results": []}}],
}

TSA_CONFIG = """
[ tsa ]
default_tsa = tsa1
[ tsa1 ]
serial = {serial}
default_policy = 1.2.3.4.1
digests = sha256
accuracy = secs:1
ordering = no
tsa_name = no
ess_cert_id_alg = sha256
signer_digest = sha256
"""


def openssl(*args: str, cwd: Path) -> None:
    subprocess.run([OPENSSL, *args], cwd=cwd, check=True, capture_output=True)


def make_server_record() -> None:
    out = HERE / "server-record"
    if out.exists():
        shutil.rmtree(out)
    out.mkdir()
    with tempfile.TemporaryDirectory() as tmp_name:
        tmp = Path(tmp_name)
        signer = signing.Signer(tmp / "keys" / "ed25519.pem")
        artifacts = record.verify_uploads(CLIENT, {"dom.html": DOM})
        rec = record.build_record(
            seq=1, capture_id="00000000-0000-4000-8000-000000000001", workspace_id=record.DEFAULT_WORKSPACE_ID,
            case_id="inbox", received_at="2026-10-25T12:00:00.500Z", prev_hash=record.GENESIS_HASH,
            version="fixture", signing_key_sha256=signer.fingerprint, artifacts=artifacts, client=CLIENT,
            enrichment=ENRICHMENT,
        )
        data = record.canonical(rec)
        (out / "record.json").write_bytes(data)
        (out / "record.sig").write_bytes(signer.sign(data))
        (out / "ed25519.pub.pem").write_text(signer.public_pem)

        # A CA and a TSA certificate under it, then a token over the record, as FreeTSA would give.
        (tmp / "serial").write_text("01\n")
        (tmp / "tsa.cnf").write_text(TSA_CONFIG.format(serial=tmp / "serial"))
        (tmp / "tsa.ext").write_text("basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\n"
                                     "extendedKeyUsage=critical,timeStamping\n")
        openssl("req", "-x509", "-newkey", "ed25519", "-nodes", "-keyout", "ca.key", "-out", "ca.pem",
                "-days", "36500", "-subj", "/CN=Fixture CA", cwd=tmp)
        openssl("req", "-newkey", "rsa:2048", "-nodes", "-keyout", "tsa.key", "-out", "tsa.csr",
                "-subj", "/CN=Fixture TSA", cwd=tmp)
        openssl("x509", "-req", "-in", "tsa.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial",
                "-days", "36500", "-extfile", "tsa.ext", "-out", "tsa.pem", cwd=tmp)
        (tmp / "record.json").write_bytes(data)
        openssl("ts", "-query", "-data", "record.json", "-sha256", "-cert", "-out", "request.tsq", cwd=tmp)
        openssl("ts", "-reply", "-config", "tsa.cnf", "-queryfile", "request.tsq", "-inkey", "tsa.key",
                "-signer", "tsa.pem", "-out", "record.tsr", cwd=tmp)
        openssl("ts", "-verify", "-data", "record.json", "-in", "record.tsr", "-CAfile", "ca.pem",
                "-untrusted", "tsa.pem", cwd=tmp)
        for name in ("record.tsr", "ca.pem", "tsa.pem"):
            shutil.copy(tmp / name, out / ("tsa-ca.pem" if name == "ca.pem" else "tsa-cert.pem" if name == "tsa.pem" else name))

        digest = hashlib.sha256(data).digest()
        info = server_tsa.inspect((out / "record.tsr").read_bytes(), digest)
        expected = {
            "schema": record.SCHEMA,
            "recordHash": digest.hex(),
            "signingKeySha256": signer.fingerprint,
            "genTime": info.gen_time,
        }
        (out / "expected.json").write_text(json.dumps(expected, indent=1) + "\n")


# ---------------------------------------------------------------------------
# The server's limits, which lib/limits.ts keeps too: read from the source, as importing the routes
# would load the whole app's configuration

LIMITS = ("MAX_CASE_NAME", "MAX_TAG", "MAX_TAGS", "MAX_NOTE", "MAX_NOTES", "MAX_TODO", "MAX_TODOS", "MAX_ARTIFACT_NAME")


def write_limits() -> None:
    import ast

    found = {}
    for path in (ai_toolkit / "api" / "evidence_routes.py", ai_toolkit / "evidence" / "record.py"):
        for node in ast.parse(path.read_text()).body:
            if not isinstance(node, ast.Assign):
                continue
            target = node.targets[0]
            names = target.elts if isinstance(target, ast.Tuple) else [target]
            values = node.value.elts if isinstance(node.value, ast.Tuple) else [node.value]
            for name, value in zip(names, values):
                if isinstance(name, ast.Name) and name.id in LIMITS and isinstance(value, ast.Constant):
                    found[name.id] = value.value
    missing = [n for n in LIMITS if n not in found]
    if missing:
        raise SystemExit(f"limits not found in the server's source: {missing}")
    (HERE / "server-limits.json").write_text(json.dumps({n: found[n] for n in LIMITS}, indent=1) + "\n")


# ---------------------------------------------------------------------------
# What the browser store made, by the server's rules

def check_browser_record() -> list:
    where = HERE / "browser-record"
    if not where.exists():
        return ["browser-record/ is missing: run make-browser-record.ts first"]
    problems = []
    data = (where / "record.json").read_bytes()
    rec = json.loads(data)
    key = signing.load_public_key((where / "ed25519.pub.pem").read_text())
    if not record.is_canonical(data):
        problems.append("record.json is not RFC 8785 canonical by the server's canonicalizer")
    if not signing.verify(key, data, (where / "record.sig").read_bytes().hex()):
        problems.append("record.sig does not verify with the server's code")
    if rec["service"]["signingKeySha256"] != signing.fingerprint(key):
        problems.append("signingKeySha256 is not the server's fingerprint of the key")
    if rec["schema"] != record.SCHEMA:
        problems.append(f"schema {rec['schema']} is not the server's {record.SCHEMA}")
    files = {p.name: p.read_bytes() for p in (where / "artifacts").iterdir()}
    try:
        verified = record.verify_uploads(rec["client"], files)
        if [a.entry() for a in verified] != rec["artifacts"]:
            problems.append("the record's artifacts differ from what the server would list")
    except Exception as e:
        problems.append(f"the server would refuse its upload: {e}")
    return problems


if __name__ == "__main__":
    make_vectors()
    make_server_record()
    write_limits()
    problems = check_browser_record()
    for p in problems:
        print("FAIL", p)
    print("server fixtures written;", "browser record FAILED" if problems else "browser record passes the server's checks")
    sys.exit(1 if problems else 0)
