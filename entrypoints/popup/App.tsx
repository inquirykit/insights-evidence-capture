import {
  ArrowDownToLine,
  Ban,
  Camera,
  Check,
  ChevronRight,
  CircleCheck,
  Clock,
  ExternalLink,
  Fingerprint,
  FolderOpen,
  GitBranch,
  HardDrive,
  History,
  Info,
  LayoutGrid,
  LoaderCircle,
  Maximize,
  Monitor,
  MousePointerClick,
  Plus,
  Radio,
  Server,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  SquareDashedMousePointer,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

import { TagInput, useTagDefs } from '@/components/tags';
import { openDashboard } from '@/lib/dashboard';
import {
  AUTO_SCROLL_LIMITS,
  CAPTURE_DEPTHS,
  depthOf,
  getAutoCapture,
  getAutoCaptureStats,
  getCaptureOptions,
  parseHosts,
  SCREENSHOT_SCOPES,
  setAutoCapture,
  setCaptureOptions,
  withDepth,
  type AutoCaptureSettings,
  type AutoCaptureStats,
  type CaptureOptions,
  type ScreenshotScope,
} from '@/lib/options';
import { DEFAULT_BASE_URL, onSessionChange } from '@/lib/settings';
import { rememberTags } from '@/lib/tags';
import {
  errorMessage,
  sendToBackground,
  type Case,
  type CaptureOutcome,
  type CaptureSummary,
  type Status,
  type StoreMode,
  type VerifyReport,
} from '@/lib/protocol';

/** The source of the Core AI & Data toolkit (ai_toolkit): the server the popup offers to store
 *  captures on. */
const TOOLKIT_REPO = 'https://github.com/inquirykit/core-ai-data-toolkit';

const short = (hash: string) => `${hash.slice(0, 12)}…${hash.slice(-6)}`;
const fmtTime = (iso: string) => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? iso : new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' });
};

/** Where captures are kept: the choice names what the user gets, not where the code runs. */
const STORES: { value: StoreMode; label: string; hint: string; icon: LucideIcon }[] = [
  {
    value: 'browser',
    label: 'In this browser',
    hint: 'Signed and timestamped here, kept in this profile. Export to keep them.',
    icon: HardDrive,
  },
  {
    value: 'server',
    label: 'On a Core AI & Data toolkit server',
    hint: 'Signed by the server, enriched, kept on its disk, shared with other browsers.',
    icon: Server,
  },
];

const SCOPE_ICONS: Record<ScreenshotScope, LucideIcon> = {
  none: Ban,
  full: Maximize,
  visible: Monitor,
  region: SquareDashedMousePointer,
  element: MousePointerClick,
};

type Tab = 'capture' | 'options' | 'auto' | 'recent';

const TABS: { value: Tab; label: string; icon: LucideIcon }[] = [
  { value: 'capture', label: 'Capture', icon: Camera },
  { value: 'options', label: 'Options', icon: SlidersHorizontal },
  { value: 'auto', label: 'Auto', icon: Radio },
  { value: 'recent', label: 'Recent', icon: History },
];

export default function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await sendToBackground({ type: 'status' }));
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  const showSettings = editing || (status !== null && status.service !== 'online');

  return (
    <main>
      <header className="top">
        <About />
        <ConnectionPill status={status} onClick={() => setEditing((e) => !e)} />
      </header>

      {!status ? (
        <Connecting />
      ) : showSettings ? (
        <ConnectionPanel
          status={status}
          error={error ?? status.error ?? null}
          onConnected={(s) => {
            setError(null);
            setEditing(false);
            setStatus(s);
          }}
          onError={setError}
          onCancel={status.service === 'online' ? () => setEditing(false) : undefined}
        />
      ) : (
        <CapturePanel initialCaseId={status.lastCaseId} />
      )}
    </main>
  );
}

/** The name, and an info button beside it that opens a popover: what the extension is, and
 *  where the server's code lives. A native popover: a click outside it or Esc closes it. */
