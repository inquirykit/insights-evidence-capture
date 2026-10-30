// Auto-capture's quick look at a page, injected with scripting.executeScript({ func }): whether
// its text changed since it was last captured. Like everything in lib/page/ it is serialized by
// source, so it must be self-contained (tests/page-functions.test.ts checks the rules).

export interface PageFingerprint {
  url: string;
  /** cyrb53 of the title and text: tells whether the page changed, proves nothing */
  hash: string;
}

/** The page's URL and a quick hash of its title and text. cyrb53, a fast 53-bit string hash. */
export function pageFingerprint(): PageFingerprint {
  const text = `${document.title}\n${document.body?.innerText ?? ''}`;
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return { url: location.href, hash: (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36) };
}
