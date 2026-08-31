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

   An earlier version of this also tried to drive file attachments the same
   way (drop them onto the composer via DOM injection). Real-world testing
   against a live Open WebUI build showed that path never worked at all —
   no message, no attachment, nothing ever reached the server, most likely
   because its composer is a rich-text editor whose internal state a plain
   .textContent write doesn't register with. So attachments are handled
   entirely differently now (see cwlib.js's ticketAttachments +
   sidepanel.js's chrome.downloads.download) and this stays scoped to just
   the one thing that's actually proven to work: nudging the text send.

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
  if (Date.now() - pendingSend.ts > PENDING_SEND_MAX_AGE_MS) return;

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: ensurePromptSent,
      args: [pendingSend.prompt]
    });
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
// and may need updating if its UI changes.
function ensurePromptSent(promptText) {
  const marker = promptText.slice(0, 30);
  const deadline = Date.now() + 6000;

  const alreadySent = () => (document.body.innerText || '').includes(marker);

  const findComposer = () =>
    document.querySelector('#chat-input') ||
    document.querySelector('textarea[placeholder*="Message" i]') ||
    document.querySelector('[contenteditable="true"]');

  const findSendBtn = composer =>
    document.querySelector('#send-message-button') ||
    document.querySelector('button[aria-label*="Send message" i]') ||
    (composer && composer.closest('form') &&
      composer.closest('form').querySelector('button[type="submit"]'));

  function setNativeValue(el, value) {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, value); else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function forceSend() {
    const composer = findComposer();
    if (!composer) return;
    composer.focus();
    if (composer.tagName === 'TEXTAREA') {
      setNativeValue(composer, promptText);
    } else {
      composer.textContent = promptText;
      composer.dispatchEvent(new InputEvent('input', { bubbles: true }));
    }
    setTimeout(() => {
      const btn = findSendBtn(composer);
      if (btn && !btn.disabled) { btn.click(); return; }
      composer.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true
      }));
    }, 150);
  }

  (function tick() {
    if (alreadySent()) return;          // Open WebUI's own auto-send worked
    if (Date.now() > deadline) { forceSend(); return; }
    setTimeout(tick, 400);
  })();
}
