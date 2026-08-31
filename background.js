/* The worker now only opens the side panel and stores the ConnectWise
   access key. Everything that talks to ConnectWise or the model runs in
   the side panel instead — a service worker cannot use the certificate
   exception you grant in a tab, so a self-signed model server is
   unreachable from here. */

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
    .catch(e => console.warn('sidePanel:', e));
});

chrome.runtime.onMessage.addListener((msg, _s, reply) => {
  // ticket pings from watch-ticket.js are for the side panel
  if (msg && 'onTicket' in msg) return;

  // grab.js hands over the clientId from a ConnectWise tab
  if (msg && msg.clientId) {
    chrome.storage.local.get('clientId').then(async ({ clientId }) => {
      if (clientId !== msg.clientId) await chrome.storage.local.set({ clientId: msg.clientId });
      reply('ok');
    });
    return true;
  }
});

/* "Open in chat" (sidepanel.js) opens a fresh Open WebUI chat for a ticket
   and drops a `pendingHandoff` marker before it does. Open WebUI settles the
   new chat's URL from `/` to `/c/<id>` once it's created; this watches for
   that so the id can be remembered against the ticket and reused next time
   instead of spawning a new chat on every click. The side panel itself can't
   do this watch — it calls window.close() right after opening the tab. */

const PENDING_HANDOFF_MAX_AGE_MS = 5 * 60 * 1000;

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (!changeInfo.url) return;

  const { pendingHandoff } = await chrome.storage.local.get('pendingHandoff');
  if (!pendingHandoff || pendingHandoff.tabId !== tabId) return;
  if (Date.now() - pendingHandoff.ts > PENDING_HANDOFF_MAX_AGE_MS) {
    await chrome.storage.local.remove('pendingHandoff');
    return;
  }

  const m = changeInfo.url.match(/\/c\/([A-Za-z0-9-]+)/);
  const onRoot = changeInfo.url.startsWith(pendingHandoff.root);
  if (!m || !onRoot) return;

  const { handoffChats = {} } = await chrome.storage.local.get('handoffChats');
  const key = `${pendingHandoff.cwOrigin || ''}|${pendingHandoff.ticket}`;
  await chrome.storage.local.set({
    handoffChats: { ...handoffChats, [key]: m[1] },
    pendingHandoff: null
  });
});

chrome.tabs.onRemoved.addListener(async tabId => {
  const { pendingHandoff } = await chrome.storage.local.get('pendingHandoff');
  if (pendingHandoff && pendingHandoff.tabId === tabId) {
    await chrome.storage.local.remove('pendingHandoff');
  }
  const { pendingSend } = await chrome.storage.local.get('pendingSend');
  if (pendingSend && pendingSend.tabId === tabId) {
    await chrome.storage.local.remove('pendingSend');
  }
});

/* Open WebUI's own ?q= auto-send races its chat-history load — it usually
   works, but sometimes the history re-render clobbers the auto-filled draft
   before it goes out (worse odds on an existing chat, which has history to
   load, than a brand new one). Once the tab finishes loading, this gives it
   a few seconds to send on its own, then — only if nothing with our prompt
   ever showed up in the transcript — types it into the composer and hits
   send itself, as a fallback.

   When the "Attach new files" checkbox pulled in ticket attachments,
   sidepanel.js skips ?q= entirely (typing into an existing draft is one
   thing; racing a file upload too is asking for trouble) and this drives
   the whole sequence itself instead: drop the files onto the composer,
   wait for them to show as attached, then type the prompt and send.

   Needs host permission for that page, which "Grant access" in settings
   already covers (same permission the model calls themselves need). */

const PENDING_SEND_MAX_AGE_MS = 5 * 60 * 1000;

// sidepanel.js writes `pendingSend` to storage *after* chrome.tabs.create()
// resolves — on a fast/local server the tab can already be at
// changeInfo.status === 'complete' before that write lands, so the onUpdated
// listener below fires too early, finds nothing yet, and (since 'complete'
// only fires once per navigation) never gets a second chance. Reacting to
// the storage write itself as a second trigger closes that gap: whichever
// of "tab finished loading" / "pendingSend arrived" happens second is the
// one that actually runs it. runPendingSend() re-reads and removes it
// itself, so whichever fires first wins and the other is a no-op.
async function runPendingSend(tabId) {
  const { pendingSend } = await chrome.storage.local.get('pendingSend');
  if (!pendingSend || pendingSend.tabId !== tabId) return;
  await chrome.storage.local.remove('pendingSend');   // one attempt only
  if (Date.now() - pendingSend.ts > PENDING_SEND_MAX_AGE_MS) {
    console.warn('cw-assist: pendingSend for tab', tabId, 'expired before it ran');
    return;
  }

  console.log('cw-assist: running send/attach for tab', tabId,
    'files:', (pendingSend.files || []).map(f => f.name));

  try {
    const [{ result } = {}] = await chrome.scripting.executeScript({
      target: { tabId },
      func: ensurePromptSent,
      args: [pendingSend.prompt, pendingSend.files || []]
    });
    console.log('cw-assist: send/attach result for tab', tabId, result);

    // Only commit the "already sent" watermark once attaching+sending
    // looks like it actually went out — a failed attempt should leave
    // those attachments still looking "new" next click, not lost.
    if (pendingSend.files?.length && result?.ok && pendingSend.key && pendingSend.newestISO) {
      const { handoffAttachments = {} } = await chrome.storage.local.get('handoffAttachments');
      await chrome.storage.local.set({
        handoffAttachments: { ...handoffAttachments, [pendingSend.key]: pendingSend.newestISO }
      });
    }
  } catch (e) {
    console.warn('cw-assist: could not arm send-fallback for tab', tabId, e);
  }
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'complete') runPendingSend(tabId);
});

