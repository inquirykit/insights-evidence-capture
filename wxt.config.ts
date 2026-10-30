import { readlinkSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'wxt';

// `bun run dev` opens Chrome with a profile kept here, so the server URL, API key and capture
// settings survive restarts. Without it web-ext starts a fresh, empty profile every time.
// (`wxt clean` deletes it along with the rest of .wxt.)
const CHROME_PROFILE = '.wxt/chrome-data';

/** A kept profile also keeps the extension's service worker as Chrome last registered it, and
 *  Chrome runs that copy, not the background.js just built: loading the unpacked extension again
 *  at startup does not register it again, whatever its version (Chrome 156). So a background
 *  changed while `bun run dev` was stopped would never run; rebuilds while it runs are fine, as
 *  WXT reloads the extension. Forgetting the registrations before Chrome opens makes it register
 *  the build on disk; storage.local and IndexedDB are elsewhere in the profile and stay. Never
 *  while a Chrome runs on the profile: its SingletonLock links to "<host>-<pid>". */
function forgetServiceWorkers(profile: string) {
  try {
    process.kill(Number(readlinkSync(resolve(profile, 'SingletonLock')).split('-').pop()), 0);
    return; // that Chrome is still running
  } catch {
    // no lock, or one left by a Chrome that is gone
  }
  rmSync(resolve(profile, 'Default', 'Service Worker'), { recursive: true, force: true });
}

// Public half of a dev-only RSA key. It pins the unpacked Chrome extension ID to
// eiejpgpjkcmacpbaoekojmdmbliaiifd, so the ai_toolkit server's EVIDENCE_ALLOWED_ORIGINS
// (or CORS_ORIGINS) can name a stable chrome-extension:// origin across reinstalls. In
// `bun run dev` builds only: the Chrome Web Store refuses a manifest with a key and assigns
// its own ID, so production builds leave it out.
const CHROME_DEV_KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAlmPDmoDHHAyINGHgQkRdwnXrseK9b2cPqKlDdrepyASkmTB8i9F3HesCiPPwPkap3WGi0wXfZeJ4GRpckP4x6QvjxnhVXQYmnUEBW/8sYoBHwyoCkHiiUJBb6a38njRXAAr9wSfDqgQEZ+unuKK7ZMS4lLTChFltK6w3qM2sXvYcLBG/soYRNulEUp3y5abCcY5/3xy5dcEL/xSZ1v1Ahb+/oQMZuFWZ9utPjV5K0Oc7xuuV6kmKpZQ1gej3oXkym54Z0LtPYzok087JtYk6Pneucwa87qxKeJPbMA72nFJHsMlnLLz7IhNjLvXk04pmC/MLjolJv7srZ/iQ48oUowIDAQAB';

export default defineConfig({
  modules: ['@wxt-dev/module-react', '@wxt-dev/auto-icons'],
  // Toolbar/store icons are generated from one SVG at build time (16-128px). The module's
  // dev-build indicator is off: 'grayscale' makes the icon nearly invisible and 'overlay'
  // covers half of it with a DEV banner, and dev builds are the ones used every day here.
  autoIcons: {
    baseIconPath: 'assets/icon.svg',
    developmentIndicator: false,
  },
  webExt: {
    chromiumArgs: [`--user-data-dir=./${CHROME_PROFILE}`],
  },
  hooks: {
    // Before WXT builds and opens the browser.
    'server:started': (wxt) => {
      if (wxt.config.browser !== 'firefox') forgetServiceWorkers(resolve(wxt.config.root, CHROME_PROFILE));
    },
  },
  manifest: ({ browser, command }) => {
    const firefox = browser === 'firefox';
    return {
      name: 'Insights & Evidence Capture',
      description: 'Capture web pages as signed, timestamped evidence, kept in this browser or on your Core AI & Data toolkit server.',
      permissions: [
        // Beside <all_urls>: when the user limits the extension's site access in Chrome, the
        // shortcut and the right-click entries still grant it the tab they act on.
        'activeTab',
        'tabs',
        'scripting',
        'storage',
        'webRequest',
        // Right-click: capture page / selection / image.
        'contextMenus',
        // Chrome: full-page screenshots + MHTML via the DevTools protocol.
        // Firefox: blocking listener needed to read TLS details with getSecurityInfo().
        ...(firefox ? ['webRequestBlocking'] : ['debugger']),
      ],
      // All sites for capture + response headers; also covers the ai_toolkit server,
      // wherever it runs (localhost by default).
      host_permissions: ['<all_urls>'],
      commands: {
        'capture-page': {
          suggested_key: { default: 'Alt+Shift+S' },
          description: 'Capture the current page into the last used case',
        },
      },
      ...(firefox
        ? {
            browser_specific_settings: {
              gecko: {
                id: 'insights-evidence-capture@localhost',
                // String.prototype.toWellFormed, which every capture uses (lib/capture.ts). The
                // browser store also needs Ed25519 in WebCrypto: Firefox 130.
                strict_min_version: '119.0',
                // Mozilla counts any data that leaves the browser, a server the user set up
                // included: with the server store, captured pages and their URLs go to it. (The
                // browser store sends FreeTSA a record hash only.) The environment block (user
                // agent, platform) is technical data, which Mozilla wants optional and declinable
                // without losing features: not offered yet, so declare it before an AMO listing.
                data_collection_permissions: { required: ['websiteContent', 'browsingActivity'] },
              },
            },
          }
        : command === 'serve'
          ? { key: CHROME_DEV_KEY }
          : {}),
    };
  },
});
