// Auto-scroll, injected into the page with scripting.executeScript({ func }) before a capture
// when the user asked for it: scrolls through the page so content that loads on scroll (lazy
// images, feeds, "infinite" lists) is in the document, then back to where the user was. Like
// everything in lib/page/ it must be self-contained (tests/page-functions.test.ts checks the
// rules). It moves the page, and the record says so (`scroll`), but never changes the document
// itself; what the page's own scripts load is theirs.

export interface ScrollResult {
  /** What was scrolled: "document", or the element a web app scrolls its content in */
  scroller: string;
  steps: number;
  durationMs: number;
  /** The bottom was reached and nothing more loaded there; false when the time limit stopped it */
  reachedEnd: boolean;
  /** Scroll height in CSS px before and after */
  heightBefore: number;
  heightAfter: number;
  /** Where the user was, scrolled back to */
  restoredTo: { x: number; y: number };
}

/** Scrolls down in steps of most of a viewport until the bottom stays put, or `limitMs` runs
 *  out; then back to where the user was, and waits briefly for images that started loading. */
export async function scrollThroughPage(limitMs: number): Promise<ScrollResult> {
  // Between steps, so the page sees each position and starts its loads.
  const STEP_DELAY_MS = 250;
  // At the bottom, how long to wait for more content before calling it the end.
  const SETTLE_MS = 1500;
  // After scrolling back, the longest wait for images still loading.
  const IMAGES_MS = 3000;

  const started = performance.now();
  const deadline = started + limitMs;
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  // The page itself scrolls, or (in many web apps) one large element inside a fixed page.
  const root = document.scrollingElement ?? document.documentElement;
  let scroller: Element = root;
  if (root.scrollHeight <= root.clientHeight + 1) {
    let area = 0;
    for (const el of document.querySelectorAll('body *')) {
      if (el.scrollHeight <= el.clientHeight + 1 || el.clientHeight < innerHeight / 2) continue;
      const overflow = getComputedStyle(el).overflowY;
      if (overflow !== 'auto' && overflow !== 'scroll' && overflow !== 'overlay') continue;
      if (el.clientWidth * el.clientHeight > area) {
        area = el.clientWidth * el.clientHeight;
        scroller = el;
      }
    }
  }
  const describe = (el: Element) =>
    el === root
      ? 'document'
      : el.id
        ? `${el.localName}#${el.id}`
        : [el.localName, ...[...el.classList].slice(0, 2)].join('.');

  const start = { x: scroller.scrollLeft, y: scroller.scrollTop };
  const heightBefore = scroller.scrollHeight;
  const step = Math.max(200, Math.round(scroller.clientHeight * 0.85));
  let steps = 0;
  let reachedEnd = false;

  while (performance.now() < deadline) {
    if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2) {
      // At the bottom: done, unless the page grows (a feed loading its next part).
      const height = scroller.scrollHeight;
      const until = Math.min(deadline, performance.now() + SETTLE_MS);
      let grew = false;
      while (!grew && performance.now() < until) {
        await sleep(150);
        grew = scroller.scrollHeight > height + 2;
      }
      if (!grew) {
        reachedEnd = performance.now() < deadline;
        break;
      }
      continue;
    }
    scroller.scrollTo({ top: scroller.scrollTop + step, behavior: 'instant' });
    steps++;
    await sleep(STEP_DELAY_MS);
  }

  scroller.scrollTo({ left: start.x, top: start.y, behavior: 'instant' });
  await sleep(300);
  const loading = [...document.images].filter((img) => img.currentSrc && !img.complete);
  if (loading.length) {
    await Promise.race([
      Promise.all(
        loading.map(
          (img) =>
            new Promise<void>((resolve) => {
              img.addEventListener('load', () => resolve(), { once: true });
              img.addEventListener('error', () => resolve(), { once: true });
            }),
        ),
      ),
      sleep(IMAGES_MS),
    ]);
  }

  return {
    scroller: describe(scroller),
    steps,
    durationMs: Math.round(performance.now() - started),
    reachedEnd,
    heightBefore,
    heightAfter: scroller.scrollHeight,
    restoredTo: { x: scroller.scrollLeft, y: scroller.scrollTop },
  };
}
