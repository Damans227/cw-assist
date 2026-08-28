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
