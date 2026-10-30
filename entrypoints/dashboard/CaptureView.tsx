import { ArrowLeft, ChevronLeft, ChevronRight, Clock, ExternalLink, ShieldCheck } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';

import { TagInput, useTagDefs } from '@/components/tags';
import { routeHash, type DashboardRoute } from '@/lib/dashboard';
import type { DomChange, MutationCounts } from '@/lib/page/dom-monitor';
import {
  errorMessage,
  mergeTags,
  type AnnotationChange,
  type CaptureDetail,
  type ClientMetadata,
} from '@/lib/protocol';
import { SELECTOR_KINDS, watchHits } from '@/lib/selectors';
import { readArtifact } from '@/lib/store';
import { rememberTags } from '@/lib/tags';

import { findScreenshot, loadCapture, loadScan, type CaseData } from './data';
import { enrichmentLine } from './SitesView';
import { downloadArtifact, downloadRecordBundle, fmtBytes, fmtTime, Hash, openArtifact, opensAsIs, plural } from './ui';

const TRIGGERS: Record<NonNullable<ClientMetadata['trigger']>, string> = {
  popup: 'the popup',
  shortcut: 'the keyboard shortcut',
  contextMenu: 'the context menu',
  auto: 'auto-capture',
};

type CaptureRoute = Extract<DashboardRoute, { view: 'capture' }>;

export default function CaptureView({
  route,
  data,
  watchTerms,
}: {
  route: CaptureRoute;
  data: CaseData;
  watchTerms: string[];
}) {
  const [detail, setDetail] = useState<CaptureDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    loadCapture(route.captureId).then(
      (d) => live && setDetail(d),
      (e) => live && setError(errorMessage(e)),
    );
    return () => {
      live = false;
    };
  }, [route.captureId]);

  // Newer / older within the case, as its list orders them (newest first).
  const list = data.captures ?? [];
  const index = list.findIndex((c) => c.captureId === route.captureId);
  const newer = index > 0 ? list[index - 1] : undefined;
  const older = index >= 0 ? list[index + 1] : undefined;
  const back = routeHash({ caseId: route.caseId, view: 'pages' });
  const to = (captureId?: string) =>
    captureId && routeHash({ caseId: route.caseId, view: 'capture', captureId });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      const target =
        e.key === 'ArrowLeft'
          ? to(newer?.captureId)
          : e.key === 'ArrowRight'
            ? to(older?.captureId)
            : e.key === 'Escape'
              ? back
              : undefined;
      if (target) location.hash = target;
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  });

  const client = detail?.record.client;
  const title = client?.page?.title || client?.page?.documentUrl || route.captureId;

  return (
    <div className="capture">
      <div className="capture-bar">
        <a href={back}>
          <ArrowLeft /> All pages
        </a>
        <div className="capture-nav">
          <a href={to(newer?.captureId) || undefined} aria-disabled={!newer} title="Newer (←)">
            <ChevronLeft /> Newer
          </a>
          {index >= 0 && (
            <span className="muted">
              {index + 1} of {list.length}
            </span>
          )}
          <a href={to(older?.captureId) || undefined} aria-disabled={!older} title="Older (→)">
            Older <ChevronRight />
          </a>
        </div>
      </div>

      {error ? (
        <p className="error">{error}</p>
      ) : !detail ? (
        <p className="muted">Loading capture…</p>
      ) : (
        <>
          <header className="capture-header">
            <h1>{title}</h1>
            {client?.page?.documentUrl && (
              <a
                className="capture-url"
                href={client.page.documentUrl}
                target="_blank"
                rel="noreferrer noopener"
                title="Opens the live page"
              >
                {client.page.documentUrl} <ExternalLink />
              </a>
            )}
          </header>
          <div className="capture-body">
            <Screenshot detail={detail} />
            <div className="panels">
              <AnnotationsPanel captureId={route.captureId} data={data} />
              <PagePanel detail={detail} />
              <SelectionPanel detail={detail} />
              <SelectorsPanel detail={detail} data={data} watchTerms={watchTerms} />
              <PageChangesPanel detail={detail} />
              <IntegrityPanel detail={detail} />
              <FilesPanel detail={detail} />
              <NetworkPanel detail={detail} />
              <EnrichmentPanel detail={detail} />
              <EnvironmentPanel detail={detail} />
              <Panel title="Signed record" closed>
                <pre className="raw">{JSON.stringify(detail.record, null, 2)}</pre>
              </Panel>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function Screenshot({ detail }: { detail: CaptureDetail }) {
  const { captureId } = detail.record;
  const name = findScreenshot(detail.record)?.name;
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!name) return;
    let live = true;
    let created: string | null = null;
    readArtifact(captureId, name).then(
      (blob) => {
        if (!live) return;
        created = URL.createObjectURL(blob);
        setUrl(created);
      },
      (e) => live && setError(errorMessage(e)),
    );
    return () => {
      live = false;
      if (created) URL.revokeObjectURL(created);
    };
  }, [captureId, name]);

  return (
    <div className="shot">
      {!name ? (
        <p className="muted">No screenshot in this capture.</p>
      ) : error ? (
        <p className="error">{error}</p>
      ) : url ? (
        <a href={url} target="_blank" rel="noopener" title="Open full size">
          <img src={url} alt={`Screenshot as captured (${detail.record.client.options?.screenshot ?? 'full'})`} />
        </a>
      ) : (
        <p className="muted">Loading screenshot…</p>
      )}
    </div>
  );
}

