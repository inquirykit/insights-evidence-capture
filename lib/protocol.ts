// Messages between the extension pages (popup, dashboard) and the background script, plus
// the service's JSON shapes.

import { MAX_TAG, normalizeTag } from './limits';
import type { MainFrameResponse } from './network';
import type { CaptureDepth, CaptureOptions } from './options';
import type { DomMonitorReport } from './page/dom-monitor';
import type { ScrollResult } from './page/scroll';

export interface Case {
  id: string;
  name: string;
  createdAt: string;
}

export interface CaptureSummary {
  seq: number;
  captureId: string;
  receivedAt: string;
  url: string | null;
  title: string | null;
  recordHash: string;
  timestampedAt: string | null;
}

export interface UploadResult {
  captureId: string;
  seq: number;
  receivedAt: string;
  recordHash: string;
  signature: string;
  timestamp: {
    status: 'granted' | 'failed' | 'disabled';
    genTime?: string;
    error?: string;
    tsa?: string;
  };
}

export interface ArtifactSummary {
  name: string;
  sha256: string;
  size: number;
  method: string;
}

/** What a compressed artifact decompresses to, so the original can be checked against the record */
export interface Uncompressed {
  mediaType: string;
  sha256: string;
  size: number;
}

export interface CaptureOutcome {
  upload: UploadResult;
  url: string;
  title: string;
  artifacts: ArtifactSummary[];
  warnings: string[];
}

/** A rectangle in CSS pixels relative to the top-left of the document. */
export interface PageRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** What the user pointed at, when the capture was more than the page. Signed with the record. */
export type SelectionMetadata =
  | { kind: 'region'; rect: PageRect }
  | { kind: 'element'; rect: PageRect; tag: string; selector: string; xpath: string; text: string }
  | { kind: 'text'; text: string; xpath: string; rect?: PageRect; frameId: number }
  | { kind: 'image'; srcUrl: string; frameId: number };

/** The page reloaded before the capture (options.reload). */
export interface ReloadMetadata {
  requestedAt: string;
  /** When the reloaded page finished loading; null when it had not within the time limit */
  loadedAt: string | null;
}

/** What the extension sends with a capture, as the record keeps it: capture.ts builds it to this
 *  type, and it is signed as it is. Records are stored verbatim, so ones made by older versions
 *  may lack any field. */
export interface ClientMetadata {
  schema?: string;
  caseId?: string;
  note?: string;
  /** auto: auto-capture, on a page the user visited */
  trigger?: 'popup' | 'shortcut' | 'contextMenu' | 'auto';
  options?: Partial<CaptureOptions> & { depth?: CaptureDepth | 'custom' };
  selection?: SelectionMetadata;
  reload?: ReloadMetadata;
  scroll?: ScrollResult;
  domMonitor?: DomMonitorReport;
  startedAt?: string;
  finishedAt?: string;
  page?: {
    tabUrl?: string;
    documentUrl?: string;
    title?: string;
    characterSet?: string;
    contentType?: string;
    lastModified?: string;
    referrer?: string;
    viewport?: { width: number; height: number };
    /** Where the page was scrolled to when it was read */
    scrollPosition?: { x: number; y: number };
    scrollSize?: { width: number; height: number };
    devicePixelRatio?: number;
  };
  network?: { mainFrame?: MainFrameResponse | null };
  environment?: {
    userAgent?: string;
    browser?: { name?: string; version?: string };
    platform?: { os?: string; arch?: string };
    timeZone?: string;
    extension?: { id?: string; version?: string };
  };
  warnings?: string[];
  artifacts?: (ArtifactSummary & { mediaType?: string; capturedAt?: string; uncompressed?: Uncompressed })[];
}

export interface EnrichmentItem {
  value: string;
  type: string;
  /** The enrichers' answer: `merged` is what they agree on, keyed by field */
  results?: { merged?: Record<string, unknown>; results?: unknown[] };
  error?: string;
}

/** The signed record (evidence-capture/record/v3; v2 before workspaces) */
export interface CaptureRecord {
  schema: string;
  seq: number;
  captureId: string;
  workspaceId?: string;
  caseId: string;
  receivedAt: string;
  prevRecordHash: string;
  service: { name: string; version: string; signingKeySha256: string };
  artifacts: { name: string; mediaType: string; size: number; sha256: string }[];
  client: ClientMetadata;
  enrichment: { skipped: true } | { startedAt: string; finishedAt: string; items: EnrichmentItem[] };
}

/** GET /evidence/captures/{id}, or the browser store's equivalent */
export interface CaptureDetail {
  record: CaptureRecord;
  recordHash: string;
  signature: string;
  /** token: the TimeStampResp, base64 DER (record.tsr); the browser store gives it */
  timestamp: { genTime: string | null; error: string | null; token?: string };
}

export interface VerifyReport {
  ok: boolean;
  records: number;
  timestamped: number;
  headHash: string | null;
  signingKeySha256: string;
  /** The signing key as SubjectPublicKeyInfo PEM, when the store gives it (the browser store does) */
  publicKeyPem?: string;
  issues: { severity: 'error' | 'warning'; seq: number; captureId: string; message: string }[];
}

// ---------------------------------------------------------------------------
// Tags and analyst notes: kept by the server apart from the signed records, and editable

export interface AnalystNote {
  id: string;
  text: string;
  createdAt: string;
  updatedAt: string | null;
}

