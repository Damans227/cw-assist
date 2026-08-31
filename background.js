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
});
