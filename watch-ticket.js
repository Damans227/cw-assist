/* Reports what the ConnectWise tab is showing: a ticket number, the
   board, or neither. ConnectWise swaps content without navigating, so
   poll rather than rely on page load. */

(() => {
  if (window.__cwTicketWatch) return;
  window.__cwTicketWatch = true;

  let last = '';

  // The note tab counts on a ticket screen ("Discussion 14 ... All 14").
  // Saving a note bumps these without changing the view, and it is the only
  // cue on the page that a note has just landed — the badge needs it so a
  // row you have just answered stops being tinted right away.
  const noteCount = txt => {
    let n = 0;
    for (const [, d] of txt.matchAll(/\b(?:Discussion|All)\s+(\d+)\b/g)) n = Math.max(n, Number(d));
    return n;
  };

  const read = () => {
    const txt = document.body.innerText;
    const m = txt.match(/Service Ticket #(\d+)/);
    if (m) return { view: 'ticket', ticket: Number(m[1]), notes: noteCount(txt) };
    if (/Service Board List/.test(txt)) return { view: 'board', ticket: null };
    return { view: null, ticket: null };
  };

  const tell = force => {
    const now = read();
    // the note count is part of the key so a save re-pings, even though the
    // message itself only carries the view — the side panel keys on that
    // alone and ignores a repeat, the worker uses it to re-grade the ticket
    const key = `${now.view}:${now.ticket}:${now.notes ?? ''}`;
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