/** GET /evidence/cases/{id}/annotations lists these; a capture never annotated has none. */
export interface Annotation {
  captureId: string;
  tags: string[];
  notes: AnalystNote[];
  updatedAt: string;
}

/** PUT /evidence/captures/{id}/annotations: each list given replaces the capture's. A note
 *  without an id is new; a note left out is deleted. */
export interface AnnotationChange {
  tags?: string[];
  notes?: { id?: string; text: string }[];
}

/** "a, b,  b " → ["a", "b"]: as the server keeps tags (trimmed, inner spaces collapsed,
 *  de-duplicated case-insensitively with the first spelling kept, 1-64 characters each). */
export function parseTags(text: string): string[] {
  return mergeTags([], text.split(','));
}

/** What the user typed, made into tags the stores accept: one longer than MAX_TAG is cut to it
 *  here, where the stores would refuse it. */
export function mergeTags(tags: string[], more: string[]): string[] {
  const out = [...tags];
  for (const raw of more) {
    const tag = normalizeTag(raw).slice(0, MAX_TAG);
    if (tag && !out.some((t) => t.toLowerCase() === tag.toLowerCase())) out.push(tag);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Todos: a case's to-do list, kept by the server like annotations, apart from the records

export interface Todo {
  id: string;
  text: string;
  done: boolean;
  createdAt: string;
  /** When the text last changed */
  updatedAt: string | null;
  /** When it was checked; null while open */
  doneAt: string | null;
}

/** GET and PUT /evidence/cases/{id}/todos */
export interface CaseTodos {
  caseId: string;
  todos: Todo[];
  /** null for a case whose list was never saved */
  updatedAt: string | null;
}

/** PUT /evidence/cases/{id}/todos replaces the list, in this order. A todo without an id is
 *  new; one left out is deleted. */
export type TodoChange = { id?: string; text: string; done: boolean };

/** Where captures are kept, per browser profile: in this browser (IndexedDB, signed and
 *  timestamped by the extension) or on an ai_toolkit server. */
export type StoreMode = 'browser' | 'server';

export interface Status {
  store: StoreMode;
  /** unconfigured: no server saved yet; offline: saved but unreachable or refusing us. With the
   *  browser store: offline when this browser cannot run it (no Ed25519, no IndexedDB) */
  service: 'online' | 'offline' | 'unconfigured';
  /** defaultKey: the key in use is the build's WXT_DEFAULT_API_KEY, not one saved in the popup */
  connection: { baseUrl: string; hasKey: boolean; defaultKey: boolean } | null;
  /** Server-reported name/version, when it answered */
  server?: { name?: string; version?: string };
  lastCaseId: string | null;
  error?: string;
}

export type BgRequest =
  | { type: 'status' }
  /** apiKey undefined keeps the saved key; empty string clears it */
  | { type: 'setConnection'; baseUrl: string; apiKey?: string }
  /** Keep captures in this browser, or on the saved server */
  | { type: 'setStore'; store: StoreMode }
  | { type: 'disconnect' }
  | { type: 'listCases' }
  | { type: 'createCase'; name: string }
  | { type: 'listCaptures'; caseId: string }
  | { type: 'getCapture'; captureId: string }
  /** tags go to the capture's annotations once it is stored, not into the signed record */
  | { type: 'capture'; tabId: number; caseId: string; options: CaptureOptions; note?: string; tags?: string[] }
  /** Starts a capture and returns at once: for region and element picks, where the popup
   *  closes as soon as the user clicks the page. The badge shows the outcome. */
  | {
      type: 'captureDetached';
      tabId: number;
      caseId: string;
      options: CaptureOptions;
      note?: string;
      tags?: string[];
    }
  | { type: 'listAnnotations'; caseId: string }
  | ({ type: 'saveAnnotations'; captureId: string } & AnnotationChange)
  | { type: 'listTodos'; caseId: string }
  | { type: 'saveTodos'; caseId: string; todos: TodoChange[] }
  | { type: 'verify' }
  /** From page-singlefile.ts in a captured page: fetch a resource the page itself can't (CORS) */
  | { type: 'fetchResource'; url: string; headers?: Record<string, string> };

/** A resource fetched by the background for a script in the page; body is base64 */
export interface FetchedResource {
  status: number;
  url: string;
  headers: Record<string, string>;
  body: string;
}

export interface BgResponses {
  status: Status;
  setConnection: Status;
  setStore: Status;
  disconnect: Status;
  listCases: Case[];
  createCase: Case;
  listCaptures: CaptureSummary[];
  getCapture: CaptureDetail;
  capture: CaptureOutcome;
  captureDetached: null;
  listAnnotations: Annotation[];
  saveAnnotations: Annotation;
  listTodos: CaseTodos;
  saveTodos: CaseTodos;
  verify: VerifyReport;
  fetchResource: FetchedResource;
}

export type BgReply<T> = { ok: true; data: T } | { ok: false; error: string };

export async function sendToBackground<K extends BgRequest['type']>(
  msg: Extract<BgRequest, { type: K }>,
): Promise<BgResponses[K]> {
  const reply = (await browser.runtime.sendMessage(msg)) as BgReply<BgResponses[K]> | undefined;
  if (!reply) throw new Error('No response from background script');
  if (!reply.ok) throw new Error(reply.error);
  return reply.data;
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
