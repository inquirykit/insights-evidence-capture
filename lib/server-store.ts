// The server store: the ai_toolkit evidence API (/evidence/*), reached with the saved
// connection through service.ts.

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
import { readJson, serviceFetch, serviceJson } from './service';
import type { EvidenceStore, IncomingArtifact } from './store';

const json = (body: unknown): RequestInit => ({
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export async function listCases(): Promise<Case[]> {
  return (await serviceJson<{ cases: Case[] }>('/cases')).cases;
}

export async function createCase(name: string): Promise<Case> {
  const { case: created } = await serviceJson<{ case: Case }>('/cases', { ...json({ name }), method: 'POST' });
  return created;
}

export async function listCaptures(caseId: string): Promise<CaptureSummary[]> {
  return (await serviceJson<{ captures: CaptureSummary[] }>(`/cases/${encodeURIComponent(caseId)}/captures`)).captures;
}

export function getCapture(captureId: string): Promise<CaptureDetail> {
  return serviceJson<CaptureDetail>(`/captures/${encodeURIComponent(captureId)}`);
}

/** POST /evidence/captures: the metadata and every artifact, which the server re-hashes. The
 *  server takes the case from metadata.caseId. */
export function append(_caseId: string, metadata: ClientMetadata, files: IncomingArtifact[]): Promise<UploadResult> {
  const form = new FormData();
  form.append('metadata', JSON.stringify(metadata));
  for (const f of files) form.append('file', new Blob([f.bytes], { type: f.mediaType }), f.name);
  return serviceJson<UploadResult>('/captures', { method: 'POST', body: form });
}

export async function readArtifact(captureId: string, name: string): Promise<Blob> {
  const res = await serviceFetch(
    `/captures/${encodeURIComponent(captureId)}/artifacts/${encodeURIComponent(name)}`,
  );
  if (!res.ok) await readJson(res); // throws the server's error
  return res.blob();
}

export async function listAnnotations(caseId: string): Promise<Annotation[]> {
  return (await serviceJson<{ annotations: Annotation[] }>(`/cases/${encodeURIComponent(caseId)}/annotations`)).annotations;
}

export function saveAnnotations(captureId: string, change: AnnotationChange): Promise<Annotation> {
  return serviceJson<Annotation>(`/captures/${encodeURIComponent(captureId)}/annotations`, json(change));
}

export function listTodos(caseId: string): Promise<CaseTodos> {
  return serviceJson<CaseTodos>(`/cases/${encodeURIComponent(caseId)}/todos`);
}

export function saveTodos(caseId: string, todos: TodoChange[]): Promise<CaseTodos> {
  return serviceJson<CaseTodos>(`/cases/${encodeURIComponent(caseId)}/todos`, json({ todos }));
}

export function verify(): Promise<VerifyReport> {
  return serviceJson<VerifyReport>('/verify');
}

export const serverStore: EvidenceStore = {
  listCases,
  createCase,
  listCaptures,
  getCapture,
  append,
  readArtifact,
  listAnnotations,
  saveAnnotations,
  listTodos,
  saveTodos,
  verify,
};
