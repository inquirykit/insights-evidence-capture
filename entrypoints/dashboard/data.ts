// The dashboard's data. A signed capture never changes, so its record, its thumbnail and the
// scan of its page are each fetched once and kept for the life of the tab. Its tags and notes
// do change, as do the case's todos: they are loaded with the case and saved as they are edited.

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  errorMessage,
  sendToBackground,
  type Annotation,
  type AnnotationChange,
  type Case,
  type CaptureDetail,
  type CaptureRecord,
  type CaptureSummary,
  type Todo,
  type TodoChange,
} from '@/lib/protocol';
import { scanHtml, type PageScan } from '@/lib/selectors';
import { getWatchTerms, setWatchTerms } from '@/lib/settings';
import { readArtifact } from '@/lib/store';

/** Runs at most `n` of the functions given to it at a time, in call order. */
function limiter(n: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active < n) active++;
    else await new Promise<void>((resolve) => waiting.push(resolve));
    try {
      return await fn();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}

const jsonSlot = limiter(6);
// Screenshots run to megabytes and decode to far more; keep few in flight.
const fileSlot = limiter(3);

function memo<T>(cache: Map<string, Promise<T>>, key: string, load: () => Promise<T>): Promise<T> {
  let pending = cache.get(key);
  if (!pending) {
    pending = load();
    cache.set(key, pending);
    pending.catch(() => cache.delete(key)); // a failure may be retried
  }
  return pending;
}

const details = new Map<string, Promise<CaptureDetail>>();
const thumbnails = new Map<string, Promise<string>>();
const scans = new Map<string, Promise<PageScan>>();

export const loadCapture = (captureId: string) =>
  memo(details, captureId, () => jsonSlot(() => sendToBackground({ type: 'getCapture', captureId })));

/** The capture's screenshot: screenshot.png in older records, another image format's
 *  extension in newer ones. */
export const findScreenshot = (record: CaptureRecord) =>
  record.artifacts.find((a) => a.name.startsWith('screenshot.'));

export const loadThumbnail = (captureId: string) =>
  memo(thumbnails, captureId, async () => {
    const shot = findScreenshot((await loadCapture(captureId)).record);
    if (!shot) throw new Error('No screenshot in this capture');
    return fileSlot(async () => thumbnail(await readArtifact(captureId, shot.name)));
  });

export const loadScan = (captureId: string) =>
  memo(scans, captureId, async () => {
    const { record } = await loadCapture(captureId);
    if (!record.artifacts.some((a) => a.name === 'dom.html')) return { text: '', hits: [] };
    const html = await fileSlot(async () => (await readArtifact(captureId, 'dom.html')).text());
    return scanHtml(html, record.client.page?.documentUrl ?? null);
  });

const THUMB_WIDTH = 480;
const THUMB_ASPECT = 10 / 16;

/** The top of a full-page screenshot, scaled down: full pages decode to hundreds of MB. */
async function thumbnail(image: Blob): Promise<string> {
  const bitmap = await createImageBitmap(image);
  const sourceHeight = Math.min(bitmap.height, Math.round(bitmap.width * THUMB_ASPECT));
  const scale = Math.min(1, THUMB_WIDTH / bitmap.width);
  const canvas = new OffscreenCanvas(Math.round(bitmap.width * scale), Math.round(sourceHeight * scale));
  canvas
    .getContext('2d')!
    .drawImage(bitmap, 0, 0, bitmap.width, sourceHeight, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return URL.createObjectURL(await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.82 }));
}

// ---------------------------------------------------------------------------
// One case: its captures, then their records and page scans as they arrive

