// Picking on the captured page: a region dragged, an element clicked, or the text selected.
// Injected with scripting.executeScript({ func }); like everything in lib/page/ they are
// serialized by source, so each one must be self-contained: no imports but types, no shared
// helpers, nothing from module scope (tests/page-functions.test.ts checks the rules). They read
// the page and draw a temporary overlay; they never change the document itself.

import type { PageRect } from '../protocol';

/** What a region drag or an element click selected. */
export interface PickResult {
  rect: PageRect;
  element?: ElementInfo;
}

export interface ElementInfo {
  tag: string;
  /** A CSS selector that found exactly this element at capture time */
  selector: string;
  xpath: string;
  /** Visible text, trimmed to 2000 characters */
  text: string;
  outerHTML: string;
}

/** The page's current text selection, read without changing it. */
export interface SelectionInfo {
  text: string;
  html: string;
  /** Bounding box of the selection; absent when it has no layout (collapsed, hidden) */
  rect?: PageRect;
  /** XPath of the deepest element that contains the whole selection */
  xpath: string;
}

/** Lets the user drag a rectangle (region) or click an element, then resolves with what
 *  they chose, or null if they pressed Escape. */
export function pickOnPage(mode: 'region' | 'element'): Promise<PickResult | null> {
  return new Promise((resolve) => {
    const host = document.createElement('div');
    host.setAttribute('data-evidence-capture-picker', '');
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `
      <style>
        :host { all: initial; position: fixed; inset: 0; z-index: 2147483647; cursor: crosshair; }
        .veil { position: absolute; inset: 0; background: rgba(0, 0, 0, 0.25); }
        .box { position: absolute; border: 2px solid #2f81f7; background: rgba(47, 129, 247, 0.15);
               box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.25); pointer-events: none; display: none; }
        .veil.boxed { background: none; }
        .hint { position: absolute; left: 50%; top: 12px; transform: translateX(-50%);
                background: #1f2328; color: #fff; font: 13px/1.4 system-ui, sans-serif;
                padding: 6px 12px; border-radius: 6px; pointer-events: none; white-space: nowrap; }
        .tag { position: absolute; background: #2f81f7; color: #fff; font: 11px ui-monospace, monospace;
               padding: 1px 5px; border-radius: 3px; pointer-events: none; display: none; }
      </style>
      <div class="veil"></div>
      <div class="box"></div>
      <div class="tag"></div>
      <div class="hint">${
        mode === 'region' ? 'Drag to select a region' : 'Click an element'
      } · Esc to cancel</div>`;
    const veil = root.querySelector('.veil') as HTMLElement;
    const box = root.querySelector('.box') as HTMLElement;
    const tag = root.querySelector('.tag') as HTMLElement;
    document.documentElement.appendChild(host);

    const showBox = (r: DOMRect | { left: number; top: number; width: number; height: number }) => {
      veil.classList.add('boxed');
      box.style.display = 'block';
      box.style.left = `${r.left}px`;
      box.style.top = `${r.top}px`;
      box.style.width = `${r.width}px`;
      box.style.height = `${r.height}px`;
    };

    const finish = (result: PickResult | null) => {
      removeEventListener('keydown', onKey, true);
      host.remove();
      // A viewport screenshot taken right away can still show the overlay (its box and tint
      // signed into the evidence): resolve once a frame without it has been drawn, two
      // animation frames on, or after 200 ms in a tab that draws none.
      requestAnimationFrame(() => requestAnimationFrame(() => resolve(result)));
      setTimeout(() => resolve(result), 200);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      finish(null);
    };
    addEventListener('keydown', onKey, true);

    const pageRect = (left: number, top: number, width: number, height: number): PageRect => ({
      x: Math.round(left + scrollX),
      y: Math.round(top + scrollY),
      width: Math.round(width),
      height: Math.round(height),
    });

    if (mode === 'region') {
      let start: { x: number; y: number } | null = null;
      host.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        start = { x: e.clientX, y: e.clientY };
      });
      host.addEventListener('mousemove', (e) => {
        if (!start) return;
        showBox({
          left: Math.min(start.x, e.clientX),
          top: Math.min(start.y, e.clientY),
          width: Math.abs(e.clientX - start.x),
          height: Math.abs(e.clientY - start.y),
        });
      });
      host.addEventListener('mouseup', (e) => {
        if (!start || e.button !== 0) return;
        const left = Math.min(start.x, e.clientX);
        const top = Math.min(start.y, e.clientY);
        const width = Math.abs(e.clientX - start.x);
        const height = Math.abs(e.clientY - start.y);
        start = null;
        if (width < 4 || height < 4) {
          veil.classList.remove('boxed');
          box.style.display = 'none';
          return; // a click, not a drag: keep picking
        }
        finish({ rect: pageRect(left, top, width, height) });
      });
      return;
    }

    // Element mode: the overlay takes the pointer, so the element under it is looked up.
    const under = (x: number, y: number): Element | null => {
      for (const el of document.elementsFromPoint(x, y)) {
        if (el !== host && el !== document.documentElement && el !== document.body) return el;
      }
      return null;
    };
    let current: Element | null = null;
    host.addEventListener('mousemove', (e) => {
      const el = under(e.clientX, e.clientY);
      if (el === current) return;
      current = el;
      if (!el) {
        box.style.display = 'none';
        tag.style.display = 'none';
        return;
      }
      const r = el.getBoundingClientRect();
      showBox(r);
      tag.style.display = 'block';
      tag.style.left = `${Math.max(0, r.left)}px`;
      tag.style.top = `${Math.max(0, r.top - 18)}px`;
      tag.textContent = describe(el);
    });
    host.addEventListener('click', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const el = under(e.clientX, e.clientY);
      if (!el) return;
      const r = el.getBoundingClientRect();
      finish({
        rect: pageRect(r.left, r.top, r.width, r.height),
        element: {
          tag: el.tagName.toLowerCase(),
          selector: cssPath(el),
          xpath: xPath(el),
          text: cutText(((el as HTMLElement).innerText ?? el.textContent ?? '').trim(), 2000),
          outerHTML: el.outerHTML,
        },
      });
    });

    /** The first `max` UTF-16 units, never ending in the first half of a surrogate pair. */
    function cutText(text: string, max: number): string {
      const cut = text.slice(0, max);
      return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
    }

    function describe(el: Element): string {
      const id = el.id ? `#${el.id}` : '';
      const cls = Array.from(el.classList)
        .slice(0, 2)
        .map((c) => `.${c}`)
        .join('');
      return `${el.tagName.toLowerCase()}${id}${cls}`;
    }

    /** A selector that matches this element alone, as short as the page allows. */
    function cssPath(el: Element): string {
      const esc = (s: string) => (CSS?.escape ? CSS.escape(s) : s.replace(/[^\w-]/g, '\\$&'));
      if (el.id && document.querySelectorAll(`#${esc(el.id)}`).length === 1) return `#${esc(el.id)}`;
      const parts: string[] = [];
      let node: Element | null = el;
      while (node && node !== document.documentElement) {
        let part = node.tagName.toLowerCase();
        if (node.id && document.querySelectorAll(`#${esc(node.id)}`).length === 1) {
          parts.unshift(`#${esc(node.id)}`);
          break;
        }
        const parent: Element | null = node.parentElement;
        if (parent) {
          const same = Array.from(parent.children).filter((c) => c.tagName === node!.tagName);
          if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`;
        }
        parts.unshift(part);
        node = parent;
      }
      return parts.join(' > ');
    }

    function xPath(el: Element): string {
      const parts: string[] = [];
      let node: Element | null = el;
      while (node && node.nodeType === Node.ELEMENT_NODE) {
        const parent: Element | null = node.parentElement;
        const name = node.tagName.toLowerCase();
        let index = 1;
        if (parent) {
          for (const sibling of Array.from(parent.children)) {
            if (sibling === node) break;
            if (sibling.tagName === node.tagName) index++;
          }
        }
        parts.unshift(`${name}[${index}]`);
        node = parent;
      }
      return `/${parts.join('/')}`;
    }
  });
}

/** The current text selection of the page or frame this runs in. */
export function readSelection(): SelectionInfo | null {
  const selection = getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const text = selection.toString();
  if (!text.trim()) return null;

  // One box around every range; multi-range selections exist in Firefox (Ctrl-click in tables).
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  const holder = document.createElement('div');
  for (let i = 0; i < selection.rangeCount; i++) {
    const range = selection.getRangeAt(i);
    holder.appendChild(range.cloneContents());
    const r = range.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    left = Math.min(left, r.left);
    top = Math.min(top, r.top);
    right = Math.max(right, r.right);
    bottom = Math.max(bottom, r.bottom);
  }
  let container: Node | null = selection.getRangeAt(0).commonAncestorContainer;
  while (container && container.nodeType !== Node.ELEMENT_NODE) container = container.parentNode;

  const parts: string[] = [];
  let node = container as Element | null;
  while (node && node.nodeType === Node.ELEMENT_NODE) {
    const parent: Element | null = node.parentElement;
    let index = 1;
    if (parent) {
      for (const sibling of Array.from(parent.children)) {
        if (sibling === node) break;
        if (sibling.tagName === node.tagName) index++;
      }
    }
    parts.unshift(`${node.tagName.toLowerCase()}[${index}]`);
    node = parent;
  }

  return {
    text,
    html: holder.innerHTML,
    rect:
      left < right && top < bottom
        ? {
            x: Math.round(left + scrollX),
            y: Math.round(top + scrollY),
            width: Math.round(right - left),
            height: Math.round(bottom - top),
          }
        : undefined,
    xpath: `/${parts.join('/')}`,
  };
}
