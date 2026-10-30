// Injected into the captured page by capture.ts: returns the page's visible text as Markdown.
//
// It reads the live DOM, where layout tells what is visible, and never changes it: visible
// elements are copied into an inert document first (no window, so no page script or custom
// element runs for the copies), and Turndown converts the copy. Open shadow roots are read as
// rendered; iframes are left out.

import TurndownService from 'turndown';

// Never copied: not text, or not text a reader sees.
const SKIP = new Set([
  'script',
  'style',
  'noscript',
  'template',
  'iframe',
  'frame',
  'object',
  'embed',
  'canvas',
  'video',
  'audio',
  'svg',
  'select',
]);

export default defineUnlistedScript(() => {
  const doc = document.implementation.createHTMLDocument('');
  if (document.body) copyVisible(document.body, doc.body, doc);
  const front = [`title: ${JSON.stringify(document.title)}`, `url: ${JSON.stringify(location.href)}`];
  return `---\n${front.join('\n')}\n---\n\n${converter().turndown(doc.body)}\n`;
});

/** Copies the visible children of `from`, as rendered, into `into` in the inert `doc`. */
function copyVisible(from: Node, into: Node, doc: Document) {
  for (const child of renderedChildren(from)) {
    if (child.nodeType === Node.TEXT_NODE) {
      into.appendChild(doc.createTextNode(child.nodeValue ?? ''));
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const el = child as Element;
    if (SKIP.has(el.localName) || !isVisible(el)) continue;
    if (el.localName === 'slot') {
      copyVisible(el, into, doc);
      continue;
    }
    const copy = doc.importNode(el, false);
    // URLs as the page resolved them
    if (el.localName === 'a') copy.setAttribute('href', (el as HTMLAnchorElement).href);
    if (el.localName === 'img') {
      const img = el as HTMLImageElement;
      copy.setAttribute('src', img.currentSrc || img.src);
    }
    into.appendChild(copy);
    copyVisible(el, copy, doc);
  }
}

/** A node's children as rendered: a shadow root's content, a slot's assigned nodes. */
function renderedChildren(node: Node): Iterable<Node> {
  if (node.nodeType === Node.ELEMENT_NODE) {
    const el = node as Element;
    if (el.shadowRoot) return el.shadowRoot.childNodes;
    if (el.localName === 'slot') {
      const assigned = (el as HTMLSlotElement).assignedNodes({ flatten: true });
      if (assigned.length) return assigned;
    }
  }
  return node.childNodes;
}

/** Laid out and not hidden. display: contents elements (slots among them) have no box of
 *  their own, which checkVisibility() counts as hidden, but their children may show. */
function isVisible(el: Element): boolean {
  return (
    el.checkVisibility({ visibilityProperty: true }) || getComputedStyle(el).display === 'contents'
  );
}

function converter(): TurndownService {
  const turndown = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
  });
  const escapeUrl = (url: string) => url.replace(/[()]/g, '\\$&');

  turndown.addRule('link', {
    filter: 'a',
    replacement: (content, node) => {
      const text = content.replace(/\s+/g, ' ').trim();
      const href = (node as HTMLElement).getAttribute('href') ?? '';
      if (!text) return '';
      // javascript: and the like lead nowhere a reader can follow
      return /^(https?|mailto|tel):/i.test(href) ? `[${text}](${escapeUrl(href)})` : content;
    },
  });
  turndown.addRule('image', {
    filter: 'img',
    replacement: (_content, node) => {
      const alt = ((node as HTMLElement).getAttribute('alt') ?? '').replace(/\s+/g, ' ').trim();
      const src = (node as HTMLElement).getAttribute('src') ?? '';
      if (!alt) return '';
      // data: and blob: sources would inline whole files
      if (!/^https?:/i.test(src)) return alt;
      return `![${alt.replace(/[[\]]/g, '\\$&')}](${escapeUrl(src)})`;
    },
  });

  // Tables of data become GFM tables: the first row is the header, each cell stays on one line
  // and a spanning cell is followed by empty ones, so columns line up.
  const inData = (node: Node) => isDataTable((node as Element).closest('table'));
  const isCell = (node: Node) => node.nodeName === 'TH' || node.nodeName === 'TD';
  turndown.addRule('dataCell', {
    filter: (node) => isCell(node) && inData(node),
    replacement: (content, node) => {
      const text = content.replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|');
      return ` ${text} |${'  |'.repeat((node as HTMLTableCellElement).colSpan - 1)}`;
    },
  });
  turndown.addRule('dataRow', {
    filter: (node) => node.nodeName === 'TR' && inData(node),
    replacement: (content, node) => {
      const row = node as HTMLTableRowElement;
      if (!row.cells.length) return '';
      const rows = Array.from(row.closest('table')!.rows);
      if (row !== rows.find((r) => r.cells.length)) return `\n|${content}`;
      const columns = Math.max(...rows.map(spannedColumns));
      const padding = '  |'.repeat(columns - spannedColumns(row));
      return `\n|${content}${padding}\n|${' --- |'.repeat(columns)}`;
    },
  });
  turndown.addRule('dataSection', {
    filter: (node) => /^T(HEAD|BODY|FOOT)$/.test(node.nodeName) && inData(node),
    replacement: (content) => content,
  });
  turndown.addRule('dataCaption', {
    filter: (node) => node.nodeName === 'CAPTION' && inData(node),
    replacement: (content) => `${content.trim()}\n\n`,
  });
  turndown.addRule('dataTable', {
    filter: (node) => node.nodeName === 'TABLE' && isDataTable(node),
    replacement: (content) => `\n\n${content.trim()}\n\n`,
  });
  // Tables that lay out the page are read row by row, a row's cells side by side.
  turndown.addRule('layoutCell', {
    filter: (node) => isCell(node) && !inData(node),
    replacement: (content) => (content.trim() ? ` ${content.trim()} ` : ''),
  });
  turndown.addRule('layoutRow', {
    filter: (node) => node.nodeName === 'TR' && !inData(node),
    replacement: (content) => `\n\n${content.trim()}\n\n`,
  });

  return turndown;
}

const dataTables = new WeakMap<Element, boolean>();

/** Header cells and no tables inside or around it: data, not page layout. */
function isDataTable(table: Element | null): boolean {
  if (!table) return false;
  let data = dataTables.get(table);
  if (data === undefined) {
    data =
      table.getAttribute('role') !== 'presentation' &&
      !table.querySelector('table') &&
      !table.parentElement?.closest('table') &&
      !!table.querySelector('th, thead, caption');
    dataTables.set(table, data);
  }
  return data;
}

const spannedColumns = (row: HTMLTableRowElement) =>
  Array.from(row.cells).reduce((n, cell) => n + cell.colSpan, 0);
