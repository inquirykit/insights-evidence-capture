// Where captures are kept, per browser profile: this browser's IndexedDB (local-store.ts) or the
// ai_toolkit server (server-store.ts). Both do the same things behind one interface, so callers
// never ask which one they have.
//
// The background script is the one caller of everything but readArtifact: the browser store
// chains appends one at a time within a single context, so captures must all go through it.
// Extension pages read artifact bytes here themselves (readArtifact), since binary bodies can't
// cross runtime messaging.

import { browserStore } from './local-store';
import type {
  Annotation,
  AnnotationChange,
  CaptureDetail,
  CaptureSummary,
  Case,
  CaseTodos,
  ClientMetadata,
  TodoChange,
  UploadResult,
  VerifyReport,
} from './protocol';
import { serverStore } from './server-store';
import { getStoreMode } from './settings';

/** A file of a capture, as capture.ts made it, before the store has checked it. */
export interface IncomingArtifact {
  name: string;
  mediaType: string;
  bytes: Uint8Array<ArrayBuffer>;
}

export interface EvidenceStore {
  listCases(): Promise<Case[]>;
  createCase(name: string): Promise<Case>;
  /** Newest first */
  listCaptures(caseId: string): Promise<CaptureSummary[]>;
  getCapture(captureId: string): Promise<CaptureDetail>;
  /** Re-hashes every file against the metadata, then signs, chains, timestamps and keeps the capture */
  append(caseId: string, metadata: ClientMetadata, files: IncomingArtifact[]): Promise<UploadResult>;
  /** A captured file's bytes */
  readArtifact(captureId: string, name: string): Promise<Blob>;
  listAnnotations(caseId: string): Promise<Annotation[]>;
  saveAnnotations(captureId: string, change: AnnotationChange): Promise<Annotation>;
  listTodos(caseId: string): Promise<CaseTodos>;
  saveTodos(caseId: string, todos: TodoChange[]): Promise<CaseTodos>;
  /** Re-checks the whole chain: hashes, signatures, files and timestamp tokens */
  verify(): Promise<VerifyReport>;
}

export async function currentStore(): Promise<EvidenceStore> {
  return (await getStoreMode()) === 'browser' ? browserStore : serverStore;
}

/** A captured file, from whichever store is in use. For extension pages (the dashboard). */
export async function readArtifact(captureId: string, name: string): Promise<Blob> {
  return (await currentStore()).readArtifact(captureId, name);
}
