import {
  Camera,
  FileText,
  Fingerprint,
  Folder,
  Globe,
  Hash as HashIcon,
  LayoutGrid,
  ListTodo,
  LoaderCircle,
  Plus,
  RefreshCw,
  Search,
  ShieldAlert,
  ShieldCheck,
  Tag,
  TriangleAlert,
  Unplug,
  type LucideIcon,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  parseRoute,
  routeHash,
  type DashboardRoute,
  type DashboardView,
  type OverviewView,
} from '@/lib/dashboard';
import { errorMessage, sendToBackground, type Case, type Status, type VerifyReport } from '@/lib/protocol';
import { watchHits } from '@/lib/selectors';

import CaptureView from './CaptureView';
import { useCaseData, useOverview, useWatchTerms } from './data';
import { CasesView, TagsView } from './OverviewViews';
import PagesView from './PagesView';
import SelectorsView from './SelectorsView';
import SitesView from './SitesView';
import TodosView from './TodosView';
import { dayKey, downloadText, fmtDay, hostOf, plural, useHash } from './ui';

export default function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [cases, setCases] = useState<Case[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const hash = useHash();

  const connect = useCallback(async () => {
    setError(null);
    try {
      const s = await sendToBackground({ type: 'status' });
      setStatus(s);
      if (s.service === 'online') setCases(await sendToBackground({ type: 'listCases' }));
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);
  useEffect(() => void connect(), [connect]);

  if (error || (status && status.service !== 'online')) {
    return (
      <div className="center rise">
        <div className="empty">
          <Unplug />
          <strong>Not connected</strong>
          <span className="error small">{error ?? status?.error ?? 'No server configured.'}</span>
          <span className="small">
            Choose where captures are stored in the extension's toolbar popup (this browser, or a Core AI &
            Data toolkit server with its URL and API key), then retry.
          </span>
          <button onClick={connect} style={{ marginTop: 8 }}>
            <RefreshCw />
            Retry
          </button>
        </div>
      </div>
    );
  }
  if (!status || !cases)
    return (
      <div className="center muted connecting">
        <LoaderCircle className="spin" /> Connecting…
      </div>
    );

  const route = parseRoute(hash, status.lastCaseId ?? 'inbox');
  const onCreated = (c: Case) => {
    setCases([...cases, c]);
    location.hash = routeHash({ caseId: c.id, view: 'pages' });
  };
  return (
    <div className="layout">
      <Sidebar status={status} cases={cases} route={route} onCreated={onCreated} />
      {'caseId' in route ? (
        <CaseScreen key={route.caseId} route={route} current={cases.find((c) => c.id === route.caseId)} />
      ) : (
        <OverviewScreen view={route.view} cases={cases} onCreated={onCreated} />
      )}
    </div>
  );
}

/** Kept mounted from one overview to the other, so the cases are loaded once for both. */
function OverviewScreen(props: { view: OverviewView; cases: Case[]; onCreated: (c: Case) => void }) {
  const overview = useOverview(props.cases);
  return (
    <main className="content">
      {props.view === 'cases' ? (
        <CasesView cases={props.cases} overview={overview} onCreated={props.onCreated} />
      ) : (
        <TagsView cases={props.cases} overview={overview} />
      )}
    </main>
  );
}

const OVERVIEWS: { view: OverviewView; label: string; icon: LucideIcon }[] = [
  { view: 'cases', label: 'All cases', icon: LayoutGrid },
  { view: 'tags', label: 'Tags', icon: Tag },
];

// ---------------------------------------------------------------------------

function Sidebar(props: {
  status: Status;
  cases: Case[];
  route: DashboardRoute;
  onCreated: (c: Case) => void;
}) {
  const [name, setName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    if (!name?.trim()) return;
    try {
      props.onCreated(await sendToBackground({ type: 'createCase', name: name.trim() }));
      setName(null);
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <nav className="sidebar">
      <div className="brand">
        <span className="logo" aria-hidden="true">
          <Fingerprint />
        </span>
        <span>Insights &amp; Evidence</span>
      </div>

      <ul className="cases overview-links">
        {OVERVIEWS.map((o) => (
          <li key={o.view}>
            <a href={routeHash({ view: o.view })} aria-current={props.route.view === o.view ? 'page' : undefined}>
              <o.icon />
              <span>{o.label}</span>
            </a>
          </li>
        ))}
      </ul>

      <div className="side-heading">
        Cases
        <button
          className="ghost icon"
          title="New case"
          aria-label="New case"
          aria-pressed={name !== null}
          onClick={() => setName(name === null ? '' : null)}
        >
          <Plus />
        </button>
      </div>
      {name !== null && (
        <input
          className="new-case rise"
          autoFocus
          placeholder="New case name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => (e.key === 'Enter' ? create() : e.key === 'Escape' && setName(null))}
        />
      )}
      {error && <p className="error small">{error}</p>}
      <ul className="cases">
        {props.cases.map((c) => (
          <li key={c.id}>
            <a
              href={routeHash({ caseId: c.id, view: 'pages' })}
              aria-current={'caseId' in props.route && c.id === props.route.caseId ? 'page' : undefined}
            >
              <Folder />
              <span>{c.name}</span>
            </a>
          </li>
        ))}
      </ul>

      <div className="side-footer">
        <LedgerCheck caseId={'caseId' in props.route ? props.route.caseId : (props.status.lastCaseId ?? 'inbox')} />
        <div className="server" title={props.status.server?.version ?? ''}>
          <span className="dot dot-ok" />
          <span className="server-host">
            {props.status.store === 'browser'
              ? 'This browser'
              : props.status.connection?.baseUrl.replace(/^https?:\/\//, '')}
          </span>
        </div>
      </div>
    </nav>
  );
}

function LedgerCheck({ caseId }: { caseId: string }) {
  const [report, setReport] = useState<VerifyReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const verify = async () => {
    setBusy(true);
    setError(null);
    try {
      setReport(await sendToBackground({ type: 'verify' }));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const errors = report?.issues.filter((i) => i.severity === 'error') ?? [];
  return (
    <div className="ledger">
      <button onClick={verify} disabled={busy}>
        {busy ? <LoaderCircle className="spin" /> : <ShieldCheck />}
        {busy ? 'Verifying…' : 'Verify ledger'}
      </button>
      {error && <p className="error small">{error}</p>}
      {report && (
        <div className="small ledger-report rise">
          <div className={`ledger-verdict ${report.ok ? 'ok' : 'error'}`}>
            {report.ok ? <ShieldCheck /> : <ShieldAlert />}
            {report.ok ? 'Chain intact' : plural(errors.length, 'error')}
          </div>
          <div className="muted">
            {plural(report.records, 'record')}, {report.timestamped} timestamped
            {report.publicKeyPem && (
              <>
                {' · '}
                <button
                  className="link"
                  title="The signing key, for openssl pkeyutl -verify"
                  onClick={() => downloadText('ed25519.pub.pem', report.publicKeyPem!, 'application/x-pem-file')}
                >
                  public key
                </button>
              </>
            )}
          </div>
          {report.issues.length > 0 && (
            <ul className="issues">
              {report.issues.slice(0, 20).map((i) => (
                <li key={`${i.seq}-${i.message}`} className={i.severity === 'error' ? 'error' : 'warn'}>
                  <a href={routeHash({ caseId, view: 'capture', captureId: i.captureId })}>#{i.seq}</a>{' '}
                  {i.message}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

const TABS: { view: DashboardView; label: string; icon: LucideIcon }[] = [
  { view: 'pages', label: 'Pages', icon: FileText },
  { view: 'selectors', label: 'Selectors', icon: HashIcon },
  { view: 'sites', label: 'Sites', icon: Globe },
  { view: 'todos', label: 'Todos', icon: ListTodo },
];

function CaseScreen({ route, current }: { route: Extract<DashboardRoute, { caseId: string }>; current?: Case }) {
  const data = useCaseData(route.caseId);
  const [watchTerms, setWatchTerms] = useWatchTerms();
  const [query, setQuery] = useState('');
  const search = useRef<HTMLInputElement>(null);

  // "/" jumps to the search box, as on most sites.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)
        return;
      e.preventDefault();
      search.current?.focus();
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);

  const stats = useMemo(() => {
    const captures = data.captures ?? [];
    const sites = new Set(captures.map((c) => hostOf(c.url)).filter(Boolean));
    const selectors = new Set<string>();
    for (const scan of data.scans.values()) {
      for (const h of [...scan.hits, ...watchHits(scan, watchTerms)]) {
        if (h.kind !== 'link') selectors.add(`${h.kind}\n${h.value}`);
      }
    }
    return {
      pages: captures.length,
      sites: sites.size,
      selectors: selectors.size,
      timestamped: captures.filter((c) => c.timestampedAt).length,
      first: captures.at(-1)?.receivedAt,
      last: captures[0]?.receivedAt,
    };
  }, [data.captures, data.scans, watchTerms]);

  if (route.view === 'capture') {
    return (
      <main className="content">
        <CaptureView key={route.captureId} route={route} data={data} watchTerms={watchTerms} />
      </main>
    );
  }

  const total = data.captures?.length ?? 0;
  const indexed = data.scans.size + data.scanFailures;
  const openTodos = data.todos?.filter((t) => !t.done).length ?? 0;
  const loading = !data.captures && !data.error;
  return (
    <main className="content">
      <header className="case-header">
        <div>
          <h1>{current?.name ?? route.caseId}</h1>
          <p className="muted">
            {stats.first && stats.last
              ? dayKey(stats.first) === dayKey(stats.last)
                ? fmtDay(stats.last)
                : `${fmtDay(stats.first)} – ${fmtDay(stats.last)}`
              : data.captures
                ? 'No captures yet'
                : 'Loading…'}
          </p>
        </div>
        <button className="ghost" onClick={data.reload} title="Reload the case">
          <RefreshCw />
          Refresh
        </button>
      </header>

      <section className="tiles" aria-label="Case summary">
        <Tile icon={FileText} label="Pages captured" value={stats.pages} loading={loading} />
        <Tile icon={Globe} label="Sites" value={stats.sites} loading={loading} />
        <Tile
          icon={HashIcon}
          label="Selectors found"
          value={stats.selectors}
          loading={loading}
          note={indexed < total ? `indexing ${indexed} of ${total} pages` : undefined}
        />
        <Tile
          icon={ShieldCheck}
          label="Timestamped"
          value={stats.timestamped}
          loading={loading}
          note={total ? `of ${total}` : undefined}
          tone={total && stats.timestamped < total ? 'warn' : total ? 'ok' : undefined}
        />
      </section>

      <div className="toolbar">
        <div className="tabs" role="tablist">
          {TABS.map((t) => (
            <a
              key={t.view}
              role="tab"
              href={routeHash({ caseId: route.caseId, view: t.view })}
              aria-selected={route.view === t.view}
            >
              <t.icon />
              {t.label}
              {t.view === 'todos' && openTodos > 0 && (
                <span className="count tnum" title={plural(openTodos, 'open todo')}>
                  {openTodos.toLocaleString()}
                </span>
              )}
            </a>
          ))}
        </div>
        <div className="search-wrap">
          <Search className="search-icon" />
          <input
            ref={search}
            type="search"
            className="search"
            placeholder={route.view === 'pages' ? 'Search titles, URLs, tags, notes, page text' : 'Filter'}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <kbd className="search-key">/</kbd>
        </div>
      </div>

      {route.view === 'todos' ? (
        <TodosView data={data} query={query} />
      ) : data.error ? (
        <div className="empty">
          <TriangleAlert />
          <strong>Could not load this case</strong>
          <span className="error small">{data.error}</span>
        </div>
      ) : !data.captures ? (
        <div className="grid">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="skeleton" style={{ height: 220 }} />
          ))}
        </div>
      ) : data.captures.length === 0 ? (
        <div className="empty">
          <Camera />
          <strong>Nothing captured in this case yet</strong>
          <span className="small">
            Use the toolbar popup or <kbd>Alt</kbd> <kbd>Shift</kbd> <kbd>S</kbd> to capture the page you
            are on. Right-click a page, selection or image for more.
          </span>
        </div>
      ) : route.view === 'pages' ? (
        <PagesView key={route.tag} caseId={route.caseId} data={data} query={query} tag={route.tag} />
      ) : route.view === 'selectors' ? (
        <SelectorsView
          caseId={route.caseId}
          data={data}
          query={query}
          watchTerms={watchTerms}
          onWatchTerms={setWatchTerms}
        />
      ) : (
        <SitesView
          data={data}
          query={query}
          onPick={(host) => {
            setQuery(host);
            location.hash = routeHash({ caseId: route.caseId, view: 'pages' });
          }}
        />
      )}
      {data.scanFailures > 0 && (
        <p className="warn small">
          <TriangleAlert /> {plural(data.scanFailures, 'page')} could not be indexed for selectors and text
          search (see the console).
        </p>
      )}
    </main>
  );
}

function Tile({
  icon: Icon,
  label,
  value,
  note,
  loading,
  tone,
}: {
  icon: LucideIcon;
  label: string;
  value: number;
  note?: string;
  loading?: boolean;
  tone?: 'ok' | 'warn';
}) {
  return (
    <div className={`tile ${tone ? `tile-${tone}` : ''}`}>
      <div className="tile-head">
        <span className="tile-label">{label}</span>
        <Icon className="tile-icon" />
      </div>
      {loading ? (
        <div className="skeleton" style={{ height: 30, width: 56, marginTop: 4 }} />
      ) : (
        <div className="tile-value tnum">{value.toLocaleString()}</div>
      )}
      {note && <div className="tile-note">{note}</div>}
    </div>
  );
}
