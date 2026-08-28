/* Reports what the ConnectWise tab is showing: a ticket number, the
   board, or neither. ConnectWise swaps content without navigating, so
   poll rather than rely on page load. */

(() => {
  if (window.__cwTicketWatch) return;
  window.__cwTicketWatch = true;

  let last = '';

  const read = () => {
    const txt = document.body.innerText;
    const m = txt.match(/Service Ticket #(\d+)/);
    if (m) return { view: 'ticket', ticket: Number(m[1]) };
    if (/Service Board List/.test(txt)) return { view: 'board', ticket: null };
    return { view: null, ticket: null };
  };

  const tell = force => {
    const now = read();
    const key = `${now.view}:${now.ticket}`;
    if (!force && key === last) return;
    last = key;
    try {
      // throws synchronously once the extension is reloaded and this script
      // is orphaned, so a .catch() alone is not enough
      chrome.runtime.sendMessage({ onTicket: now.ticket, view: now.view })?.catch(() => {});
    } catch {
      clearInterval(timer);          // stop pinging a context that is gone
    }
  };

  tell(true);
  const timer = setInterval(tell, 1200);

  chrome.runtime.onMessage.addListener((msg, _s, reply) => {
    if (msg === 'whichTicket') { reply(read()); return true; }
  });
})();
