/* Tints rows on the real ConnectWise Service Board List — no need to open
   the side panel to see which open tickets are waiting on us. Same
   heuristic and same data as the toolbar badge (background.js polls it
   into chrome.storage.local as `waitingOnUsIds`); this script only reads
   that and paints the DOM. It never talks to ConnectWise or the model
   itself.

   There's no visibility into ConnectWise's actual grid markup from here,
   so rather than assume a column position (a leading checkbox column
   shifts everything over, and a table's structure can vary by view), this
   matches any cell in a row whose exact trimmed text is a known open
   ticket id. A plain 4-6 digit number sitting alone in a cell is, in
   practice, always the Ticket # cell. */

(() => {
  if (window.__cwBoardHighlight) return;
  window.__cwBoardHighlight = true;

  const CLASS = 'cw-assist-us-turn';

  function ensureStyle() {
    if (document.getElementById('cw-assist-style')) return;
    const style = document.createElement('style');
    style.id = 'cw-assist-style';
    // !important to win over whatever zebra-striping the grid already applies
    style.textContent = `tr.${CLASS} > td{ background:#fdecea !important; }`;
    document.head.appendChild(style);
  }

  function applyHighlight(ids) {
    const idSet = new Set((ids || []).map(String));

    // clear stale marks first — a ticket that's no longer waiting on us (or
    // scrolled out during a re-render) should lose its tint
    document.querySelectorAll('tr.' + CLASS).forEach(tr => tr.classList.remove(CLASS));
    if (!idSet.size) return;

    ensureStyle();
    document.querySelectorAll('tr').forEach(tr => {
      for (const cell of tr.querySelectorAll('td,th')) {
        const text = (cell.innerText || cell.textContent || '').trim();
        if (idSet.has(text)) { tr.classList.add(CLASS); return; }
      }
    });
  }

  function refresh() {
    chrome.storage.local.get('waitingOnUsIds', ({ waitingOnUsIds }) => {
      if (chrome.runtime.lastError) return;   // extension reloaded, this instance is orphaned
      applyHighlight(waitingOnUsIds);
    });
  }

  // ConnectWise re-renders the grid in place (filter, sort, page through
  // results) without a real navigation — catch that with a debounced
  // observer, plus a slow poll as a cheap backstop against a missed mutation
  let debounce = null;
  const mo = new MutationObserver(() => {
    clearTimeout(debounce);
    debounce = setTimeout(refresh, 400);
  });
  mo.observe(document.body, { childList: true, subtree: true });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.waitingOnUsIds) refresh();
  });

  refresh();
  setInterval(refresh, 5000);
})();
