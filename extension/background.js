// Codi Capture — MV3 service worker.
// On toolbar click: grab {url, html} from the active tab (activeTab grants this
// without broad host permissions), then deliver it into the Codi Tester tab by
// calling window.__codiReceiveCapture there. Also copies to the clipboard as a
// universal fallback. The tester URL is set in the options page.

const DEFAULT_TESTER = 'http://localhost:4000';

function flash(text, color, title) {
  chrome.action.setBadgeBackgroundColor({ color });
  chrome.action.setBadgeText({ text });
  if (title) chrome.action.setTitle({ title });
  setTimeout(() => chrome.action.setBadgeText({ text: '' }), 4000);
}

async function testerTarget() {
  const { testerUrl } = await chrome.storage.sync.get('testerUrl');
  const base = (testerUrl || DEFAULT_TESTER).replace(/\/+$/, '');
  return { base, origin: new URL(base).origin };
}

function waitForComplete(tabId) {
  return new Promise((resolve) => {
    (function check() {
      chrome.tabs.get(tabId, (t) => {
        if (chrome.runtime.lastError || !t) return resolve();
        if (t.status === 'complete') return resolve();
        setTimeout(check, 200);
      });
    })();
  });
}

chrome.action.onClicked.addListener(async (tab) => {
  try {
    if (!tab.id || /^(chrome|edge|about|chrome-extension|view-source):/.test(tab.url || '')) {
      return flash('!', '#d1242f', "Can't capture this kind of page");
    }

    // 1) Capture the live page from the active tab, at full fidelity: load the
    //    shared serializer (inline CSS, form state, shadow DOM) then call it.
    //    Runs in MAIN world so it can read the page's stylesheets.
    await chrome.scripting.executeScript({
      target: { tabId: tab.id }, world: 'MAIN', files: ['capture-core.js'],
    });
    const [{ result: payload }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id }, world: 'MAIN',
      func: () => ({
        url: location.href,
        html: window.__codiCaptureHTML
          ? window.__codiCaptureHTML({ inlineCSS: true, shadow: true, formState: true })
          : document.documentElement.outerHTML,
      }),
    });

    // 2) Best-effort clipboard fallback (runs in the page, which has focus).
    chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (p) => { try { navigator.clipboard.writeText(JSON.stringify(p)); } catch (e) {} },
      args: [payload],
    }).catch(() => {});

    // 3) Deliver into the tester tab.
    const { base, origin } = await testerTarget();
    const granted = await chrome.permissions.contains({ origins: [origin + '/*'] });
    if (!granted) {
      flash('?', '#9a6700', 'Set your tester URL in the extension options (page copied to clipboard)');
      chrome.runtime.openOptionsPage();
      return;
    }

    const all = await chrome.tabs.query({});
    let target = all.find((t) => t.url && t.url.startsWith(origin));
    if (target) {
      await chrome.tabs.update(target.id, { active: true });
      try { await chrome.windows.update(target.windowId, { focused: true }); } catch (e) {}
    } else {
      target = await chrome.tabs.create({ url: base });
      await waitForComplete(target.id);
    }

    await chrome.scripting.executeScript({
      target: { tabId: target.id },
      world: 'MAIN',
      func: (p) => { if (window.__codiReceiveCapture) window.__codiReceiveCapture(p); else window.__codiPendingCapture = p; },
      args: [payload],
    });

    flash('✓', '#1a7f37', `Sent ${Math.round(JSON.stringify(payload).length / 1024)} KB to Codi Tester`);
  } catch (e) {
    flash('!', '#d1242f', 'Capture failed: ' + (e && e.message || e));
  }
});
