// Watching a page's DOM for changes, in the spirit of VouchShot: what changed in the document
// before and during a capture, so the record can say whether the page held still and whether
// someone typed into it.
//
// The watcher (startDomMonitor) runs in the extension's isolated world, out of the page's reach:
// from document_start in every page loaded while "Watch DOM changes" is on (a registered
// content script, entrypoints/dom-monitor.ts; lib/dom-monitor.ts registers it), or started by
// capture.ts when the page loaded before that. capture.ts marks the start of the capture and
// reads the watcher back right after dom.html, so "during" covers the screenshot, the MHTML, the
// PDF and the DOM. The changes the archives make afterwards (SingleFile's temporary marks) are
// never counted.
//
// What it cannot tell: who made a change. Page scripts, other extensions and DevTools edits all
// look the same to a MutationObserver. Typing and pasting into editable content are the
// exception, counted as `userEdits` from the page's input events.
//
// All three functions here run in the page; mark and read are injected with
// scripting.executeScript({ func }), so like everything in lib/page/ they are self-contained
// (tests/page-functions.test.ts checks the rules). They find each other through a global in the
// isolated world (never the page's), whose name they are given: MONITOR_KEY in lib/dom-monitor.ts.

export interface MutationCounts {
  /** MutationObserver callbacks */
  batches: number;
  records: number;
  childList: number;
  attributes: number;
  characterData: number;
  nodesAdded: number;
  nodesRemoved: number;
}

export interface DomMonitorReport {
  /** documentStart: watched since the page began loading; injected: since the capture started it */
  since: 'documentStart' | 'injected';
  startedAt: string;
  /** DOMContentLoaded, when watched from the start */
  loadedAt: string | null;
  captureStartedAt: string | null;
  readAt: string;
  /** Changes while the HTML was parsed (until DOMContentLoaded): the page being built */
  whileLoading: MutationCounts;
  /** From then (or from the watcher's start) to the start of the capture */
  beforeCapture: MutationCounts;
  /** From the start of the capture to reading dom.html */
  duringCapture: MutationCounts;
  lastChangeAt: string | null;
  /** Text typed, pasted or dropped into editable content (contenteditable, designMode) while
   *  watched: changes a person made in the page, not its scripts. Form fields are not counted */
  userEdits: number;
  /** document.designMode was "on" when read: the whole page could be edited in place */
  designMode: boolean;
  /** Elements with contenteditable when read */
  editableElements: number;
  /** Changes kept in dom-changes.json, and older ones the log let go */
  logged: number;
  dropped: number;
}

/** One change, as dom-changes.json lists it (after DOMContentLoaded only). */
export interface DomChange {
  at: string;
  phase: 'before' | 'during';
  type: MutationRecordType;
  /** A CSS path to the changed node; "(detached)" when it has since left the document */
  target: string;
  attribute?: string;
  oldValue?: string | null;
  value?: string | null;
  added?: number;
  removed?: number;
  addedText?: string;
  removedText?: string;
}

export interface DomMonitorRead {
  report: DomMonitorReport;
  changes: DomChange[];
}

interface Monitor {
  /** The capture starts now: later changes count as during it */
  mark(): void;
  read(): DomMonitorRead;
}

/** Starts watching the document, once per page, kept under `key`. Bundled into
 *  entrypoints/dom-monitor.ts. */
