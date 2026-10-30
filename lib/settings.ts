// What the extension keeps in browser storage, every key with the type of its value: each key is
// named here, so no two modules can take the same one, and a misspelt key is a type error.
// storage.local holds the user's settings, for good; storage.session holds what the background
// needs across Chrome stopping its service worker, for the browser session.
//
// The store choice, the connection, the last case and the watch terms are read and written here.
// The capture options, the auto-capture settings and the tag looks have their defaults and rules
// in options.ts and tags.ts, which keep them under the keys below.

import type { MainFrameResponse } from './network';
import type { AutoCaptureSettings, AutoCaptureStats, CaptureOptions } from './options';
import type { StoreMode } from './protocol';
import type { TagDefs } from './tags';

export interface LocalItems {
  /** The ai_toolkit server, as saved from the popup (getConnection) */
  connection: Connection;
  /** Where captures are kept (getStoreMode) */
  store: StoreMode;
  /** The case the shortcut and the context menu capture into, and the popup opens on */
  lastCaseId: string;
  /** options.ts */
  captureOptions: Partial<CaptureOptions>;
  /** options.ts */
  autoCapture: Partial<AutoCaptureSettings>;
  /** tags.ts: how tags look, by tag lower-cased */
  tagDefs: TagDefs;
  /** The dashboard's own selectors, matched across every case */
  watchTerms: string[];
}

export interface SessionItems {
  /** Auto-capture: the hash of each page's text when it was last captured, by store, case,
   *  depth and URL */
  autoCaptureSeen: Record<string, string>;
  /** options.ts: what auto-capture did since it was turned on */
  autoCaptureStats: AutoCaptureStats;
  /** network.ts: the latest document response of a tab (mainFrameKey) */
  [tab: `net:${number}`]: MainFrameResponse;
}

export const mainFrameKey = (tabId: number) => `net:${tabId}` as const;

export async function readLocal<K extends keyof LocalItems>(key: K): Promise<LocalItems[K] | undefined> {
  return (await browser.storage.local.get(key))[key] as LocalItems[K] | undefined;
}

export async function writeLocal<K extends keyof LocalItems>(key: K, value: LocalItems[K]): Promise<void> {
  await browser.storage.local.set({ [key]: value });
}

export async function removeLocal(key: keyof LocalItems): Promise<void> {
  await browser.storage.local.remove(key);
}

export async function readSession<K extends keyof SessionItems>(key: K): Promise<SessionItems[K] | undefined> {
  return (await browser.storage.session.get(key))[key] as SessionItems[K] | undefined;
}

export async function writeSession<K extends keyof SessionItems>(key: K, value: SessionItems[K]): Promise<void> {
  await browser.storage.session.set({ [key]: value });
}

export async function removeSession(key: keyof SessionItems): Promise<void> {
  await browser.storage.session.remove(key as string);
}

/** Calls `listener` with the new and the old value each time `key` changes in storage.local.
 *  Returns the function that stops it. */
export function onLocalChange<K extends keyof LocalItems>(
  key: K,
  listener: (value: LocalItems[K] | undefined, old: LocalItems[K] | undefined) => void,
): () => void {
  return onChange('local', key, listener);
}

export function onSessionChange<K extends keyof SessionItems>(
  key: K,
  listener: (value: SessionItems[K] | undefined, old: SessionItems[K] | undefined) => void,
): () => void {
  return onChange('session', key, listener);
}

function onChange(area: 'local' | 'session', key: string, listener: (value: never, old: never) => void) {
  const handler: Parameters<typeof browser.storage.onChanged.addListener>[0] = (changes, changedArea) => {
    const change = changes[key];
    // An absent value is left out (Chrome) or null (some others): undefined either way.
    if (changedArea === area && change) listener((change.newValue ?? undefined) as never, (change.oldValue ?? undefined) as never);
  };
  browser.storage.onChanged.addListener(handler);
  return () => browser.storage.onChanged.removeListener(handler);
}

// ---------------------------------------------------------------------------
// Where captures are kept, and the server

export const DEFAULT_BASE_URL = 'http://localhost:8000';
// Built in from WXT_DEFAULT_API_KEY in .env.local (gitignored), by `bun run dev` only:
// a production build (`bun run build`, `bun run zip`) never carries it. Empty when unset.
// WXT reads .env files once at startup, so restart `bun run dev` after changing it.
const DEFAULT_API_KEY: string = import.meta.env.COMMAND === 'serve' ? (import.meta.env.WXT_DEFAULT_API_KEY ?? '') : '';

export interface Connection {
  /** Origin of the ai_toolkit server, no trailing slash, e.g. http://localhost:8000 */
  baseUrl: string;
  /** API_KEY (or ADMIN_API_KEY) of the server; empty when the server runs without one */
  apiKey: string;
  /** Empty for the built-in default, which is never saved */
  savedAt: string;
}

/** Where captures are kept, per browser profile. The server, as before there was a choice,
 *  until the popup says otherwise. */
export async function getStoreMode(): Promise<StoreMode> {
  return (await readLocal('store')) === 'browser' ? 'browser' : 'server';
}

export async function setStoreMode(store: StoreMode): Promise<void> {
  await writeLocal('store', store);
}

/** The saved connection, or the built-in default key on DEFAULT_BASE_URL until one is saved.
 *  A saved connection without a key (the popup's key field left empty) also uses the built-in
 *  key, so a build with WXT_DEFAULT_API_KEY never sends an unauthenticated request. */
export async function getConnection(): Promise<Connection | null> {
  const saved = await readLocal('connection');
  if (saved?.apiKey) return saved;
  if (!DEFAULT_API_KEY) return saved ?? null;
  return { baseUrl: saved?.baseUrl ?? DEFAULT_BASE_URL, apiKey: DEFAULT_API_KEY, savedAt: saved?.savedAt ?? '' };
}

/** True when the key in use is the built-in default rather than one saved from the popup. */
export async function usesDefaultKey(): Promise<boolean> {
  if (!DEFAULT_API_KEY) return false;
  return !(await readLocal('connection'))?.apiKey;
}

/** `apiKey` undefined keeps the key already saved (if any); an empty string clears it. */
export async function setConnection(baseUrl: string, apiKey?: string): Promise<Connection> {
  const previous = apiKey === undefined ? await getConnection() : null;
  const connection: Connection = {
    baseUrl: normalizeBaseUrl(baseUrl),
    apiKey: (apiKey ?? previous?.apiKey ?? '').trim(),
    savedAt: new Date().toISOString(),
  };
  await writeLocal('connection', connection);
  return connection;
}

export async function clearConnection(): Promise<void> {
  await removeLocal('connection');
}

/** Accepts "localhost:8000", "http://host:8000/", "https://host" and returns an origin. */
export function normalizeBaseUrl(input: string): string {
  let text = input.trim();
  if (!text) text = DEFAULT_BASE_URL;
  if (!/^https?:\/\//i.test(text)) text = `http://${text}`;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`Invalid server URL: ${input}`);
  }
  if (url.search || url.hash) throw new Error('Server URL must not contain a query or fragment');
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.origin}${path}`;
}

// ---------------------------------------------------------------------------
// The rest of the user's own

export async function getLastCaseId(): Promise<string | null> {
  return (await readLocal('lastCaseId')) ?? null;
}

export async function setLastCaseId(caseId: string): Promise<void> {
  await writeLocal('lastCaseId', caseId);
}

export async function getWatchTerms(): Promise<string[]> {
  return (await readLocal('watchTerms')) ?? [];
}

export async function setWatchTerms(terms: string[]): Promise<void> {
  await writeLocal('watchTerms', terms);
}
