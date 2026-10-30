import { Download, ExternalLink, Eye, X } from 'lucide-react';
import { useMemo, useState } from 'react';

import { routeHash } from '@/lib/dashboard';
import type { CaptureSummary } from '@/lib/protocol';
import { SELECTOR_KINDS, watchHits, type SelectorKind } from '@/lib/selectors';

import type { CaseData } from './data';
import { captureLabel, downloadCsv, fmtTime, plural } from './ui';

interface Selector {
  kind: SelectorKind;
  value: string;
  /** Newest first, as the case lists them */
  captures: CaptureSummary[];
}

const KIND_ORDER = new Map(SELECTOR_KINDS.map((k, i) => [k.kind, i]));
const kindLabel = (kind: SelectorKind) => SELECTOR_KINDS.find((k) => k.kind === kind)?.label ?? kind;

/** Social profiles and linked sites can be opened; the rest are copied. */
const hrefOf = (s: Pick<Selector, 'kind' | 'value'>) =>
  s.kind === 'social' || s.kind === 'link' ? `https://${s.value}` : null;

export default function SelectorsView(props: {
  caseId: string;
  data: CaseData;
  query: string;
  watchTerms: string[];
  onWatchTerms: (terms: string[]) => void;
}) {
  const { data, query, watchTerms } = props;
  const [kind, setKind] = useState<SelectorKind | 'all'>('all');
  const [term, setTerm] = useState('');

  const selectors = useMemo(() => {
    const byKey = new Map<string, Selector>();
    for (const c of data.captures ?? []) {
      const scan = data.scans.get(c.captureId);
      if (!scan) continue;
      for (const hit of [...watchHits(scan, watchTerms), ...scan.hits]) {
        const key = `${hit.kind}\n${hit.value}`;
        const s = byKey.get(key) ?? { ...hit, captures: [] };
        s.captures.push(c);
        byKey.set(key, s);
      }
    }
    return [...byKey.values()].sort(
      (a, b) =>
        KIND_ORDER.get(a.kind)! - KIND_ORDER.get(b.kind)! ||
        b.captures.length - a.captures.length ||
        a.value.localeCompare(b.value),
    );
  }, [data.captures, data.scans, watchTerms]);

  const counts = useMemo(() => {
    const n = new Map<SelectorKind, number>();
    for (const s of selectors) n.set(s.kind, (n.get(s.kind) ?? 0) + 1);
    return n;
  }, [selectors]);

  const q = query.trim().toLowerCase();
  const shown = selectors.filter(
    (s) => (kind === 'all' || s.kind === kind) && (!q || s.value.toLowerCase().includes(q)),
  );

  const addTerm = () => {
    const t = term.trim();
    if (t && !watchTerms.some((w) => w.toLowerCase() === t.toLowerCase()))
      props.onWatchTerms([...watchTerms, t]);
    setTerm('');
  };

  const exportCsv = () =>
    downloadCsv(`case-${props.caseId}-selectors.csv`, [
      ['kind', 'value', 'pages', 'firstSeen', 'captureIds', 'urls'],
      ...shown.map((s) => [
        s.kind,
        s.value,
        s.captures.length,
        s.captures.at(-1)?.receivedAt,
        s.captures.map((c) => c.captureId).join(' '),
        s.captures.map((c) => c.url ?? '').join(' '),
      ]),
    ]);

  return (
    <>
      <div className="watch">
        <span className="watch-label">
          <Eye />
          Watch for
        </span>
        {watchTerms.map((t) => (
          <span key={t} className="chip">
            {t}
            <button
              className="chip-x"
              title={`Stop watching for "${t}"`}
              onClick={() => props.onWatchTerms(watchTerms.filter((w) => w !== t))}
            >
              <X />
            </button>
          </span>
        ))}
        <input
          className="watch-input"
          placeholder="Add a name, username, number…"
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && addTerm()}
        />
      </div>

      <div className="view-bar">
        <div className="filters" role="group" aria-label="Selector kind">
          <button aria-pressed={kind === 'all'} onClick={() => setKind('all')}>
            All <span className="count">{selectors.length}</span>
          </button>
          {SELECTOR_KINDS.filter((k) => counts.get(k.kind)).map((k) => (
            <button key={k.kind} aria-pressed={kind === k.kind} onClick={() => setKind(k.kind)}>
              {k.label} <span className="count">{counts.get(k.kind)}</span>
            </button>
          ))}
        </div>
        <button onClick={exportCsv} disabled={!shown.length}>
          <Download />
          Export CSV
        </button>
      </div>

      {shown.length === 0 ? (
        <p className="muted">
          {data.scans.size + data.scanFailures < (data.captures?.length ?? 0)
            ? 'Indexing pages…'
            : `No selectors found${q ? ` matching "${query}"` : ''}.`}
        </p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Kind</th>
              <th>Selector</th>
              <th className="num">Pages</th>
              <th>First seen</th>
              <th>Found on</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((s) => (
              <SelectorRow key={`${s.kind}\n${s.value}`} caseId={props.caseId} selector={s} />
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

function SelectorRow({ caseId, selector: s }: { caseId: string; selector: Selector }) {
  const [all, setAll] = useState(false);
  const href = hrefOf(s);
  const pages = all ? s.captures : s.captures.slice(0, 3);
  return (
    <tr>
      <td>
        <span className={`kind kind-${s.kind}`}>{kindLabel(s.kind)}</span>
      </td>
      <td className="selector-value">
        <code>{s.value}</code>{' '}
        <button className="link" title="Copy" onClick={() => navigator.clipboard.writeText(s.value)}>
          copy
        </button>
        {href && (
          <>
            {' · '}
            <a href={href} target="_blank" rel="noreferrer noopener" title="Opens the live site">
              open <ExternalLink />
            </a>
          </>
        )}
      </td>
      <td className="num">{s.captures.length}</td>
      <td className="nowrap muted">{fmtTime(s.captures.at(-1)?.receivedAt)}</td>
      <td>
        <ul className="found-on">
          {pages.map((c) => (
            <li key={c.captureId}>
              <a href={routeHash({ caseId, view: 'capture', captureId: c.captureId })} title={c.url ?? ''}>
                <span className="muted">#{c.seq}</span> {captureLabel(c)}
              </a>
            </li>
          ))}
        </ul>
        {s.captures.length > 3 && (
          <button className="link" onClick={() => setAll(!all)}>
            {all ? 'fewer' : `+ ${s.captures.length - 3} more`}
          </button>
        )}
      </td>
    </tr>
  );
}