export interface CaseData {
  captures: CaptureSummary[] | null;
  error: string | null;
  details: Map<string, CaptureDetail>;
  scans: Map<string, PageScan>;
  /** Captures whose page could not be scanned */
  scanFailures: number;
  /** Tags and analyst notes, by capture; a capture never annotated has none. Null until the
   *  case's list has loaded: an edit sent before that would replace what the panel never showed */
  annotations: Map<string, Annotation> | null;
  /** Why they could not be loaded (a server from before annotations, say) */
  annotationsError: string | null;
  saveAnnotation(captureId: string, change: AnnotationChange): Promise<Annotation>;
  /** The case's to-do list, in its order; null until loaded */
  todos: Todo[] | null;
  todosError: string | null;
  /** Saves `change` applied to the list as last saved. Changes run one at a time, so quick
   *  clicks each build on the one before. */
  changeTodos(change: (todos: TodoChange[]) => TodoChange[]): Promise<void>;
  reload(): void;
}

export function useCaseData(caseId: string): CaseData {
  const [captures, setCaptures] = useState<CaptureSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(() => new Map<string, CaptureDetail>());
  const [scanned, setScanned] = useState(() => new Map<string, PageScan>());
  const [scanFailures, setScanFailures] = useState(0);
  const [annotations, setAnnotations] = useState<Map<string, Annotation> | null>(null);
  const [annotationsError, setAnnotationsError] = useState<string | null>(null);
  // The same map and the case's capture ids, for saveAnnotation: each list in a change replaces
  // the capture's, so saving before they have loaded, or for a capture of another case, would
  // delete tags and notes this view never showed.
  const loadedAnnotations = useRef<Map<string, Annotation> | null>(null);
  const caseCaptureIds = useRef<Set<string> | null>(null);
  const [todos, setTodos] = useState<Todo[] | null>(null);
  const [todosError, setTodosError] = useState<string | null>(null);
  // The list as the server last returned it (null until loaded), and the change being saved
  const savedTodos = useRef<Todo[] | null>(null);
  const todoQueue = useRef<Promise<unknown>>(Promise.resolve());
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    let live = true;
    setCaptures(null);
    setError(null);
    setLoaded(new Map());
    setScanned(new Map());
    setScanFailures(0);
    setAnnotations(null);
    setAnnotationsError(null);
    loadedAnnotations.current = null;
    caseCaptureIds.current = null;
    setTodos(null);
    setTodosError(null);
    savedTodos.current = null;
    sendToBackground({ type: 'listAnnotations', caseId }).then(
      (list) => {
        if (!live) return;
        loadedAnnotations.current = new Map(list.map((a) => [a.captureId, a]));
        setAnnotations(loadedAnnotations.current);
      },
      (e) => live && setAnnotationsError(errorMessage(e)),
    );
    sendToBackground({ type: 'listTodos', caseId }).then(
      (list) => {
        if (!live) return;
        savedTodos.current = list.todos;
        setTodos(list.todos);
      },
      (e) => live && setTodosError(errorMessage(e)),
    );
    sendToBackground({ type: 'listCaptures', caseId }).then(
      (list) => {
        if (!live) return;
        caseCaptureIds.current = new Set(list.map((c) => c.captureId));
        setCaptures(list);
        for (const c of list) {
          loadCapture(c.captureId).then(
            (d) => live && setLoaded((m) => new Map(m).set(c.captureId, d)),
            () => {},
          );
          loadScan(c.captureId).then(
            (s) => live && setScanned((m) => new Map(m).set(c.captureId, s)),
            (e) => {
              console.warn(`scan of ${c.captureId} failed:`, e);
              if (live) setScanFailures((n) => n + 1);
            },
          );
        }
      },
      (e) => live && setError(errorMessage(e)),
    );
    return () => {
      live = false;
    };
  }, [caseId, generation]);

  const reload = useCallback(() => setGeneration((g) => g + 1), []);
  const saveAnnotation = useCallback(async (captureId: string, change: AnnotationChange) => {
    if (!loadedAnnotations.current || !caseCaptureIds.current)
      throw new Error('The case has not finished loading; try again in a moment');
    if (!caseCaptureIds.current.has(captureId))
      throw new Error('This capture belongs to another case; open it there to change its tags and notes');
    const saved = await sendToBackground({ type: 'saveAnnotations', captureId, ...change });
    loadedAnnotations.current = new Map(loadedAnnotations.current).set(captureId, saved);
    setAnnotations(loadedAnnotations.current);
    return saved;
  }, []);
  const changeTodos = useCallback(
    (change: (todos: TodoChange[]) => TodoChange[]) => {
      const run = todoQueue.current.then(async () => {
        // Saving over a list that never loaded would delete it.
        if (!savedTodos.current) throw new Error('The to-do list has not loaded');
        const current = savedTodos.current.map(({ id, text, done }) => ({ id, text, done }));
        const saved = await sendToBackground({ type: 'saveTodos', caseId, todos: change(current) });
        savedTodos.current = saved.todos;
        setTodos(saved.todos);
      });
      todoQueue.current = run.catch(() => {});
      return run;
    },
    [caseId],
  );
  return {
    captures,
    error,
    details: loaded,
    scans: scanned,
    scanFailures,
    annotations,
    annotationsError,
    saveAnnotation,
    todos,
    todosError,
    changeTodos,
    reload,
  };
}

