// Watching pages' DOM from their start (lib/page/dom-monitor.ts is the watcher): while "Watch DOM
// changes" is on, entrypoints/dom-monitor.ts is a registered content script, so every page loaded
// from then on is watched from document_start. capture.ts starts the watcher itself in a page
// that loaded before that.

/** The global the watcher keeps itself under, in the isolated world (never the page's). The
 *  watcher's functions are given it, as they can't share a constant with this module. */
export const MONITOR_KEY = '__evidenceCaptureDomMonitor';
const CONTENT_SCRIPT_ID = 'dom-monitor';

/** Registers the watcher for every page loaded from now on, or removes it. Run at startup and
 *  whenever the option changes; a browser that refuses leaves captures to start it themselves. */
export async function syncDomMonitor(on: boolean): Promise<void> {
  try {
    const registered = await browser.scripting.getRegisteredContentScripts({ ids: [CONTENT_SCRIPT_ID] });
    if (on && !registered.length) {
      await browser.scripting.registerContentScripts([
        {
          id: CONTENT_SCRIPT_ID,
          js: ['dom-monitor.js'],
          matches: ['http://*/*', 'https://*/*', 'file:///*'],
          runAt: 'document_start',
          allFrames: false,
        },
      ]);
    } else if (!on && registered.length) {
      await browser.scripting.unregisterContentScripts({ ids: [CONTENT_SCRIPT_ID] });
    }
  } catch (e) {
    console.warn('DOM monitor content script:', e);
  }
}
