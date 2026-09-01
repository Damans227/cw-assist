/* The worker only opens the side panel, stores the ConnectWise access key,
   and keeps the toolbar badge counting tickets waiting on us. Everything
   else that talks to the model runs in the side panel instead — a service
   worker cannot use the certificate exception you grant in a tab, so a
   self-signed model server is unreachable from here. ConnectWise itself is
   plain HTTPS, so the badge's own reads below are fine from a worker. */

importScripts('cwlib.js');

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

/* ---- toolbar badge: how many open tickets are waiting on us --------
   Deliberately not the model's nuanced "Whose move" board column — this
   is a free, instant heuristic (who sent the last note, nothing read) so
   it can run on a timer without burning tokens: last note from a contact,
   or no notes at all, counts as waiting on us; last note from one of our
   own members does not. It will call a few things wrong the same way the
   old ticket *status* did (that's the whole problem this extension exists
   to work around) — the side panel's AI-graded board table is still the
   place to actually check a ticket, this is just the "should I look?" nudge
   sitting on the icon before you open it.                              -- */

const BADGE_ALARM = 'cw-assist-badge-refresh';
const BADGE_PERIOD_MIN = 5;
const BASE_TITLE = 'ConnectWise support assist';
const TOOLTIP_LIST_CAP = 15;   // past this many, list the first N and say how many more

async function refreshBadge() {
  try {
    const { clientId } = await chrome.storage.local.get('clientId');
    if (!clientId) {
      await chrome.action.setBadgeText({ text: '' });
      await chrome.action.setTitle({ title: BASE_TITLE });
      return;
    }

    const rows = await boardRows();
    const open = rows.filter(t => !/resolved|closed/i.test(t.status?.name || ''));

    const waiting = [];
    for (const t of open) {
      let side;
      try { side = await lastNoteSide(t.id); }
      catch { continue; }   // one ticket failing (e.g. no access) shouldn't blank the count
      if (side !== 'vendor') waiting.push(t.id);   // 'customer' or no notes yet — both need us
    }
    waiting.sort((a, b) => b - a);
    const usTurn = waiting.length;

    await chrome.action.setBadgeText({ text: usTurn ? String(usTurn) : '' });
    await chrome.action.setBadgeBackgroundColor({ color: '#b3261e' });

    // the extension icon's own hover tooltip is the only place this list is
    // shown — no in-panel display for it, so it can afford to be blunt
    if (usTurn) {
      const shown = waiting.slice(0, TOOLTIP_LIST_CAP).join(', ');
      const more = usTurn > TOOLTIP_LIST_CAP ? ` +${usTurn - TOOLTIP_LIST_CAP} more` : '';
      await chrome.action.setTitle({
        title: `${BASE_TITLE} — ${usTurn} ticket${usTurn === 1 ? '' : 's'} waiting on us\n${shown}${more}`
      });
    } else {
      await chrome.action.setTitle({ title: BASE_TITLE });
    }
  } catch (e) {
    console.warn('cw-assist: badge refresh failed', e);
  }
}

// idempotent — re-arming an existing alarm just resets its schedule, so this
// is safe to run every time the worker wakes, not just on install
chrome.alarms.create(BADGE_ALARM, { periodInMinutes: BADGE_PERIOD_MIN, delayInMinutes: 0.1 });
chrome.alarms.onAlarm.addListener(a => { if (a.name === BADGE_ALARM) refreshBadge(); });

// refresh right away the first time a clientId shows up, rather than waiting
// out the rest of the alarm period with an empty badge
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.clientId) refreshBadge();
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
