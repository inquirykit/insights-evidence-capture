import { Bot, Clock, Download, ImageOff, MessageSquare, ShieldCheck, Tag } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { TagChip, TagMark, useTagDefs } from '@/components/tags';
import { routeHash } from '@/lib/dashboard';
import type { Annotation, CaptureDetail, CaptureSummary } from '@/lib/protocol';
import { escapeRegExp, type PageScan } from '@/lib/selectors';
import { defOf, tagKey, type TagDefs } from '@/lib/tags';

import { loadThumbnail, type CaseData } from './data';
import { captureLabel, dayKey, downloadCsv, fmtDay, hostOf, pageUrl, plural, useSeen } from './ui';

interface Match {
  capture: CaptureSummary;
  /** Where the query was found in the page text, when not in the title, URL, tags or notes */
  snippet?: { before: string; hit: string; after: string };
}

// Tags shown on a card; the rest are counted.
const CARD_TAGS = 4;

function match(
  c: CaptureSummary,
  d: CaptureDetail | undefined,
  a: Annotation | undefined,
  scan: PageScan | undefined,
  re: RegExp | null,
): Match | null {
  if (!re) return { capture: c };
  const fields = [
    c.title,
    c.url,
    d?.record.client.note,
    d?.record.client.page?.documentUrl,
    ...(a?.tags ?? []),
    ...(a?.notes.map((n) => n.text) ?? []),
  ];
  if (fields.some((f) => f && re.test(f))) return { capture: c };
  const m = scan && re.exec(scan.text);
  if (!m) return null;
  return {
    capture: c,
    snippet: {
      before: scan.text.slice(Math.max(0, m.index - 60), m.index),
      hit: m[0],
      after: scan.text.slice(m.index + m[0].length, m.index + m[0].length + 80),
    },
  };
}

export default function PagesView({
  caseId,
  data,
  query,
  tag,
}: {
  caseId: string;
  data: CaseData;
  query: string;
  /** Shows only the pages with this tag at first (a link from the case or tag overview) */
  tag?: string;
}) {
  const captures = data.captures ?? [];
  const [defs] = useTagDefs();
  // Tags to filter by, by tagKey: a page must have all of them.
  const [picked, setPicked] = useState<string[]>(tag ? [tagKey(tag)] : []);

  // Every tag in the case, most used first, in the spelling it was first given.
  const tags = useMemo(() => {
    const counts = new Map<string, { tag: string; pages: number }>();
    for (const c of captures) {
      for (const tag of data.annotations?.get(c.captureId)?.tags ?? []) {
        const entry = counts.get(tagKey(tag));
        if (entry) entry.pages++;
        else counts.set(tagKey(tag), { tag, pages: 1 });
      }
    }
    return [...counts.entries()].sort(([, a], [, b]) => b.pages - a.pages || a.tag.localeCompare(b.tag));
  }, [captures, data.annotations]);

  const days = useMemo(() => {
    const re = query.trim() ? new RegExp(escapeRegExp(query.trim()), 'i') : null;
    const groups = new Map<string, Match[]>();
    for (const c of captures) {
      const a = data.annotations?.get(c.captureId);
      const has = new Set(a?.tags.map(tagKey));
      if (!picked.every((t) => has.has(t))) continue;
      const m = match(c, data.details.get(c.captureId), a, data.scans.get(c.captureId), re);
      if (!m) continue;
      const day = dayKey(c.receivedAt);
      groups.set(day, [...(groups.get(day) ?? []), m]);
    }
    return [...groups.values()];
  }, [captures, data.details, data.annotations, data.scans, query, picked]);

  const shown = days.reduce((n, d) => n + d.length, 0);
  const filtered = !!query.trim() || picked.length > 0;

  const exportCsv = () =>
    downloadCsv(`case-${caseId}-pages.csv`, [
      [
        'seq',
        'captureId',
        'receivedAt',
        'title',
        'url',
        'httpStatus',
        'serverIp',
        'note',
        'trigger',
        'tags',
        'analystNotes',
        'recordHash',
        'timestampedAt',
      ],
      ...days.flat().map(({ capture: c }) => {
        const client = data.details.get(c.captureId)?.record.client;
        const a = data.annotations?.get(c.captureId);
        return [
          c.seq,
          c.captureId,
          c.receivedAt,
          c.title,
          pageUrl(c, data.details.get(c.captureId)),
          client?.network?.mainFrame?.statusCode,
          client?.network?.mainFrame?.ip,
          client?.note,
          client?.trigger,
          a?.tags.join('; '),
          a?.notes.map((n) => n.text).join('\n\n'),
          c.recordHash,
          c.timestampedAt,
        ];
      }),
    ]);

  if (!captures.length) return <p className="muted">Nothing captured in this case yet.</p>;

  const pick = (key: string) =>
    setPicked((p) => (p.includes(key) ? p.filter((t) => t !== key) : [...p, key]));

  return (
    <>
      <div className="view-bar">
        <span className="muted">
          {filtered ? `${plural(shown, 'page')} match${shown === 1 ? 'es' : ''}` : plural(shown, 'page')}
        </span>
        <button onClick={exportCsv} disabled={!shown}>
          <Download />
          Export CSV
        </button>
      </div>
      {tags.length > 0 && (
        <div className="filters tag-filter" role="group" aria-label="Filter by tag">
          <span className="tag-filter-label">
            <Tag /> Tags
          </span>
          {tags.map(([key, { tag, pages }]) => (
            <button key={key} aria-pressed={picked.includes(key)} onClick={() => pick(key)}>
              <TagMark def={defOf(defs, tag)} />
              {tag} <span className="count">{pages}</span>
            </button>
          ))}
          {picked.length > 0 && (
            <button className="link" onClick={() => setPicked([])}>
              Clear
            </button>
          )}
        </div>
      )}
      {data.annotationsError && (
        <p className="warn small">Tags and notes are unavailable: {data.annotationsError}</p>
      )}
      {days.map((group) => (
        <section key={dayKey(group[0]!.capture.receivedAt)} className="day">
          <h2>
            {fmtDay(group[0]!.capture.receivedAt)}{' '}
            <span className="muted">· {plural(group.length, 'page')}</span>
          </h2>
          <div className="grid">
            {group.map((m) => (
              <PageCard
                key={m.capture.captureId}
                caseId={caseId}
                match={m}
                detail={data.details.get(m.capture.captureId)}
                annotation={data.annotations?.get(m.capture.captureId)}
                scan={data.scans.get(m.capture.captureId)}
                defs={defs}
              />
            ))}
          </div>
        </section>
      ))}
      {filtered && shown === 0 && <p className="muted">No page matches.</p>}
    </>
  );
}