function About() {
  return (
    <div className="brand">
      <span className="logo" aria-hidden="true">
        <Fingerprint />
      </span>
      {/* Short: the full name (the manifest's) is too wide beside the connection pill */}
      <h1>Insights &amp; Evidence</h1>
      <button type="button" className="about-btn" popoverTarget="about" aria-label="About" title="About">
        <Info />
      </button>
      <div id="about" popover="auto" className="about">
        <p className="about-name">
          {browser.runtime.getManifest().name}{' '}
          <span className="muted tnum">v{browser.runtime.getManifest().version}</span>
        </p>
        <p className="about-line">Captures web pages as signed, timestamped evidence.</p>
        <a className="about-link" href={TOOLKIT_REPO} title={TOOLKIT_REPO} target="_blank" rel="noreferrer noopener">
          <GitBranch />
          <span className="grow">
            <span className="about-link-title">Core AI &amp; Data toolkit</span>
            <span className="about-link-hint">{TOOLKIT_REPO.replace('https://github.com/', '')} on GitHub</span>
          </span>
          <ExternalLink />
        </a>
      </div>
    </div>
  );
}

function Connecting() {
  return (
    <div className="stack" aria-busy="true" aria-label="Connecting">
      <div className="skeleton" style={{ height: 30 }} />
      <div className="skeleton" style={{ height: 52 }} />
      <div className="skeleton" style={{ height: 118 }} />
      <div className="skeleton" style={{ height: 40 }} />
    </div>
  );
}

