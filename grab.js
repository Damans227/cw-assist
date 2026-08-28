/* Runs on ConnectWise pages. The REST API wants a clientId GUID that the
   extension cannot see, because page localStorage belongs to the page.
   Pick it up here and hand it to the service worker.

   Sources, in order:
     1. the value cw_export already cached
     2. any GUID sitting under a clientId-ish key
     3. watching a real request go out                                     */

(() => {
  const KEY  = 'cw-export.clientId';
  const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  const send = id => {
    if (!id) return;
    chrome.runtime.sendMessage({ clientId: id }).catch(() => {});
  };

  // 1 + 2: whatever is already in storage
  const fromStorage = () => {
    try {
      const cached = localStorage.getItem(KEY);
      if (cached && GUID.test(cached)) return cached;
    } catch {}

    for (const store of [localStorage, sessionStorage]) {
      let n = 0; try { n = store.length; } catch { continue; }
      for (let i = 0; i < n; i++) {
        const k = store.key(i);
        let v = ''; try { v = (store.getItem(k) || '').trim(); } catch { continue; }
        if (GUID.test(v) && /client/i.test(k)) return v;
      }
    }
    return null;
  };

  const found = fromStorage();
  if (found) { send(found); return; }

  // 3: nothing stored, so watch ConnectWise make one of its own calls
  const script = document.createElement('script');
  script.textContent = `(() => {
    const orig = XMLHttpRequest.prototype.setRequestHeader;
    XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
      if (/^clientid$/i.test(k) && v) {
        window.postMessage({ __cwWatchClientId: v }, '*');
        XMLHttpRequest.prototype.setRequestHeader = orig;
        try { localStorage.setItem('${KEY}', v); } catch {}
      }
      return orig.apply(this, arguments);
    };
  })();`;
  (document.head || document.documentElement).appendChild(script);
  script.remove();

  window.addEventListener('message', e => {
    if (e.source === window && e.data && e.data.__cwWatchClientId) {
      send(e.data.__cwWatchClientId);
    }
  });
})();
