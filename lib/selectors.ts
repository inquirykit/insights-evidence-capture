// Selectors: identifiers worth pivoting on (emails, phone numbers, social profiles, crypto
// addresses, …) pulled out of a captured page's dom.html
// automatic selectors, plus the user's own watch terms.
//
// Extension pages only: it needs DOMParser. A DOMParser document is inert: its scripts
// don't run and nothing it references is fetched, so parsing a hostile page is safe.

export type SelectorKind =
  'watch' | 'email' | 'phone' | 'social' | 'bitcoin' | 'ethereum' | 'onion' | 'ipv4' | 'link';

export const SELECTOR_KINDS: { kind: SelectorKind; label: string }[] = [
  { kind: 'watch', label: 'Watch terms' },
  { kind: 'email', label: 'Emails' },
  { kind: 'phone', label: 'Phones' },
  { kind: 'social', label: 'Social profiles' },
  { kind: 'bitcoin', label: 'Bitcoin' },
  { kind: 'ethereum', label: 'Ethereum' },
  { kind: 'onion', label: 'Onion' },
  { kind: 'ipv4', label: 'IP addresses' },
  { kind: 'link', label: 'Linked sites' },
];

export interface SelectorHit {
  kind: SelectorKind;
  /** Normalized, so the same identifier found on two pages compares equal */
  value: string;
}

export interface PageScan {
  /** The page's text, whitespace collapsed: for full-text search and watch terms */
  text: string;
  hits: SelectorHit[];
}

// textContent runs adjacent blocks together ("a@b.comContact"); these get a trailing newline.
const BLOCKS =
  'address,article,aside,blockquote,br,dd,div,dt,figcaption,footer,form,h1,h2,h3,h4,h5,h6,header,' +
  'hr,li,main,nav,ol,option,p,pre,section,table,td,th,tr,ul';

const EMAIL = /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,24}(?![a-z0-9-])/gi;
const EMAIL_EXACT = new RegExp(`^${EMAIL.source}$`, 'i');
// "logo@2x.png" looks like an email address.
const ASSET_SUFFIX = /\.(?:png|jpe?g|gif|svg|webp|avif|css|js)$/i;
const PHONE_INTL = /(?<![\w+])\+\d[\d ().-]{6,20}\d(?!\w)/g;
const PHONE_NANP = /(?<!\w)\(\d{3}\) ?\d{3}[-. ]\d{4}(?!\w)/g;
const IPV4 =
  /(?<![\d.])(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?![\d.])/g;
const ETHEREUM = /\b0x[0-9a-f]{40}\b/gi;
const BITCOIN_BECH32 = /\bbc1[02-9ac-hj-np-z]{11,71}\b/gi;
const BITCOIN_LEGACY = /\b[13][1-9A-HJ-NP-Za-km-z]{25,34}\b/g;
const ONION = /\b[a-z2-7]{56}\.onion\b/gi;

export async function scanHtml(html: string, pageUrl: string | null): Promise<PageScan> {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script, style, noscript, template, svg').forEach((el) => el.remove());
  doc.querySelectorAll(BLOCKS).forEach((el) => el.append('\n'));
  const text = (doc.body?.textContent ?? '').replace(/\s+/g, ' ').trim();

  const found = new Map<string, SelectorHit>();
  const add = (kind: SelectorKind, value: string) => {
    const key = `${kind}\n${value}`;
    if (!found.has(key)) found.set(key, { kind, value });
  };

  for (const [m] of text.matchAll(EMAIL)) if (!ASSET_SUFFIX.test(m)) add('email', m.toLowerCase());
  for (const [m] of text.matchAll(PHONE_INTL)) {
    const phone = normalizePhone(m);
    if (phone) add('phone', phone);
  }
  for (const [m] of text.matchAll(PHONE_NANP)) add('phone', normalizePhone(m)!);
  for (const [m] of text.matchAll(IPV4)) add('ipv4', m);
  for (const [m] of text.matchAll(ETHEREUM)) add('ethereum', m.toLowerCase());
  for (const [m] of text.matchAll(BITCOIN_BECH32)) add('bitcoin', m.toLowerCase());
  for (const m of new Set(text.match(BITCOIN_LEGACY))) if (await isBase58Check(m)) add('bitcoin', m);
  for (const [m] of text.matchAll(ONION)) add('onion', m.toLowerCase());

  // Links: resolved against the page (or its <base>), since the parsed document's own URL
  // is the dashboard's.
  const page = parseUrl(pageUrl);
  const base = parseUrl(doc.querySelector('base[href]')?.getAttribute('href') ?? null, page) ?? page;
  const ownHost = page && bareHost(page.hostname);
  for (const el of doc.querySelectorAll('a[href], area[href]')) {
    const url = parseUrl(el.getAttribute('href'), base);
    if (!url) continue;
    if (url.protocol === 'mailto:') {
      for (const address of safeDecode(url.pathname).split(',')) {
        const email = address.trim().toLowerCase();
        if (EMAIL_EXACT.test(email)) add('email', email);
      }
    } else if (url.protocol === 'tel:') {
      const phone = normalizePhone(safeDecode(url.pathname));
      if (phone) add('phone', phone);
    } else if (url.protocol === 'http:' || url.protocol === 'https:') {
      const host = bareHost(url.hostname);
      const profile = socialProfile(url);
      if (profile) add('social', profile);
      if (host.endsWith('.onion')) add('onion', host);
      else if (!sameSite(host, ownHost) && host.includes('.')) add('link', host);
    }
  }
  for (const meta of doc.querySelectorAll('meta[name="twitter:site"], meta[name="twitter:creator"]')) {
    const handle = /^@?([A-Za-z0-9_]{1,15})$/.exec(meta.getAttribute('content')?.trim() ?? '');
    if (handle) add('social', `x.com/${handle[1]!.toLowerCase()}`);
  }

  return { text, hits: [...found.values()] };
}