function Panel({ title, children, closed }: { title: string; children: ReactNode; closed?: boolean }) {
  return (
    <details className="panel" open={!closed}>
      <summary>{title}</summary>
      <div className="panel-body">{children}</div>
    </details>
  );
}

function Fields({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="fields">
      {rows
        .filter(([, v]) => v != null && v !== '' && v !== false)
        .map(([k, v]) => (
          <div key={k} className="field">
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
    </dl>
  );
}

/** Tags and analyst notes: the case's own, editable, kept by the server beside the signed record. */
function AnnotationsPanel({ captureId, data }: { captureId: string; data: CaseData }) {
  // Editable only once the case's annotations and captures have loaded: a save replaces the
  // capture's lists, so one sent earlier would delete what has not been shown yet.
  const loaded = data.annotations !== null && data.captures !== null;
  const inCase = data.captures?.some((c) => c.captureId === captureId) ?? true;
  const annotation = data.annotations?.get(captureId);
  const tags = annotation?.tags ?? [];
  const notes = annotation?.notes ?? [];
  const [defs] = useTagDefs();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (change: AnnotationChange) => {
    setBusy(true);
    setError(null);
    try {
      await data.saveAnnotation(captureId, change);
      return true;
    } catch (e) {
      setError(errorMessage(e));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const kept = (except?: string) => notes.filter((n) => n.id !== except).map(({ id, text }) => ({ id, text }));

  // The case's tags are offered as well as the known ones.
  const caseTags = useMemo(
    () => mergeTags([], [...(data.annotations?.values() ?? [])].flatMap((a) => a.tags)),
    [data.annotations],
  );
  const saveTags = async (next: string[]) => {
    const saved = await save({ tags: next });
    if (saved) void rememberTags(next);
    return saved;
  };
  const addNote = async () => {
    const text = note.trim();
    if (text && (await save({ notes: [...kept(), { text }] }))) setNote('');
  };
  const deleteNote = (id: string) => {
    if (confirm('Delete this note? It cannot be brought back.')) void save({ notes: kept(id) });
  };

  if (data.annotationsError)
    return (
      <Panel title="Tags & notes">
        <p className="warn small">Unavailable: {data.annotationsError}</p>
      </Panel>
    );
  if (!inCase)
    return (
      <Panel title="Tags & notes">
        <p className="muted small">
          This capture belongs to another case. Open it there to see and change its tags and notes.
        </p>
      </Panel>
    );
  const count = tags.length + notes.length;
  return (
    <Panel title={`Tags & notes${count ? ` · ${count}` : ''}`}>
      <TagInput
        tags={tags}
        defs={defs}
        suggestions={caseTags}
        placeholder={loaded ? 'Add tags, comma-separated' : 'Loading…'}
        disabled={busy || !loaded}
        onChange={saveTags}
      />
      {notes.length > 0 && (
        <ul className="notes">
          {notes.map((n) => (
            <li key={n.id}>
              <div className="note-text">{n.text}</div>
              <div className="muted small">
                {fmtTime(n.createdAt)}
                {n.updatedAt && ` · edited ${fmtTime(n.updatedAt)}`} ·{' '}
                <button className="link" disabled={busy || !loaded} onClick={() => deleteNote(n.id)}>
                  delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <textarea
        className="note-input"
        rows={2}
        placeholder="Add a note…"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && (e.metaKey || e.ctrlKey) && void addNote()}
      />
      <div className="note-bar">
        <span className="muted small">Kept beside the signed record, not in it: yours to change.</span>
        <button onClick={() => void addNote()} disabled={busy || !loaded || !note.trim()} title="⌘/Ctrl + Enter">
          Add note
        </button>
      </div>
      {error && <p className="error small">{error}</p>}
    </Panel>
  );
}

function PagePanel({ detail }: { detail: CaptureDetail }) {
  const { client, receivedAt } = detail.record;
  const page = client.page ?? {};
  const warnings = client.warnings ?? [];
  const { reload, scroll } = client;
  return (
    <Panel title="Page">
      {client.note && <blockquote className="note">{client.note}</blockquote>}
      <Fields
        rows={[
          ['Captured', client.finishedAt && `${fmtTime(client.startedAt)} → ${fmtTime(client.finishedAt)}`],
          ['Received', fmtTime(receivedAt)],
          ['Started by', client.trigger && TRIGGERS[client.trigger]],
          [
            'Reloaded',
            reload &&
              (reload.loadedAt
                ? `${fmtTime(reload.requestedAt)}; loaded again ${fmtTime(reload.loadedAt)}`
                : `${fmtTime(reload.requestedAt)}; still loading when captured`),
          ],
          [
            'Auto-scroll',
            scroll &&
              `${plural(scroll.steps, 'step')} in ${(scroll.durationMs / 1000).toFixed(1)} s, ` +
                `${scroll.reachedEnd ? 'to the end' : 'stopped at the time limit'}; ` +
                `${scroll.heightBefore.toLocaleString()} → ${scroll.heightAfter.toLocaleString()} px tall` +
                (scroll.scroller !== 'document' ? ` (${scroll.scroller})` : ''),
          ],
          ['Depth', client.options?.depth?.replace(/^./, (c) => c.toUpperCase())],
          ['Tab URL', page.tabUrl !== page.documentUrl ? page.tabUrl : null],
          ['Referrer', page.referrer],
          ['Content type', page.contentType && `${page.contentType}; ${page.characterSet ?? ''}`],
          ['Last modified', page.lastModified],
        ]}
      />
      {warnings.length > 0 && (
        <ul className="warnings">
          {warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

/** What the user pointed at: a dragged region, a clicked element, selected text or an image. */
function SelectionPanel({ detail }: { detail: CaptureDetail }) {
  const { client } = detail.record;
  const sel = client.selection;
  const scope = client.options?.screenshot;
  if (!sel && (!scope || scope === 'full' || scope === 'none')) return null;
  const rect = sel && 'rect' in sel && sel.rect ? sel.rect : undefined;
  const kind = sel?.kind ?? 'visible viewport';
  return (
    <Panel title={`Selection · ${kind}`}>
      <Fields
        rows={[
          ['Screenshot', scope && `${scope}${client.trigger ? ` · via ${client.trigger}` : ''}`],
          ['Rectangle', rect && `${rect.width} × ${rect.height} px at ${rect.x}, ${rect.y} (CSS px, from the page's top-left)`],
          ['Element', sel?.kind === 'element' && <code>{sel.selector}</code>],
          ['XPath', (sel?.kind === 'element' || sel?.kind === 'text') && <code>{sel.xpath}</code>],
          ['Frame', sel && 'frameId' in sel && sel.frameId !== 0 ? `frame ${sel.frameId}` : null],
          ['Image URL', sel?.kind === 'image' && <code className="break">{sel.srcUrl}</code>],
        ]}
      />
      {(sel?.kind === 'text' || sel?.kind === 'element') && sel.text && (
        <blockquote className="note">{sel.text.length > 600 ? `${sel.text.slice(0, 600)}…` : sel.text}</blockquote>
      )}
    </Panel>
  );
}

function SelectorsPanel({
  detail,
  data,
  watchTerms,
}: {
  detail: CaptureDetail;
  data: CaseData;
  watchTerms: string[];
}) {
  const { captureId } = detail.record;
  const [scan, setScan] = useState(() => data.scans.get(captureId));
  const [error, setError] = useState<string | null>(null);

  // The case indexes its pages in the background; a capture opened from elsewhere is scanned here.
  useEffect(() => {
    if (scan) return;
    let live = true;
    loadScan(captureId).then(
      (s) => live && setScan(s),
      (e) => live && setError(errorMessage(e)),
    );
    return () => {
      live = false;
    };
  }, [scan, captureId]);

  if (error)
    return (
      <Panel title="Selectors">
        <p className="error">{error}</p>
      </Panel>
    );
  if (!scan)
    return (
      <Panel title="Selectors">
        <p className="muted">Scanning page…</p>
      </Panel>
    );

  const hits = [...watchHits(scan, watchTerms), ...scan.hits];
  return (
    <Panel title={`Selectors · ${hits.length}`}>
      {hits.length === 0 && <p className="muted">Nothing found on this page.</p>}
      {SELECTOR_KINDS.map(({ kind, label }) => {
        const values = hits.filter((h) => h.kind === kind).map((h) => h.value);
        if (!values.length) return null;
        return (
          <div key={kind} className="selector-group">
            <div className="selector-kind">
              {label} <span className="muted">{values.length}</span>
            </div>
            <div className="chips">
              {values.map((v) => (
                <span
                  key={v}
                  className={`chip kind-${kind}`}
                  title="Click to copy"
                  onClick={() => navigator.clipboard.writeText(v)}
                >
                  {v}
                </span>
              ))}
            </div>
          </div>
        );
      })}
    </Panel>
  );
}

// The latest changes shown here; dom-changes.json has every one the watcher kept.
const SHOWN_CHANGES = 12;

const describeCounts = (c: MutationCounts) =>
  c.records === 0
    ? 'none'
    : `${c.records.toLocaleString()}: ${c.childList.toLocaleString()} structure, ` +
      `${c.characterData.toLocaleString()} text, ${c.attributes.toLocaleString()} attribute ` +
      `(+${c.nodesAdded.toLocaleString()} / −${c.nodesRemoved.toLocaleString()} nodes)`;

function describeChange(c: DomChange): string {
  if (c.type === 'attributes') return `${c.attribute}: ${c.oldValue ?? '∅'} → ${c.value ?? '∅'}`;
  if (c.type === 'characterData') return `"${c.oldValue ?? ''}" → "${c.value ?? ''}"`;
  return [
    c.added ? `+${c.added}${c.addedText ? ` "${c.addedText}"` : ''}` : '',
    c.removed ? `−${c.removed}${c.removedText ? ` "${c.removedText}"` : ''}` : '',
  ]
    .filter(Boolean)
    .join(' ');
}

/** What the DOM watcher saw (lib/page/dom-monitor.ts), when the capture watched the page. */
function PageChangesPanel({ detail }: { detail: CaptureDetail }) {
  const { record } = detail;
  const report = record.client.domMonitor;
  const logged = record.artifacts.some((a) => a.name === 'dom-changes.json');
  const [changes, setChanges] = useState<DomChange[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!report || !logged) return;
    let live = true;
    readArtifact(record.captureId, 'dom-changes.json')
      .then(async (blob) => (JSON.parse(await blob.text()) as { changes?: DomChange[] }).changes ?? [])
      .then(
        (list) => live && setChanges(list),
        (e) => live && setError(errorMessage(e)),
      );
    return () => {
      live = false;
    };
  }, [report, logged, record.captureId]);

  if (!report) return null;
  const during = report.duringCapture.records;
  const latest = (changes ?? []).slice(-SHOWN_CHANGES).reverse();
  return (
    <Panel title={`Page changes${during ? ` · ${during.toLocaleString()} during capture` : ''}`}>
      <Fields
        rows={[
          [
            'Watched since',
            `${report.since === 'documentStart' ? 'the page started loading' : 'the capture began'}, ${fmtTime(report.startedAt)}`,
          ],
          ['While loading', report.since === 'documentStart' ? describeCounts(report.whileLoading) : null],
          ['Before capture', describeCounts(report.beforeCapture)],
          ['During capture', <span className={during ? 'warn' : 'ok'}>{describeCounts(report.duringCapture)}</span>],
          ['Last change', report.lastChangeAt && fmtTime(report.lastChangeAt)],
          ['Typed edits', report.userEdits ? <span className="warn">{report.userEdits.toLocaleString()}</span> : 'none'],
          ['Design mode', report.designMode ? <span className="warn">on: all of the page's text was editable</span> : null],
          ['Editable elements', report.editableElements ? report.editableElements.toLocaleString() : null],
        ]}
      />
      <p className="muted small">
        A change made by the page's scripts, another extension or DevTools looks the same here; typed edits are
        the ones a person made in the page.
      </p>
      {error && <p className="error small">{error}</p>}
      {latest.length > 0 && (
        <>
          <h3>Latest changes</h3>
          <table className="table compact changes">
            <tbody>
              {latest.map((c, i) => (
                <tr key={i}>
                  <td className="nowrap muted tnum">{new Date(c.at).toLocaleTimeString(undefined, { hour12: false })}</td>
                  <td>
                    <span className={`badge ${c.phase === 'during' ? 'badge-warn' : ''}`}>{c.phase}</span>
                  </td>
                  <td>
                    <code className="break">{c.target}</code>
                    <div className="small change-detail">{describeChange(c)}</div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted small">
            The latest {latest.length} of {report.logged.toLocaleString()} kept in dom-changes.json
            {report.dropped > 0 && `; ${report.dropped.toLocaleString()} older ones were let go`}.
          </p>
        </>
      )}
    </Panel>
  );
}

function IntegrityPanel({ detail }: { detail: CaptureDetail }) {
  const { record, timestamp } = detail;
  return (
    <Panel title="Integrity">
      <Fields
        rows={[
          [
            'Record',
            <>
              #{record.seq} · <span className="muted">{record.schema}</span>
            </>,
          ],
          ['Record hash', <Hash value={detail.recordHash} />],
          ['Previous record', <Hash value={record.prevRecordHash} />],
          ['Signature', <Hash value={detail.signature} />],
          ['Signing key', <Hash value={record.service.signingKeySha256} />],
          [
            'Trusted timestamp',
            timestamp.genTime ? (
              <span className="ok">
                <ShieldCheck /> {fmtTime(timestamp.genTime)}
              </span>
            ) : (
              <span className="warn">
                <Clock /> {timestamp.error ?? 'not yet'}
              </span>
            ),
          ],
          ['Service', `${record.service.name} ${record.service.version}`],
          [
            'Bundle',
            <button className="link" onClick={() => downloadRecordBundle(detail)}>
              download record.json, record.sig{timestamp.token ? ', record.tsr' : ''}
            </button>,
          ],
        ]}
      />
    </Panel>
  );
}

function FilesPanel({ detail }: { detail: CaptureDetail }) {
  const { record } = detail;
  const [error, setError] = useState<string | null>(null);
  const run = (p: Promise<void>) => p.catch((e) => setError(errorMessage(e)));
  const declared = new Map((record.client.artifacts ?? []).map((a) => [a.name, a]));
  return (
    <Panel title={`Files · ${record.artifacts.length}`}>
      {error && <p className="error">{error}</p>}
      <table className="table compact">
        <tbody>
          {record.artifacts.map((a) => {
            // A gzipped file also shows what it decompresses to, as the record declares it.
            const { method, uncompressed } = declared.get(a.name) ?? {};
            return (
              <tr key={a.name}>
                <td title={method ?? ''}>
                  <code>{a.name}</code>
                  {uncompressed && <div className="muted small">gunzipped</div>}
                </td>
                <td className="num nowrap muted">
                  {fmtBytes(a.size)}
                  {uncompressed && <div className="small">{fmtBytes(uncompressed.size)}</div>}
                </td>
                <td>
                  <Hash value={a.sha256} chars={8} />
                  {uncompressed && (
                    <div>
                      <Hash value={uncompressed.sha256} chars={8} />
                    </div>
                  )}
                </td>
                <td className="nowrap">
                  {/* MHTML, gzipped or not, is download only */}
                  {!a.name.startsWith('page.mhtml') && (
                    <>
                      <button
                        className="link"
                        onClick={() => run(openArtifact(record.captureId, a.name, a.mediaType))}
                      >
                        {opensAsIs(a.mediaType) ? 'open' : 'view source'}
                      </button>
                      {' · '}
                    </>
                  )}
                  <button className="link" onClick={() => run(downloadArtifact(record, a.name))}>
                    download
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Panel>
  );
}

function NetworkPanel({ detail }: { detail: CaptureDetail }) {
  const main = detail.record.client.network?.mainFrame;
  if (!main)
    return (
      <Panel title="Network">
        <p className="muted">No document response was recorded.</p>
      </Panel>
    );
  return (
    <Panel title="Network">
      <Fields
        rows={[
          ['Status', main.statusLine ?? main.statusCode],
          ['Server IP', main.ip && <code>{main.ip}</code>],
          ['From cache', main.fromCache ? 'yes' : null],
          ['Observed', fmtTime(main.observedAt)],
        ]}
      />
      {main.redirects.length > 0 && (
        <>
          <h3>Redirects</h3>
          <ol className="redirects">
            {main.redirects.map((r, i) => (
              <li key={i}>
                <span className="badge">{r.statusCode}</span> <span className="url">{r.from}</span> →{' '}
                <span className="url">{r.to}</span>
              </li>
            ))}
          </ol>
        </>
      )}
      {main.tls && (
        <>
          <h3>TLS</h3>
          <Fields
            rows={[
              ['State', main.tls.state],
              ['Protocol', main.tls.protocolVersion],
              ['Cipher', main.tls.cipherSuite],
              ['CT', main.tls.certificateTransparencyStatus],
              ['HSTS', main.tls.hsts == null ? null : main.tls.hsts ? 'yes' : 'no'],
            ]}
          />
          <ol className="certs">
            {main.tls.certificates.map((c) => (
              <li key={c.sha256Fingerprint}>
                <div>{c.subject}</div>
                <div className="muted small">
                  issued by {c.issuer} · {c.notBefore.slice(0, 10)} → {c.notAfter.slice(0, 10)}
                </div>
              </li>
            ))}
          </ol>
        </>
      )}
      {(main.responseHeaders?.length ?? 0) > 0 && (
        <details>
          <summary>Response headers · {main.responseHeaders!.length}</summary>
          <table className="table compact headers">
            <tbody>
              {main.responseHeaders!.map((h, i) => (
                <tr key={i}>
                  <td className="nowrap">
                    <code>{h.name}</code>
                  </td>
                  <td className="url">{h.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </Panel>
  );
}

function EnrichmentPanel({ detail }: { detail: CaptureDetail }) {
  const { enrichment } = detail.record;
  if (!('items' in enrichment)) return null;
  return (
    <Panel title={`Enrichment · ${enrichment.items.length}`}>
      {enrichment.items.length === 0 && <p className="muted">Nothing was looked up.</p>}
      <ul className="enrichment-list">
        {enrichment.items.map((item) => (
          <li key={`${item.type}:${item.value}`}>
            <code>{item.value}</code> <span className="muted small">{item.type}</span>
            <div className={item.error ? 'error small' : 'small'}>{enrichmentLine(item)}</div>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function EnvironmentPanel({ detail }: { detail: CaptureDetail }) {
  const { environment: env, page } = detail.record.client;
  if (!env) return null;
  return (
    <Panel title="Environment" closed>
      <Fields
        rows={[
          ['Browser', [env.browser?.name, env.browser?.version].filter(Boolean).join(' ')],
          ['Platform', [env.platform?.os, env.platform?.arch].filter(Boolean).join(' ')],
          ['Time zone', env.timeZone],
          ['Extension', env.extension?.version && `${env.extension.version} (${env.extension.id})`],
          [
            'Viewport',
            page?.viewport && `${page.viewport.width} × ${page.viewport.height} @ ${page.devicePixelRatio}x`,
          ],
          ['Page size', page?.scrollSize && `${page.scrollSize.width} × ${page.scrollSize.height}`],
          ['User agent', env.userAgent && <span className="url">{env.userAgent}</span>],
        ]}
      />
    </Panel>
  );
}
