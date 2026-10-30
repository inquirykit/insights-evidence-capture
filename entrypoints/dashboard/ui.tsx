// Small pieces the dashboard's views share: formatting, hooks, a copyable hash, file saving.

import { useEffect, useState, type RefObject } from 'react';

import { base64ToBytes, hexToBytes } from '@/lib/bytes';
import { canonicalize } from '@/lib/canonical';
import type { CaptureDetail, CaptureSummary } from '@/lib/protocol';
import { readArtifact } from '@/lib/store';

// ---------------------------------------------------------------------------
// Words

export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '–';
  const t = Date.parse(iso);
  return Number.isNaN(t)
    ? iso
    : new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' });
}

export function fmtDay(iso: string): string {
  const t = Date.parse(iso);
  return Number.isNaN(t)
    ? iso
    : new Date(t).toLocaleDateString(undefined, {
        weekday: 'short',
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      });
}

/** The local calendar day of an ISO time, for grouping. */
export function dayKey(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export const shortHash = (hash: string, chars = 10) =>
  hash.length <= chars * 2 + 1 ? hash : `${hash.slice(0, chars)}…${hash.slice(-6)}`;

export const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;

/** "www.example.com" and "example.com" are one site. */
export function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '') || null;
  } catch {
    return null;
  }
}

export const pageUrl = (c: CaptureSummary, d?: CaptureDetail) => d?.record.client.page?.documentUrl ?? c.url;

export const captureLabel = (c: CaptureSummary) => c.title?.trim() || c.url || c.captureId;

// ---------------------------------------------------------------------------
// Hooks

export function useHash(): string {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const onChange = () => setHash(location.hash);
    addEventListener('hashchange', onChange);
    return () => removeEventListener('hashchange', onChange);
  }, []);
  return hash;
}

/** True once the element has come near the viewport; stays true. */
export function useSeen(ref: RefObject<Element | null>): boolean {
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    if (seen || !ref.current) return;
    const observer = new IntersectionObserver(
      (entries) => entries.some((e) => e.isIntersecting) && setSeen(true),
      {
        rootMargin: '400px',
      },
    );
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [ref, seen]);
  return seen;
}

// ---------------------------------------------------------------------------
// Components

/** A hash, shortened; the whole of it in the tooltip and on the clipboard when clicked. */
export function Hash({ value, chars }: { value: string; chars?: number }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="hash"
      title={`${value}\nClick to copy`}
      onClick={() =>
        navigator.clipboard.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        })
      }
    >
      {copied ? 'copied' : shortHash(value, chars)}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Files

function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export async function downloadArtifact(capture: { captureId: string; seq: number }, name: string) {
  saveBlob(await readArtifact(capture.captureId, name), `capture-${capture.seq}-${name}`);
}

/** The record's files as the server lays them out, for `openssl pkeyutl -verify` and
 *  `openssl ts -verify`: the canonical bytes (which re-serializing the record gives back),
 *  the raw signature and, when the store handed it over, the timestamp token. */
export function downloadRecordBundle(detail: CaptureDetail) {
  const { seq } = detail.record;
  saveBlob(new Blob([canonicalize(detail.record)], { type: 'application/json' }), `capture-${seq}-record.json`);
  saveBlob(new Blob([hexToBytes(detail.signature)], { type: 'application/octet-stream' }), `capture-${seq}-record.sig`);
  if (detail.timestamp.token)
    saveBlob(
      new Blob([base64ToBytes(detail.timestamp.token)], { type: 'application/timestamp-reply' }),
      `capture-${seq}-record.tsr`,
    );
}

export function downloadText(filename: string, text: string, type = 'text/plain;charset=utf-8') {
  saveBlob(new Blob([text], { type }), filename);
}

// Types whose viewers run no page script. An SVG is a document: opened on its own it runs
// its scripts in the opener's origin, so like HTML it is only ever shown as source.
const OPENS_AS_IS = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/apng',
  'image/bmp',
  'image/x-icon',
  'application/pdf',
]);
const bareType = (mediaType: string) => mediaType.split(';')[0]!.trim().toLowerCase();

/** Raster images and PDFs open as themselves; everything else is shown as source. */
export const opensAsIs = (mediaType: string) => OPENS_AS_IS.has(bareType(mediaType));

/** Opens a captured file in a new tab. HTML and SVG are shown as source: rendering a captured
 *  document in the extension's origin would hand its scripts the extension's privileges. The
 *  type the blob is opened with is the vetted one, never the server's header as it came. */
export async function openArtifact(captureId: string, name: string, mediaType: string) {
  const blob = await readArtifact(captureId, name);
  const type = opensAsIs(mediaType) ? bareType(mediaType) : 'text/plain;charset=utf-8';
  const url = URL.createObjectURL(new Blob([blob], { type }));
  window.open(url, '_blank', 'noopener');
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function downloadCsv(filename: string, rows: (string | number | null | undefined)[][]) {
  // Titles, notes, tags and selectors come from captured pages. A cell starting with =, +, -, @,
  // a tab or a CR would be run as a formula by Excel and LibreOffice, so it gets the apostrophe
  // those programs use to mark text (RFC 4180 quoting for the rest).
  const cell = (v: string | number | null | undefined) => {
    let text = v == null ? '' : String(v);
    const formula = /^[=+\-@\t\r]/.test(text);
    if (formula) text = `'${text}`;
    return formula || /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const body = rows.map((r) => r.map(cell).join(',')).join('\r\n');
  saveBlob(new Blob([body], { type: 'text/csv;charset=utf-8' }), filename);
}