chrome.storage.onChanged.addListener((changes, area) => {
  const tabId = changes.pendingSend?.newValue?.tabId;
  if (area !== 'local' || tabId == null) return;
  chrome.tabs.get(tabId).then(tab => {
    if (tab.status === 'complete') runPendingSend(tabId);
  }).catch(() => {});   // tab already gone
});

// Runs inside the Open WebUI page — kept as a plain, self-contained function
// since chrome.scripting.executeScript serializes it and runs it there, not
// here. DOM selectors are best-effort guesses at Open WebUI's chat composer
// and file-attach control, and may need updating if its UI changes.
// filesB64: [{ name, b64 }] — empty for a plain text-only send.
function ensurePromptSent(promptText, filesB64) {
  const log = (...a) => console.log('[cw-assist]', ...a);
  filesB64 = filesB64 || [];
  const marker = promptText.slice(0, 30);
  log('starting — files to attach:', filesB64.map(f => f.name), 'marker:', marker);

  const alreadySent = () => (document.body.innerText || '').includes(marker);

  const findComposer = () => {
    const el = document.querySelector('#chat-input') ||
      document.querySelector('textarea[placeholder*="Message" i]') ||
      document.querySelector('[contenteditable="true"]');
    log('findComposer ->', el);
    return el;
  };

  const findSendBtn = composer => {
    const el = document.querySelector('#send-message-button') ||
      document.querySelector('button[aria-label*="Send message" i]') ||
      (composer && composer.closest('form') &&
        composer.closest('form').querySelector('button[type="submit"]'));
    log('findSendBtn ->', el);
    return el;
  };

  function setNativeValue(el, value) {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, value); else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function fillAndSend() {
    log('fillAndSend: filling composer and sending');
    const composer = findComposer();
    if (!composer) { log('fillAndSend: no composer, giving up'); return false; }
    composer.focus();
    if (composer.tagName === 'TEXTAREA') {
      setNativeValue(composer, promptText);
    } else {
      composer.textContent = promptText;
      composer.dispatchEvent(new InputEvent('input', { bubbles: true }));
    }
    setTimeout(() => {
      const btn = findSendBtn(composer);
      if (btn && !btn.disabled) { log('fillAndSend: clicking send button'); btn.click(); return; }
      log('fillAndSend: no usable send button, dispatching Enter keydown instead');
      composer.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true
      }));
    }, 150);
    return true;
  }

  function b64ToFile(name, b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const ext = (name.match(/\.([a-z0-9]+)$/i) || ['', ''])[1].toLowerCase();
    const mime = {
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
      pdf: 'application/pdf', txt: 'text/plain', log: 'text/plain',
      json: 'application/json', csv: 'text/csv', zip: 'application/zip'
    }[ext] || 'application/octet-stream';
    return new File([bytes], name, { type: mime });
  }

  // Prefers a real file input (what a click on the paperclip button feeds);
  // falls back to simulating a drop onto the composer if none is found.
  function attachFiles() {
    let dt;
    try {
      dt = new DataTransfer();
      filesB64.forEach(f => dt.items.add(b64ToFile(f.name, f.b64)));
    } catch (e) {
      log('attachFiles: failed building DataTransfer/File', e);
      return false;
    }

    const input = document.querySelector('input[type="file"]');
    log('file input ->', input);
    if (input) {
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }

    const composer = findComposer();
    if (!composer) { log('attachFiles: no file input and no composer to drop onto'); return false; }
    log('attachFiles: no file input found, simulating a drop onto the composer instead');
    ['dragenter', 'dragover', 'drop'].forEach(type => {
      composer.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
    });
    return true;
  }

  const filesLookAttached = () => {
    const body = document.body.innerText || '';
    return filesB64.every(f => body.includes(f.name));
  };

  return new Promise(resolve => {
    if (!filesB64.length) {
      // Text-only: give Open WebUI's own ?q= auto-send a chance first.
      log('text-only path: waiting up to 6s for the marker to show up on its own');
      const deadline = Date.now() + 6000;
      (function tick() {
        if (alreadySent()) { log('marker already visible — Open WebUI sent it itself'); return resolve({ ok: true }); }
        if (Date.now() > deadline) { log('marker never showed up, forcing send'); return resolve({ ok: fillAndSend() }); }
        setTimeout(tick, 400);
      })();
      return;
    }

    // Attachments: no ?q= was set, so this owns the whole sequence —
    // attach, wait for them to register, then type the prompt and send.
    log('attach path: attaching files, then will type + send');
    if (!attachFiles()) return resolve({ ok: false, reason: 'composer not found' });
    const deadline = Date.now() + 8000;
    (function tick() {
      if (filesLookAttached()) { log('file name(s) now visible on page — proceeding to send'); return resolve({ ok: fillAndSend() }); }
      if (Date.now() > deadline) { log('gave up waiting for file names to appear, sending anyway'); return resolve({ ok: fillAndSend() }); }
      setTimeout(tick, 400);
    })();
  });
}
