// The DOM watcher (lib/page/dom-monitor.ts). Registered as a content script at document_start
// while "Watch DOM changes" is on (lib/dom-monitor.ts), and injected by capture.ts into a page that
// loaded before that. Running it twice in one page is harmless: the second start finds the first
// and returns.

import { MONITOR_KEY } from '@/lib/dom-monitor';
import { startDomMonitor } from '@/lib/page/dom-monitor';

export default defineUnlistedScript(() => {
  startDomMonitor(MONITOR_KEY);
});
