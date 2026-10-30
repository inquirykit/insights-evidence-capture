import { useMemo } from 'react';

import type { CaptureSummary, EnrichmentItem } from '@/lib/protocol';

import type { CaseData } from './data';
import { fmtTime, hostOf, pageUrl, plural } from './ui';

interface Site {
  host: string;
  captures: CaptureSummary[];
  ips: Set<string>;
  /** What the server's enrichers said about the host and its addresses, newest capture first */
  enrichment: Map<string, EnrichmentItem>;
}

export default function SitesView(props: { data: CaseData; query: string; onPick: (host: string) => void }) {
  const { data } = props;

  const sites = useMemo(() => {
    const byHost = new Map<string, Site>();
    for (const c of data.captures ?? []) {
      const d = data.details.get(c.captureId);
      const host = hostOf(pageUrl(c, d)) ?? '(unknown)';
      const site: Site = byHost.get(host) ?? { host, captures: [], ips: new Set(), enrichment: new Map() };
      site.captures.push(c);
      const ip = d?.record.client.network?.mainFrame?.ip;
      if (ip) site.ips.add(ip);
      const enrichment = d?.record.enrichment;
      if (enrichment && 'items' in enrichment) {
        for (const item of enrichment.items) {
          const about = item.value.toLowerCase().replace(/^www\./, '');
          if ((about === host || site.ips.has(item.value)) && !site.enrichment.has(item.value)) {
            site.enrichment.set(item.value, item);
          }
        }
      }
      byHost.set(host, site);
    }
    return [...byHost.values()].sort(
      (a, b) => b.captures.length - a.captures.length || a.host.localeCompare(b.host),
    );
  }, [data.captures, data.details]);

  const q = props.query.trim().toLowerCase();
  const shown = q
    ? sites.filter((s) => s.host.includes(q) || [...s.ips].some((ip) => ip.includes(q)))
    : sites;

  return (
    <>
      <div className="view-bar">
        <span className="muted">{plural(shown.length, 'site')}</span>
      </div>
      <table className="table">
        <thead>
          <tr>
            <th>Site</th>
            <th className="num">Pages</th>
            <th>Server IPs</th>
            <th>Enrichment at capture time</th>
            <th>Last captured</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((s) => (
            <tr key={s.host}>
              <td>
                <button
                  className="link strong"
                  title="Show this site's pages"
                  onClick={() => props.onPick(s.host)}
                >
                  {s.host}
                </button>
              </td>
              <td className="num">{s.captures.length}</td>
              <td>
                {[...s.ips].map((ip) => (
                  <div key={ip}>
                    <code>{ip}</code>
                  </div>
                ))}
              </td>
              <td className="enrichment">
                {[...s.enrichment.values()].map((item) => (
                  <div key={item.value}>
                    <code>{item.value}</code> <span className="muted">{enrichmentLine(item)}</span>
                  </div>
                ))}
              </td>
              <td className="nowrap muted">{fmtTime(s.captures[0]?.receivedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

/** One enrichment item in a line: what was found, or why nothing was. */
export function enrichmentLine(item: EnrichmentItem): string {
  if (item.error) return `failed: ${item.error}`;
  const merged = item.results?.merged ?? {};
  const keys = Object.keys(merged);
  if (!keys.length) {
    const n = item.results?.results?.length ?? 0;
    return n ? `${plural(n, 'source')}, nothing found` : 'no enricher takes this type';
  }
  const shown = keys.slice(0, 6).map((k) => `${k}: ${fmtValue(merged[k])}`);
  return shown.join(' · ') + (keys.length > 6 ? ` · ${keys.length - 6} more` : '');
}

function fmtValue(value: unknown): string {
  if (value == null) return '–';
  const text = typeof value === 'string' ? value : (JSON.stringify(value) ?? '');
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}