/** The watch terms that occur in a page: case-insensitive, as whole words ("jack" doesn't
 *  match "jacket"). */
export function watchHits(scan: PageScan, terms: string[]): SelectorHit[] {
  return terms
    .filter((t) =>
      new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(t)}(?![\\p{L}\\p{N}])`, 'iu').test(scan.text),
    )
    .map((value) => ({ kind: 'watch', value }));
}

export const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---------------------------------------------------------------------------

/** "+44 20 7946 0958" → "+442079460958"; "(555) 123-4567" → "(555) 123-4567". */
function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, '');
  if (raw.trim().startsWith('+')) return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  if (digits.length === 10) return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  return digits.length >= 7 && digits.length <= 15 ? digits : null;
}

const bareHost = (host: string) => host.toLowerCase().replace(/^(?:www|m|mobile)\./, '');

/** "cats.com" and "fr.cats.com" are one site: a page's links to its own subdomains aren't leads. */
const sameSite = (a: string, b: string | null) =>
  !!b && (a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`));

function parseUrl(href: string | null, base?: URL | null): URL | null {
  if (!href) return null;
  try {
    return new URL(href, base ?? undefined);
  } catch {
    return null;
  }
}

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

// Site paths that look like a profile name but aren't one.
const NOT_PROFILES = new Set(
  (
    'about accounts business careers collections compose contact dialog direct enterprise events explore ' +
    'features feed groups hashtag help home i intent issues jobs join legal login logout marketplace ' +
    'messages new notifications orgs p pages plugins policies policy pricing privacy pulls reel reels ' +
    'search security settings share sharer sharer.php signup site sponsors status stories team terms ' +
    'topics tos trending watch web'
  ).split(' '),
);

/** A profile link as "<site>/<handle>", or null when the URL isn't one. */
export function socialProfile(url: URL): string | null {
  const [a = '', b = ''] = url.pathname.split('/').filter(Boolean);
  const single = url.pathname.split('/').filter(Boolean).length === 1 && !NOT_PROFILES.has(a.toLowerCase());
  const handle = (re: RegExp) => single && re.test(a);
  switch (bareHost(url.hostname)) {
    case 'twitter.com':
    case 'x.com':
      return handle(/^\w{1,15}$/) ? `x.com/${a.toLowerCase()}` : null;
    case 'facebook.com':
    case 'fb.com': {
      const id = a === 'profile.php' ? url.searchParams.get('id') : null;
      if (id && /^\d+$/.test(id)) return `facebook.com/profile.php?id=${id}`;
      return handle(/^[A-Za-z0-9.]{5,50}$/) ? `facebook.com/${a.toLowerCase()}` : null;
    }
    case 'instagram.com':
      return handle(/^[\w.]{1,30}$/) ? `instagram.com/${a.toLowerCase()}` : null;
    case 'github.com':
      return handle(/^[A-Za-z0-9-]{1,39}$/) ? `github.com/${a.toLowerCase()}` : null;
    case 't.me':
    case 'telegram.me':
      return handle(/^\w{5,32}$/) ? `t.me/${a.toLowerCase()}` : null;
    case 'tiktok.com':
    case 'threads.net':
    case 'threads.com':
      return /^@[\w.]{2,30}$/.test(a) ? `${bareHost(url.hostname)}/${a.toLowerCase()}` : null;
    case 'youtube.com':
      if (/^@[\w.-]{3,30}$/.test(a)) return `youtube.com/${a.toLowerCase()}`;
      return ['channel', 'c', 'user'].includes(a) && b ? `youtube.com/${a}/${b}` : null;
    case 'linkedin.com':
      return (a === 'in' || a === 'company') && b ? `linkedin.com/${a}/${b.toLowerCase()}` : null;
    case 'reddit.com':
      return (a === 'u' || a === 'user') && b ? `reddit.com/user/${b.toLowerCase()}` : null;
    case 'bsky.app':
      return a === 'profile' && b ? `bsky.app/profile/${b.toLowerCase()}` : null;
    default:
      return null;
  }
}

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Legacy (P2PKH / P2SH) Bitcoin addresses carry a checksum; random words that match the
 *  pattern almost never pass it. */
async function isBase58Check(address: string): Promise<boolean> {
  let n = 0n;
  for (const c of address) {
    const digit = BASE58.indexOf(c);
    if (digit < 0) return false;
    n = n * 58n + BigInt(digit);
  }
  const bytes: number[] = [];
  for (; n > 0n; n >>= 8n) bytes.unshift(Number(n & 0xffn));
  for (const c of address) {
    if (c !== '1') break;
    bytes.unshift(0);
  }
  if (bytes.length !== 25) return false;
  const payload = new Uint8Array(bytes.slice(0, 21));
  const once = await crypto.subtle.digest('SHA-256', payload);
  const twice = new Uint8Array(await crypto.subtle.digest('SHA-256', once));
  return [0, 1, 2, 3].every((i) => twice[i] === bytes[21 + i]);
}