function ConnectionPill({ status, onClick }: { status: Status | null; onClick: () => void }) {
  const online = status?.service === 'online';
  const label = !status
    ? 'checking'
    : online
      ? status.store === 'browser'
        ? 'this browser'
        : status.connection?.baseUrl.replace(/^https?:\/\//, '')
      : status.service;
  return (
    <button type="button" className="status" onClick={onClick} title="Where captures are stored">
      <span className={`dot ${!status ? '' : online ? 'dot-ok' : 'dot-error'}`} />
      <span className="status-label">{label}</span>
      <Settings className="status-gear" />
    </button>
  );
}

function ConnectionPanel(props: {
  status: Status;
  error: string | null;
  onConnected: (s: Status) => void;
  onError: (e: string) => void;
  onCancel?: () => void;
}) {
  const [store, setStore] = useState<StoreMode>(props.status.store);
  // The store the error is about: an unreachable server's is no reason not to pick this browser.
  const [errorFor, setErrorFor] = useState<StoreMode>(props.status.store);
  const [baseUrl, setBaseUrl] = useState(props.status.connection?.baseUrl ?? DEFAULT_BASE_URL);
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const keepKey = props.status.connection?.hasKey && !apiKey;

  const save = async () => {
    if (busy) return;
    setBusy(true);
    setErrorFor(store);
    try {
      // An empty key field keeps the saved key when there is one.
      const s =
        store === 'browser'
          ? await sendToBackground({ type: 'setStore', store })
          : await sendToBackground({ type: 'setConnection', baseUrl, apiKey: keepKey ? undefined : apiKey });
      if (s.service === 'online') props.onConnected(s);
      else props.onError(s.error ?? (store === 'browser' ? 'This browser cannot store captures' : 'Server is not reachable'));
    } catch (e) {
      props.onError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="stack rise">
      {props.error && errorFor === store && <Notice kind="error">{props.error}</Notice>}
      <div className="opt">
        <div className="opt-head">
          <span className="opt-label">Store captures</span>
          <span className="opt-hint">for this browser profile</span>
        </div>
        <div className="choices" role="radiogroup" aria-label="Store captures">
          {STORES.map((s) => (
            <button
              key={s.value}
              type="button"
              role="radio"
              aria-checked={store === s.value}
              data-store={s.value}
              disabled={busy}
              onClick={() => setStore(s.value)}
            >
              <span className="choice-icon" aria-hidden="true">
                <s.icon />
              </span>
              <span className="choice-text grow">
                <span className="choice-label">{s.label}</span>
                <span className="choice-hint">{s.hint}</span>
              </span>
              <span className="choice-radio" aria-hidden="true" />
            </button>
          ))}
        </div>
      </div>
      {store === 'server' && (
        <>
          <p className="muted lead small">
            Run the{' '}
            <a href={TOOLKIT_REPO} title={TOOLKIT_REPO} target="_blank" rel="noreferrer noopener">
              Core AI &amp; Data toolkit <ExternalLink />
            </a>
            , then enter its URL and the <code>API_KEY</code> from its <code>.env</code>.
          </p>
          <div className="field">
            <label htmlFor="server-url">Server URL</label>
            <input
              id="server-url"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder={DEFAULT_BASE_URL}
              inputMode="url"
              disabled={busy}
              autoFocus
            />
          </div>
          <div className="field">
            <label htmlFor="api-key">
              API key{' '}
              <span className="muted">
                {props.status.connection?.defaultKey
                  ? '(built-in default; leave empty to keep)'
                  : props.status.connection?.hasKey
                    ? '(saved; leave empty to keep)'
                    : '(empty if the server has none)'}
              </span>
            </label>
            <input
              id="api-key"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              type="password"
              autoComplete="off"
              disabled={busy}
              onKeyDown={(e) => e.key === 'Enter' && save()}
            />
          </div>
        </>
      )}
      <div className="row">
        <button className="primary grow" disabled={busy} onClick={save}>
          {busy ? <LoaderCircle className="spin" /> : <Check />}
          {busy ? (store === 'browser' ? 'Opening…' : 'Connecting…') : store === 'browser' ? 'Use this browser' : 'Connect'}
        </button>
        {props.onCancel && (
          <button disabled={busy} onClick={props.onCancel}>
            Cancel
          </button>
        )}
      </div>
    </section>
  );
}

function Notice({ kind, children }: { kind: 'error' | 'warn' | 'ok'; children: ReactNode }) {
  const Icon = kind === 'ok' ? CircleCheck : TriangleAlert;
  return (
    <div className={`notice notice-${kind}`} role={kind === 'error' ? 'alert' : undefined}>
      <Icon />
      <span>{children}</span>
    </div>
  );
}

/** The key combination bound to the capture command in this browser, if any. */
function useShortcut(): string | null {
  const [shortcut, setShortcut] = useState<string | null>(null);
  useEffect(() => {
    browser.commands
      .getAll()
      .then((cmds) => setShortcut(cmds.find((c) => c.name === 'capture-page')?.shortcut || null))
      .catch(() => setShortcut(null));
  }, []);
  return shortcut;
}

function Tabs(props: { tab: Tab; onChange: (t: Tab) => void; recording: boolean; onDashboard: () => void }) {
  const { tab, onChange } = props;
  // Arrow keys, Home and End move between the tabs, as in any tablist.
  const onKeyDown = (e: KeyboardEvent) => {
    const i = TABS.findIndex((t) => t.value === tab);
    const next =
      e.key === 'ArrowRight'
        ? (i + 1) % TABS.length
        : e.key === 'ArrowLeft'
          ? (i + TABS.length - 1) % TABS.length
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? TABS.length - 1
              : null;
    if (next === null) return;
    e.preventDefault();
    const { value } = TABS[next]!;
    onChange(value);
    document.getElementById(`tab-${value}`)?.focus();
  };

  return (
    <div className="tabs">
      <div className="tablist" role="tablist" aria-label="Popup sections" onKeyDown={onKeyDown}>
        {TABS.map((t) => (
          <button
            key={t.value}
            id={`tab-${t.value}`}
            type="button"
            role="tab"
            aria-selected={tab === t.value}
            aria-controls={`panel-${t.value}`}
            tabIndex={tab === t.value ? 0 : -1}
            onClick={() => onChange(t.value)}
          >
            <t.icon />
            {t.label}
            {t.value === 'auto' && props.recording && <span className="rec rec-on" title="Auto-capture is on" />}
          </button>
        ))}
      </div>
      {/* Looks like a tab, but opens the dashboard: cases, tags and every capture, in a tab of its own */}
      <button type="button" className="tab-link" title="Open the dashboard in a tab" onClick={props.onDashboard}>
        <LayoutGrid />
        Dashboard
      </button>
    </div>
  );
}

/** Every panel stays mounted while hidden, so a half-typed note or a running capture survives a
 *  switch to another tab. */
function Panel({ id, tab, children }: { id: Tab; tab: Tab; children: ReactNode }) {
  return (
    <section id={`panel-${id}`} role="tabpanel" aria-labelledby={`tab-${id}`} className="stack panel" hidden={tab !== id}>
      {children}
    </section>
  );
}

function CapturePanel({ initialCaseId }: { initialCaseId: string | null }) {
  const [tab, setTab] = useState<Tab>('capture');
  const [cases, setCases] = useState<Case[]>([]);
  const [caseId, setCaseId] = useState(initialCaseId ?? 'inbox');
  const [newCase, setNewCase] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [tagDefs] = useTagDefs();
  const [options, setOptions] = useState<CaptureOptions | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CaptureOutcome | null>(null);
  const [recent, setRecent] = useState<CaptureSummary[]>([]);
  const [report, setReport] = useState<VerifyReport | null>(null);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  // Here rather than in AutoCapture: the Auto tab shows a recording light while it is on.
  const [auto, setAuto] = useState<AutoCaptureSettings | null>(null);
  const shortcut = useShortcut();

  useEffect(() => {
    sendToBackground({ type: 'listCases' }).then(
      (list) => {
        setCases(list);
        // A case this store doesn't have (gone from the server, say) can't be captured into.
        setCaseId((id) => (list.some((c) => c.id === id) ? id : 'inbox'));
      },
      (e) => setError(errorMessage(e)),
    );
    getCaptureOptions().then(setOptions, (e) => setError(errorMessage(e)));
    getAutoCapture().then(setAuto, (e) => setError(errorMessage(e)));
  }, []);

  // Remembered for the next capture, the keyboard shortcut and the context menu.
  const update = (patch: Partial<CaptureOptions>) => {
    if (!options) return;
    const next = { ...options, ...patch };
    setOptions(next);
    setCaptureOptions(next).catch((e) => setError(errorMessage(e)));
  };
  const toggle = (key: 'mhtml' | 'singlefile' | 'pdf' | 'markdown' | 'reload' | 'monitorDom') =>
    update({ [key]: !options?.[key] });
  const picks = options?.screenshot === 'region' || options?.screenshot === 'element';
  const depth = options && depthOf(options);

  const loadRecent = useCallback(() => {
    sendToBackground({ type: 'listCaptures', caseId }).then(
      (list) => setRecent(list.slice(0, 10)),
      () => setRecent([]),
    );
  }, [caseId]);
  useEffect(loadRecent, [loadRecent]);

  const createCase = async () => {
    if (!newCase?.trim()) return;
    try {
      const created = await sendToBackground({ type: 'createCase', name: newCase.trim() });
      setCases((c) => [...c, created]);
      setCaseId(created.id);
      setNewCase(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const capture = async () => {
    if (!options) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (tab?.id == null) throw new Error('No active tab');
      const chosen = tags;
      if (picks) {
        // The user now clicks on the page, which closes this popup: the capture runs on in
        // the background and the badge shows ✓ or !.
        await sendToBackground({ type: 'captureDetached', tabId: tab.id, caseId, options, note, tags: chosen });
        await rememberTags(chosen);
        window.close();
        return;
      }
      setResult(await sendToBackground({ type: 'capture', tabId: tab.id, caseId, options, note, tags: chosen }));
      void rememberTags(chosen);
      setNote('');
      setTags([]);
      setDone(true);
      setTimeout(() => setDone(false), 1600);
      loadRecent();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const verify = async () => {
    setVerifyError(null);
    try {
      setReport(await sendToBackground({ type: 'verify' }));
    } catch (e) {
      setReport(null);
      setVerifyError(errorMessage(e));
    }
  };

  const captureLabel = busy
    ? 'Capturing…'
    : done
      ? 'Captured'
      : options?.screenshot === 'region'
        ? 'Select a region, then capture'
        : options?.screenshot === 'element'
          ? 'Pick an element, then capture'
          : 'Capture this page';

  const caseName = cases.find((c) => c.id === caseId)?.name ?? caseId;

  return (
    <div className="workspace rise">
      <Tabs
        tab={tab}
        onChange={setTab}
        recording={auto?.enabled ?? false}
        onDashboard={() => void openDashboard({ caseId, view: 'pages' })}
      />

      <Panel id="capture" tab={tab}>
        <div className="field">
          <label htmlFor="case">Case</label>
          <div className="row">
            <div className="select-wrap grow">
              <FolderOpen className="select-icon" />
              <select id="case" value={caseId} onChange={(e) => setCaseId(e.target.value)}>
                {cases.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
            <button
              className="icon-btn"
              aria-label="New case"
              title="New case"
              aria-pressed={newCase !== null}
              onClick={() => setNewCase(newCase === null ? '' : null)}
            >
              <Plus />
            </button>
          </div>
          {newCase !== null && (
            <div className="row rise">
              <input
                className="grow"
                autoFocus
                placeholder="New case name"
                value={newCase}
                onChange={(e) => setNewCase(e.target.value)}
                onKeyDown={(e) => (e.key === 'Enter' ? createCase() : e.key === 'Escape' && setNewCase(null))}
              />
              <button onClick={createCase} disabled={!newCase.trim()}>
                Create
              </button>
            </div>
          )}
        </div>

        <div className="field">
          <label htmlFor="note">
            Note <span className="muted">optional, signed with the capture</span>
          </label>
          <textarea
            id="note"
            rows={2}
            placeholder="Why this page matters…"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="tags">
            Tags <span className="muted">optional; editable later</span>
          </label>
          <TagInput id="tags" tags={tags} defs={tagDefs} placeholder="lead, profile, …" onChange={setTags} />
        </div>

        {options && (
          <div className="options">
            <div className="opt">
              <div className="opt-head">
                <span className="opt-label">Depth</span>
                <span className="opt-hint">
                  {depth ? CAPTURE_DEPTHS.find((d) => d.value === depth)?.title : 'Custom: set in Options'}
                </span>
              </div>
              <div className="segmented" role="radiogroup" aria-label="Capture depth">
                {CAPTURE_DEPTHS.map((d) => (
                  <button
                    key={d.value}
                    type="button"
                    role="radio"
                    aria-checked={depth === d.value}
                    title={d.title}
                    onClick={() => update(withDepth(options, d.value))}
                  >
                    {d.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="opt">
              <div className="opt-head">
                <span className="opt-label">Screenshot</span>
              </div>
              <div className="segmented" role="radiogroup" aria-label="Screenshot scope">
                {SCREENSHOT_SCOPES.map((s) => {
                  const Icon = SCOPE_ICONS[s.value];
                  return (
                    <button
                      key={s.value}
                      type="button"
                      role="radio"
                      aria-checked={options.screenshot === s.value}
                      title={s.title}
                      onClick={() => update({ screenshot: s.value })}
                    >
                      <Icon />
                      {s.value === 'full' ? 'Full' : s.label}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        <button
          className={`primary capture ${done ? 'capture-done' : ''}`}
          disabled={busy || !options}
          onClick={capture}
        >
          {busy ? <LoaderCircle className="spin" /> : done ? <Check className="pop" /> : <Camera />}
          <span className="grow">{captureLabel}</span>
          {shortcut && !busy && !done && <kbd title={`Keyboard shortcut: ${shortcut}`}>{shortcut}</kbd>}
        </button>
        {picks && !busy && (
          <p className="muted small hint">
            This closes the popup. Drag or click on the page, Esc cancels; the toolbar badge shows ✓ when the
            capture is saved. Right-click also offers page, selection and image captures.
          </p>
        )}

        {error && <Notice kind="error">{error}</Notice>}
        {result && <CaptureResult key={result.upload.captureId} result={result} caseId={caseId} />}
      </Panel>

      <Panel id="options" tab={tab}>
        <p className="muted small lead">
          Kept for every capture: this popup, {shortcut ? `the ${shortcut} shortcut` : 'the keyboard shortcut'} and
          the right-click menu.
        </p>
        {options && (
          <div className="options">
            <div className="opt">
              <div className="opt-head">
                <span className="opt-label">Also save</span>
              </div>
              <div className="checks">
                {!import.meta.env.FIREFOX && (
                  <label title="Every image, stylesheet and frame of the page, gzipped: often MBs">
                    <input type="checkbox" checked={options.mhtml} onChange={() => toggle('mhtml')} />
                    MHTML
                  </label>
                )}
                <label title="One self-contained HTML file made with SingleFile: images, styles and fonts inlined, scripts removed">
                  <input type="checkbox" checked={options.singlefile} onChange={() => toggle('singlefile')} />
                  Single HTML
                </label>
                {!import.meta.env.FIREFOX && (
                  <label title="The page printed to PDF with its backgrounds">
                    <input type="checkbox" checked={options.pdf} onChange={() => toggle('pdf')} />
                    PDF
                  </label>
                )}
                <label title="The page's visible text with its headings, links, lists and tables">
                  <input type="checkbox" checked={options.markdown} onChange={() => toggle('markdown')} />
                  Markdown
                </label>
              </div>
            </div>

            <div className="opt">
              <div className="opt-head">
                <span className="opt-label">Auto-scroll</span>
                <span className="opt-hint">{AUTO_SCROLL_LIMITS.find((s) => s.value === options.autoScroll)?.title}</span>
              </div>
              <div className="segmented" role="radiogroup" aria-label="Auto-scroll">
                {AUTO_SCROLL_LIMITS.map((s) => (
                  <button
                    key={s.value}
                    type="button"
                    role="radio"
                    aria-checked={options.autoScroll === s.value}
                    title={s.title}
                    onClick={() => update({ autoScroll: s.value })}
                  >
                    {s.value > 0 && <ArrowDownToLine />}
                    {s.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="opt">
              <div className="opt-head">
                <span className="opt-label">Integrity</span>
              </div>
              <div className="checks">
                <label title="Reload the page and capture it as it comes back: changes made to it since it loaded (DevTools edits, typed text) are gone">
                  <input type="checkbox" checked={options.reload} onChange={() => toggle('reload')} />
                  Reload first
                </label>
                <label title="Record the page's DOM changes before and during the capture (dom-changes.json). Pages loaded from now on are watched from their start; auto-capture too">
                  <input type="checkbox" checked={options.monitorDom} onChange={() => toggle('monitorDom')} />
                  Watch DOM changes
                </label>
              </div>
            </div>
          </div>
        )}
      </Panel>

      <Panel id="auto" tab={tab}>
        {auto && <AutoCapture caseId={caseId} cases={cases} settings={auto} onChange={setAuto} />}
      </Panel>

      <Panel id="recent" tab={tab}>
        <div>
          <h2>Recent in {caseName}</h2>
          {recent.length > 0 ? (
            <ul className="recent">
              {recent.map((c) => (
                <li key={c.captureId}>
                  <button
                    className="recent-item"
                    title={c.url ?? ''}
                    onClick={() => openDashboard({ caseId, view: 'capture', captureId: c.captureId })}
                  >
                    <span className="seq tnum">#{c.seq}</span>
                    <span className="title">{c.title || c.url}</span>
                    <span className={`tsa ${c.timestampedAt ? 'ok' : 'warn'}`} title={c.timestampedAt ? 'Trusted timestamp' : 'No trusted timestamp yet'}>
                      {c.timestampedAt ? <ShieldCheck /> : <Clock />}
                    </span>
                    <ChevronRight className="chev" />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <div className="empty">
              <Camera />
              <strong>Nothing captured here yet</strong>
              <span className="small">Your first capture in this case will show up here.</span>
            </div>
          )}
        </div>

        <footer>
          <button className="ghost" onClick={verify}>
            <ShieldCheck />
            Verify log
          </button>
          {report && (
            <span className={`small ${report.ok ? 'ok' : 'error'}`}>
              {report.ok ? 'Chain intact' : 'Problems found'} · {report.records} records ·{' '}
              {report.issues.filter((i) => i.severity === 'error').length} errors
            </span>
          )}
          {verifyError && <span className="small error">{verifyError}</span>}
        </footer>
      </Panel>
    </div>
  );
}

/** Auto-capture: on, every page the user visits is captured into one case (lib/auto-capture.ts). */
function AutoCapture(props: {
  caseId: string;
  cases: Case[];
  settings: AutoCaptureSettings;
  onChange: (s: AutoCaptureSettings) => void;
}) {
  const { caseId, settings } = props;
  const [stats, setStats] = useState<AutoCaptureStats | null>(null);
  const [skip, setSkip] = useState(settings.skipHosts.join(', '));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getAutoCaptureStats().then(setStats, () => {});
    // The background counts as it captures; show it live.
    return onSessionChange('autoCaptureStats', (next) => setStats(next ?? null));
  }, []);

  const save = (patch: Partial<AutoCaptureSettings>) => {
    const next = { ...settings, ...patch };
    props.onChange(next);
    setAutoCapture(next).catch((e) => setError(errorMessage(e)));
  };
  const saveSkip = () => {
    const hosts = parseHosts(skip);
    setSkip(hosts.join(', '));
    if (hosts.join() !== settings.skipHosts.join()) save({ skipHosts: hosts });
  };
  const nameOf = (id: string) => props.cases.find((c) => c.id === id)?.name ?? id;
  const shot = settings.depth !== 'basic';

  return (
    <>
      <div className={`auto ${settings.enabled ? 'auto-on' : ''}`}>
        <label className="auto-head">
          <span className={`rec ${settings.enabled ? 'rec-on' : ''}`} aria-hidden="true" />
          <span className="grow">
            <span className="auto-title">Auto-capture</span>
            <span className="muted small auto-sub">
              {settings.enabled
                ? `every page you visit, into ${nameOf(settings.caseId)}`
                : `capture every page you visit into ${nameOf(caseId)}`}
            </span>
          </span>
          <input
            type="checkbox"
            role="switch"
            className="switch"
            checked={settings.enabled}
            onChange={(e) => save({ enabled: e.target.checked, caseId: e.target.checked ? caseId : settings.caseId })}
          />
        </label>
        {settings.enabled && settings.caseId !== caseId && (
          <button className="link small auto-move" onClick={() => save({ caseId })}>
            Capture into {nameOf(caseId)} instead
          </button>
        )}
      </div>

      <div className="options">
        <div className="opt">
          <div className="opt-head">
            <span className="opt-label">Depth</span>
            <span className="opt-hint">{CAPTURE_DEPTHS.find((d) => d.value === settings.depth)?.title}</span>
          </div>
          <div className="segmented" role="radiogroup" aria-label="Auto-capture depth">
            {CAPTURE_DEPTHS.map((d) => (
              <button
                key={d.value}
                type="button"
                role="radio"
                aria-checked={settings.depth === d.value}
                title={d.title}
                onClick={() => save({ depth: d.value })}
              >
                {d.label}
              </button>
            ))}
          </div>
        </div>

        {shot && (
          <div className="opt">
            <div className="opt-head">
              <span className="opt-label">Screenshot</span>
            </div>
            <div className="segmented" role="radiogroup" aria-label="Auto-capture screenshot">
              {(['visible', 'full'] as const).map((scope) => {
                const Icon = SCOPE_ICONS[scope];
                return (
                  <button
                    key={scope}
                    type="button"
                    role="radio"
                    aria-checked={settings.screenshot === scope}
                    title={
                      scope === 'full' && !import.meta.env.FIREFOX
                        ? 'The whole page: Chrome shows its debugging bar during each capture'
                        : SCREENSHOT_SCOPES.find((s) => s.value === scope)?.title
                    }
                    onClick={() => save({ screenshot: scope })}
                  >
                    <Icon />
                    {scope === 'full' ? 'Full page' : 'Visible'}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <div className="opt">
          <div className="opt-head">
            <label className="opt-label" htmlFor="skip-hosts">
              Skip sites
            </label>
            <span className="opt-hint">subdomains included</span>
          </div>
          <input
            id="skip-hosts"
            placeholder="mail.example.com, bank.example…"
            value={skip}
            onChange={(e) => setSkip(e.target.value)}
            onBlur={saveSkip}
            onKeyDown={(e) => e.key === 'Enter' && saveSkip()}
          />
        </div>
      </div>

      {settings.enabled && stats && (
        <p className="muted small lead" title={stats.lastError ?? stats.lastUrl ?? ''}>
          {stats.captured} captured · {stats.unchanged} unchanged, skipped
          {stats.failed > 0 && <span className="error"> · {stats.failed} failed</span>}
        </p>
      )}
      {error && <Notice kind="error">{error}</Notice>}
    </>
  );
}

function CaptureResult({ result, caseId }: { result: CaptureOutcome; caseId: string }) {
  const { upload } = result;
  const granted = upload.timestamp.status === 'granted';
  const size = result.artifacts.reduce((sum, a) => sum + a.size, 0);
  // The card lands below the capture button, past the popup's 600px limit: bring it into view.
  const card = useRef<HTMLDivElement>(null);
  // void: Chrome's scrollIntoView now returns a promise, which React would call as the cleanup.
  useEffect(() => void card.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), []);
  return (
    <div className="card rise" ref={card}>
      <button
        className="card-title"
        title="Open in the dashboard"
        onClick={() => openDashboard({ caseId, view: 'capture', captureId: upload.captureId })}
      >
        <CircleCheck className="ok" />
        <span className="title">
          Captured #{upload.seq} · {result.title || result.url}
        </span>
        <ChevronRight className="chev" />
      </button>
      <dl>
        <dt>Record</dt>
        <dd>
          <code title={upload.recordHash}>{short(upload.recordHash)}</code>
        </dd>
        <dt>Timestamp</dt>
        <dd className={granted ? 'ok' : 'warn'}>
          {granted ? <ShieldCheck /> : <Clock />}{' '}
          {granted
            ? fmtTime(upload.timestamp.genTime ?? '')
            : `${upload.timestamp.status}${upload.timestamp.error ? `: ${upload.timestamp.error}` : ''}`}
        </dd>
        {/* One line for the files; each name's tooltip holds its hash, the dashboard all of them. */}
        <dt>Files</dt>
        <dd>
          {result.artifacts.map((a, i) => (
            <span key={a.name}>
              {i > 0 && ', '}
              <span className="file" title={`sha256 ${a.sha256}\n${a.method}`}>
                {a.name}
              </span>
            </span>
          ))}{' '}
          <span className="muted">· {(size / 1024).toFixed(0)} KB</span>
        </dd>
      </dl>
      {result.warnings.length > 0 && (
        <ul className="warnings">
          {result.warnings.map((w) => (
            <li key={w}>
              <TriangleAlert /> {w}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
