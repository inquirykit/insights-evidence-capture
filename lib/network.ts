// Passively records the latest top-level document response per tab: status, headers,
// server IP, redirect chain and (Firefox only) the TLS certificate chain. This is what
// the server actually sent, as opposed to the DOM after scripts ran. Kept in
// storage.session so it survives the Chrome service worker being suspended.
//
// Limitation: single-page-app navigations (history.pushState) don't create a new
// document request, so the capture metadata flags whether the URLs still match.

import { firefox, type FirefoxSecurityInfo } from './firefox';
import { mainFrameKey, readSession, removeSession, writeSession } from './settings';

export interface TlsSummary {
  state: string;
  protocolVersion?: string;
  cipherSuite?: string;
  certificateTransparencyStatus?: string;
  hsts?: boolean;
  certificates: {
    subject: string;
    issuer: string;
    serialNumber: string;
    notBefore: string;
    notAfter: string;
    sha256Fingerprint: string;
  }[];
}

export interface MainFrameResponse {
  requestId: string;
  url: string;
  statusCode?: number;
  statusLine?: string;
  ip?: string;
  fromCache?: boolean;
  responseHeaders?: { name: string; value?: string }[];
  redirects: { from: string; to: string; statusCode: number }[];
  observedAt?: string;
  tls?: TlsSummary;
}

const FILTER = { urls: ['<all_urls>'], types: ['main_frame' as const] };

// The user's session, not a fact about the page: never kept, so it is never signed into a record.
// Firefox shows these to extensions; Chrome only with 'extraHeaders', which isn't asked for.
const CREDENTIAL_HEADERS = new Set(['set-cookie', 'set-cookie2']);

// Serialize read-modify-write updates; listeners for one request can overlap.
let queue: Promise<unknown> = Promise.resolve();

function update(tabId: number, requestId: string, patch: (r: MainFrameResponse) => void) {
  if (tabId < 0) return;
  queue = queue
    .then(async () => {
      const key = mainFrameKey(tabId);
      const stored = await readSession(key);
      // A new requestId means a new navigation; redirects keep the same id.
      const rec: MainFrameResponse =
        stored?.requestId === requestId ? stored : { requestId, url: '', redirects: [] };
      patch(rec);
      await writeSession(key, rec);
    })
    .catch((e) => console.warn('network recorder:', e));
}

export async function getMainFrameResponse(tabId: number): Promise<MainFrameResponse | null> {
  await queue;
  return (await readSession(mainFrameKey(tabId))) ?? null;
}

export function startNetworkRecorder() {
  browser.webRequest.onBeforeRedirect.addListener(
    (d) =>
      update(d.tabId, d.requestId, (r) => {
        r.redirects.push({ from: d.url, to: d.redirectUrl, statusCode: d.statusCode });
      }),
    FILTER,
  );

  browser.webRequest.onResponseStarted.addListener(
    (d) =>
      update(d.tabId, d.requestId, (r) => {
        r.url = d.url;
        r.statusCode = d.statusCode;
        r.statusLine = d.statusLine;
        r.ip = d.ip;
        r.fromCache = d.fromCache;
        r.responseHeaders = d.responseHeaders?.filter((h) => !CREDENTIAL_HEADERS.has(h.name.toLowerCase()));
        r.observedAt = new Date().toISOString();
      }),
    FILTER,
    ['responseHeaders'],
  );

  if (import.meta.env.FIREFOX) {
    // getSecurityInfo() only works inside a *blocking* onHeadersReceived listener.
    // We never modify the response; returning {} lets it through unchanged.
    const listener = async (d: { tabId: number; requestId: string }) => {
      try {
        const info = await firefox.webRequest.getSecurityInfo(d.requestId, { certificateChain: true });
        update(d.tabId, d.requestId, (r) => {
          r.tls = summarizeTls(info);
        });
      } catch (e) {
        console.warn('getSecurityInfo failed:', e);
      }
      return {};
    };
    browser.webRequest.onHeadersReceived.addListener(
      listener as unknown as Parameters<typeof browser.webRequest.onHeadersReceived.addListener>[0],
      FILTER,
      ['blocking'],
    );
  }

  browser.tabs.onRemoved.addListener((tabId) => {
    void removeSession(mainFrameKey(tabId));
  });
}

function summarizeTls(info: FirefoxSecurityInfo): TlsSummary {
  return {
    state: info.state,
    protocolVersion: info.protocolVersion,
    cipherSuite: info.cipherSuite,
    certificateTransparencyStatus: info.certificateTransparencyStatus,
    hsts: info.hsts,
    certificates: (info.certificates ?? []).map((c) => ({
      subject: c.subject,
      issuer: c.issuer,
      serialNumber: c.serialNumber,
      notBefore: new Date(c.validity.start).toISOString(),
      notAfter: new Date(c.validity.end).toISOString(),
      sha256Fingerprint: c.fingerprint.sha256,
    })),
  };
}
