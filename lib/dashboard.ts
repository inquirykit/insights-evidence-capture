// The dashboard (entrypoints/dashboard): a full-tab extension page for working through what
// has been captured. Its location hash says what it shows:
//
//   #/<case>                  the case's pages
//   #/<case>?tag=<tag>        those with the tag
//   #/<case>/selectors        identifiers found in them
//   #/<case>/sites            the sites they came from
//   #/<case>/todos            the case's to-do list
//   #/<case>/capture/<id>     one capture
//   #/~cases                  every case, side by side
//   #/~tags                   every tag: their colours and icons, renaming, deleting
//
// "~" starts no case id (the server's are generated, plus "inbox").

export type DashboardView = 'pages' | 'selectors' | 'sites' | 'todos';

/** Views across the cases rather than in one */
export type OverviewView = 'cases' | 'tags';

export type DashboardRoute =
  | { caseId: string; view: DashboardView; tag?: string }
  | { caseId: string; view: 'capture'; captureId: string }
  | { view: OverviewView };

const VIEWS: DashboardView[] = ['pages', 'selectors', 'sites', 'todos'];
const OVERVIEWS: OverviewView[] = ['cases', 'tags'];

export function routeHash(route: DashboardRoute): string {
  if (!('caseId' in route)) return `#/~${route.view}`;
  const c = `#/${encodeURIComponent(route.caseId)}`;
  if (route.view === 'capture') return `${c}/capture/${encodeURIComponent(route.captureId)}`;
  if (route.view === 'pages') return route.tag ? `${c}?tag=${encodeURIComponent(route.tag)}` : c;
  return `${c}/${route.view}`;
}

export function parseRoute(hash: string, fallbackCaseId: string): DashboardRoute {
  const [path = '', query = ''] = hash.replace(/^#\/?/, '').split('?');
  const overview = OVERVIEWS.find((v) => path === `~${v}`);
  if (overview) return { view: overview };
  const [caseId, view, captureId] = path.split('/').map((part) => {
    try {
      return decodeURIComponent(part);
    } catch {
      return part;
    }
  });
  if (!caseId) return { caseId: fallbackCaseId, view: 'pages' };
  if (view === 'capture' && captureId) return { caseId, view, captureId };
  const tag = new URLSearchParams(query).get('tag') || undefined;
  return { caseId, view: VIEWS.find((v) => v === view) ?? 'pages', ...(tag ? { tag } : {}) };
}

/** Shows the route in the open dashboard tab, or in a new one. */
export async function openDashboard(route?: DashboardRoute): Promise<void> {
  const page = browser.runtime.getURL('/dashboard.html');
  const url = route ? `${page}${routeHash(route)}` : page;
  const existing = (await browser.tabs.query({})).find((t) => t.url?.startsWith(page));
  if (existing?.id == null) {
    await browser.tabs.create({ url });
    return;
  }
  await browser.tabs.update(existing.id, { active: true, ...(route ? { url } : {}) });
  if (existing.windowId != null) await browser.windows.update(existing.windowId, { focused: true });
}