// ---------------------------------------------------------------------------
// Every case at once, for the case and tag overviews: their captures, annotations and todos

export interface CaseOverview {
  captures: CaptureSummary[] | null;
  annotations: Annotation[] | null;
  todos: Todo[] | null;
  error: string | null;
}

export interface Overview {
  byCase: Map<string, CaseOverview>;
  /** Replaces a capture's tags (its notes stay as they are) */
  saveTags(caseId: string, captureId: string, tags: string[]): Promise<void>;
  reload(): void;
}

export function useOverview(cases: Case[]): Overview {
  const [byCase, setByCase] = useState(() => new Map<string, CaseOverview>());
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    let live = true;
    const empty: CaseOverview = { captures: null, annotations: null, todos: null, error: null };
    setByCase(new Map(cases.map((c) => [c.id, empty])));
    const patch = (caseId: string, change: Partial<CaseOverview>) =>
      live &&
      setByCase((m) => {
        const next = new Map(m);
        next.set(caseId, { ...(m.get(caseId) ?? empty), ...change });
        return next;
      });
    for (const c of cases) {
      jsonSlot(() => sendToBackground({ type: 'listCaptures', caseId: c.id })).then(
        (captures) => patch(c.id, { captures }),
        (e) => patch(c.id, { captures: [], error: errorMessage(e) }),
      );
      jsonSlot(() => sendToBackground({ type: 'listAnnotations', caseId: c.id })).then(
        (annotations) => patch(c.id, { annotations }),
        (e) => patch(c.id, { annotations: [], error: errorMessage(e) }),
      );
      jsonSlot(() => sendToBackground({ type: 'listTodos', caseId: c.id })).then(
        ({ todos }) => patch(c.id, { todos }),
        (e) => patch(c.id, { todos: [], error: errorMessage(e) }),
      );
    }
    return () => {
      live = false;
    };
  }, [cases, generation]);

  const saveTags = useCallback(async (caseId: string, captureId: string, tags: string[]) => {
    const saved = await sendToBackground({ type: 'saveAnnotations', captureId, tags });
    setByCase((m) => {
      const entry = m.get(caseId);
      if (!entry?.annotations) return m;
      const others = entry.annotations.filter((a) => a.captureId !== captureId);
      return new Map(m).set(caseId, { ...entry, annotations: [...others, saved] });
    });
  }, []);
  const reload = useCallback(() => setGeneration((g) => g + 1), []);
  return { byCase, saveTags, reload };
}

// ---------------------------------------------------------------------------
// Watch terms: the user's own selectors, kept in extension storage for every case

export function useWatchTerms(): [string[], (terms: string[]) => void] {
  const [terms, setTerms] = useState<string[]>([]);
  useEffect(() => {
    getWatchTerms().then(setTerms, () => {});
  }, []);
  const save = useCallback((next: string[]) => {
    setTerms(next);
    void setWatchTerms(next);
  }, []);
  return [terms, save];
}