function PageCard(props: {
  caseId: string;
  match: Match;
  detail?: CaptureDetail;
  annotation?: Annotation;
  scan?: PageScan;
  defs: TagDefs;
}) {
  const { capture: c, snippet } = props.match;
  const ref = useRef<HTMLAnchorElement>(null);
  const seen = useSeen(ref);
  const [thumb, setThumb] = useState<string | null>(null);
  const [thumbFailed, setThumbFailed] = useState(false);

  useEffect(() => {
    if (!seen) return;
    let live = true;
    loadThumbnail(c.captureId).then(
      (url) => live && setThumb(url),
      () => live && setThumbFailed(true),
    );
    return () => {
      live = false;
    };
  }, [seen, c.captureId]);

  const client = props.detail?.record.client;
  const status = client?.network?.mainFrame?.statusCode;
  const selectors = props.scan?.hits.filter((h) => h.kind !== 'link').length;
  const tags = props.annotation?.tags ?? [];
  const notes = props.annotation?.notes.length ?? 0;
  const time = new Date(c.receivedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

  return (
    <a
      ref={ref}
      className="page-card"
      href={routeHash({ caseId: props.caseId, view: 'capture', captureId: c.captureId })}
    >
      <div className="thumb">
        {thumb ? (
          <img src={thumb} alt="" />
        ) : (
          thumbFailed ? <ImageOff /> : <span className="skeleton" style={{ width: '100%', height: '100%' }} />
        )}
      </div>
      <div className="page-body">
        <div className="page-title" title={captureLabel(c)}>
          {captureLabel(c)}
        </div>
        <div className="page-meta muted">
          <span className="page-host" title={pageUrl(c, props.detail) ?? ''}>
            {hostOf(pageUrl(c, props.detail)) ?? '–'}
          </span>
          <span>{time}</span>
        </div>
        {client?.note && <div className="page-note">{client.note}</div>}
        {tags.length > 0 && (
          <div className="tags" title={tags.join(', ')}>
            {tags.slice(0, CARD_TAGS).map((t) => (
              <TagChip key={t} tag={t} defs={props.defs} />
            ))}
            {tags.length > CARD_TAGS && <span className="muted small">+{tags.length - CARD_TAGS}</span>}
          </div>
        )}
        {snippet && (
          <div className="snippet">
            …{snippet.before}
            <mark>{snippet.hit}</mark>
            {snippet.after}…
          </div>
        )}
        <div className="badges">
          <span className="badge" title={`Record #${c.seq}`}>
            #{c.seq}
          </span>
          {status != null && (
            <span
              className={`badge ${status >= 400 ? 'badge-warn' : ''}`}
              title="HTTP status of the document"
            >
              {status}
            </span>
          )}
          <span
            className={`badge ${c.timestampedAt ? 'badge-ok' : 'badge-warn'}`}
            title={c.timestampedAt ? `Timestamped ${c.timestampedAt}` : 'No trusted timestamp yet'}
          >
            {c.timestampedAt ? <ShieldCheck /> : <Clock />}
            {c.timestampedAt ? 'TSA' : 'no TSA'}
          </span>
          {selectors ? <span className="badge">{plural(selectors, 'selector')}</span> : null}
          {notes > 0 && (
            <span className="badge" title="Analyst notes">
              <MessageSquare />
              {notes}
            </span>
          )}
          {client?.trigger === 'auto' && (
            <span className="badge" title="Captured by auto-capture">
              <Bot />
              auto
            </span>
          )}
        </div>
      </div>
    </a>
  );
}