export function startDomMonitor(key: string): void {
  const scope = globalThis as unknown as Record<string, Monitor | undefined>;
  if (scope[key]) return;

  // The changes kept in full: the latest ones, those nearest the capture.
  const MAX_CHANGES = 1000;
  // Old and new values and node text, cut to this many characters.
  const MAX_TEXT = 200;

  interface Entry {
    at: number;
    type: MutationRecordType;
    target: Node;
    attribute?: string;
    oldValue?: string | null;
    value?: string | null;
    added: number;
    removed: number;
    addedText?: string;
    removedText?: string;
  }

  const zero = (): MutationCounts => ({
    batches: 0,
    records: 0,
    childList: 0,
    attributes: 0,
    characterData: 0,
    nodesAdded: 0,
    nodesRemoved: 0,
  });
  const cut = (text: string | null | undefined) =>
    text == null ? text : text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text;
  const iso = (ms: number | null) => (ms == null ? null : new Date(ms).toISOString());

  const since = document.readyState === 'loading' ? 'documentStart' : 'injected';
  const startedAt = Date.now();
  let loadedAt: number | null = null;
  let markedAt: number | null = null;
  let lastAt: number | null = null;
  const loading = zero();
  const total = zero();
  let atMark = zero();
  const log: Entry[] = [];
  let dropped = 0;
  let userEdits = 0;

  // The capture's own region/element picker, drawn and removed by picker.ts.
  const isPicker = (node: Node) =>
    node.nodeType === Node.ELEMENT_NODE && (node as Element).hasAttribute('data-evidence-capture-picker');
  const ours = (r: MutationRecord) =>
    r.type === 'childList' &&
    r.addedNodes.length + r.removedNodes.length > 0 &&
    [...r.addedNodes, ...r.removedNodes].every(isPicker);
  const textOf = (nodes: NodeList) => {
    let text = '';
    for (const node of nodes) {
      text += node.textContent ?? '';
      if (text.length > MAX_TEXT) break;
    }
    return cut(text.trim()) || undefined;
  };

  if (since === 'documentStart') {
    document.addEventListener('DOMContentLoaded', () => (loadedAt = Date.now()), { once: true });
  }

  const observer = new MutationObserver((records) => {
    const now = Date.now();
    const parsing = since === 'documentStart' && loadedAt === null;
    const counts = parsing ? loading : total;
    let counted = 0;
    for (const r of records) {
      if (ours(r)) continue;
      counted++;
      counts.records++;
      counts[r.type]++;
      counts.nodesAdded += r.addedNodes.length;
      counts.nodesRemoved += r.removedNodes.length;
      // The parser building the page is counted, not logged.
      if (parsing) continue;
      const entry: Entry = {
        at: now,
        type: r.type,
        target: r.target,
        added: r.addedNodes.length,
        removed: r.removedNodes.length,
      };
      if (r.type === 'attributes') {
        entry.attribute = r.attributeName ?? undefined;
        entry.oldValue = cut(r.oldValue);
        entry.value = cut(r.attributeName ? (r.target as Element).getAttribute(r.attributeName) : null);
      } else if (r.type === 'characterData') {
        entry.oldValue = cut(r.oldValue);
        entry.value = cut(r.target.nodeValue);
      } else {
        entry.addedText = textOf(r.addedNodes);
        entry.removedText = textOf(r.removedNodes);
      }
      log.push(entry);
      if (log.length > MAX_CHANGES) {
        log.shift();
        dropped++;
      }
    }
    if (counted) {
      counts.batches++;
      lastAt = now;
    }
  });
  observer.observe(document, {
    subtree: true,
    childList: true,
    attributes: true,
    characterData: true,
    attributeOldValue: true,
    characterDataOldValue: true,
  });

  // Typing, pasting and dropping fire input events; scripts changing the DOM do not.
  addEventListener(
    'input',
    (e) => {
      const target = e.target as HTMLElement | null;
      if (!target || target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
      if (target.isContentEditable || document.designMode === 'on') userEdits++;
    },
    true,
  );

  /** A CSS path from the nearest ancestor with an id (or the root) down to the node. */
  const pathOf = (node: Node): string => {
    const suffix =
      node.nodeType === Node.TEXT_NODE ? ' > #text' : node.nodeType === Node.COMMENT_NODE ? ' > #comment' : '';
    let el: Element | null = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
    const parts: string[] = [];
    while (el) {
      if (el.id) {
        parts.unshift(`${el.localName}#${CSS.escape(el.id)}`);
        break;
      }
      let part = el.localName;
      const parent: Element | null = el.parentElement;
      if (parent) {
        const same = [...parent.children].filter((c) => c.localName === el!.localName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(el) + 1})`;
      }
      parts.unshift(part);
      el = parent;
    }
    const path = (parts.join(' > ') || node.nodeName.toLowerCase()) + suffix;
    return node.isConnected ? path : `(detached) ${path}`;
  };

  const minus = (a: MutationCounts, b: MutationCounts): MutationCounts => {
    const out = zero();
    for (const field of Object.keys(out) as (keyof MutationCounts)[]) out[field] = a[field] - b[field];
    return out;
  };

  scope[key] = {
    mark() {
      markedAt = Date.now();
      atMark = { ...total };
    },
    read() {
      const report: DomMonitorReport = {
        since,
        startedAt: iso(startedAt)!,
        loadedAt: iso(loadedAt),
        captureStartedAt: iso(markedAt),
        readAt: new Date().toISOString(),
        whileLoading: { ...loading },
        beforeCapture: markedAt === null ? { ...total } : { ...atMark },
        duringCapture: markedAt === null ? zero() : minus(total, atMark),
        lastChangeAt: iso(lastAt),
        userEdits,
        designMode: document.designMode === 'on',
        editableElements: document.querySelectorAll('[contenteditable]:not([contenteditable="false"])').length,
        logged: log.length,
        dropped,
      };
      const changes = log.map(({ at, target, ...rest }) => ({
        at: new Date(at).toISOString(),
        phase: markedAt !== null && at >= markedAt ? ('during' as const) : ('before' as const),
        target: pathOf(target),
        ...rest,
      }));
      return { report, changes };
    },
  };
}

// ---------------------------------------------------------------------------
// Injected by capture.ts with the watcher's key

/** Marks the start of the capture; false when the page has no watcher. */
export function markDomMonitor(key: string): boolean {
  const monitor = (globalThis as unknown as Record<string, Monitor | undefined>)[key];
  monitor?.mark();
  return !!monitor;
}

export function readDomMonitor(key: string): DomMonitorRead | null {
  const monitor = (globalThis as unknown as Record<string, Monitor | undefined>)[key];
  return monitor ? monitor.read() : null;
}
