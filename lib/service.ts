// HTTP client for the ai_toolkit evidence API (/evidence/* on an ai_toolkit server), with the
// connection saved in the popup (settings.ts): a base URL plus the server's API key.
//
// Only extension contexts talk to the server: the background script for JSON (server-store.ts),
// and the dashboard page for captured files (store.ts readArtifact). The key never reaches a web
// page, and the extension's host permission means no CORS setup is needed on the server.

import { errorMessage } from './protocol';
import { getConnection, type Connection } from './settings';

const EVIDENCE_PREFIX = '/evidence';

function describe(connection: Connection): string {
  return connection.baseUrl.replace(/^https?:\/\//, '');
}

async function rawFetch(connection: Connection, path: string, init: RequestInit): Promise<Response> {
  const headers = new Headers(init.headers);
  if (connection.apiKey) headers.set('Authorization', `Bearer ${connection.apiKey}`);
  try {
    return await fetch(`${connection.baseUrl}${path}`, { ...init, headers });
  } catch (e) {
    throw new Error(
      `Server not reachable at ${describe(connection)} (${errorMessage(e)}). Is the Core AI & Data toolkit running?`,
    );
  }
}

/** Fetch against the server root (used for /health). */
export async function serverFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const connection = await getConnection();
  if (!connection) throw new Error('Not connected: set the server URL and API key');
  return rawFetch(connection, path, init);
}

/** Fetch against the evidence API: `path` is relative to /evidence. */
export function serviceFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return serverFetch(`${EVIDENCE_PREFIX}${path}`, init);
}

export async function serviceJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await serviceFetch(path, init);
  return readJson<T>(res);
}

export async function readJson<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => ({}))) as { error?: unknown; detail?: unknown };
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw new Error(`${apiError(body) ?? 'Request refused'} (HTTP ${res.status}). Check the API key.`);
    }
    if (res.status === 503) {
      throw new Error(
        apiError(body) ?? 'Evidence storage is disabled on the server (ARCADEDB_PATH is empty)',
      );
    }
    throw new Error(apiError(body) ?? `Server returned HTTP ${res.status}`);
  }
  return body as T;
}

/** ai_toolkit answers `{error}` on its own routes and FastAPI's `{detail}` on validation errors. */
function apiError(body: { error?: unknown; detail?: unknown }): string | undefined {
  if (typeof body.error === 'string') return body.error;
  if (typeof body.detail === 'string') return body.detail;
  if (Array.isArray(body.detail) && body.detail.length) {
    const first = body.detail[0] as { msg?: string; loc?: unknown[] };
    if (first?.msg) return `${(first.loc ?? []).join('.')}: ${first.msg}`;
  }
  return undefined;
}
