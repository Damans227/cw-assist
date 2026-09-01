/* Paints three things directly onto the real ConnectWise Service Board List
   — no need to open the side panel to see any of them:

   1. tints a row light red when the ticket is waiting on us
   2. appends a human "(2 hr ago)" next to CW's own absolute Last Update
      timestamp
   3. marks a ticket that already has an active chat about it in Open WebUI
      with a small 💬, next to the ticket number

   The first two come from background.js's poll (chrome.storage.local:
   `waitingOnUsIds` and `boardLastUpdated`). The third comes from
   `handoffChats`, written by the side panel's own "Open in chat" feature
   — nothing new is fetched for it, it's just surfaced here too. This
   script only reads storage and paints the DOM; it never talks to
   ConnectWise or the model itself.

   There's no visibility into ConnectWise's actual grid markup from here,
   so rather than assume column positions (a leading checkbox column
   shifts everything over, and a table's structure can vary by view), a
   row's ticket id is found by matching cell *text* against the known set
   of open ticket ids, and its Last Update cell by matching CW's own date
   format (e.g. "Tue 9/1/26 10:28 AM UTC-04") rather than a fixed column. */

(() => {
  if (window.__cwBoardHighlight) return;
  window.__cwBoardHighlight = true;

  const TINT_CLASS = 'cw-assist-us-turn';
  const AGE_CLASS = 'cw-assist-relage';
  const CHAT_CLASS = 'cw-assist-chat';

  function ensureStyle() {
    if (document.getElementById('cw-assist-style')) return;
    const style = document.createElement('style');
    style.id = 'cw-assist-style';
    style.textContent = `
      tr.${TINT_CLASS} > td{ background:#fdecea !important; }
      .${AGE_CLASS}{ margin-left:6px; font-size:11.5px; font-weight:700; color:#0a3560; white-space:nowrap; }
      /* emoji glyphs carry a much taller natural line-height than the
         surrounding text — in a dense, fixed-height grid row that overflows
         the row's own bounds, which is what made it look like it was
         floating into the row above. Pin it down. */
      .${CHAT_CLASS}{ margin-right:4px; display:inline-block; font-size:12px; line-height:1; vertical-align:middle; }
    `;
    document.head.appendChild(style);
  }

  // an exact-match lookup (here, and in idHost below) breaks the moment a
  // mark we already inserted sits inside the thing being compared — "7241"
  // reads back as "💬7241" on the very next pass. Compare against a
  // detached clone with our own marks stripped out instead of the live text.
  function plainText(el) {
    const clone = el.cloneNode(true);
    clone.querySelectorAll('.' + CHAT_CLASS + ', .' + AGE_CLASS).forEach(n => n.remove());
    return (clone.textContent || '').trim();
  }

  // same descent idea as textHost below — land inside the deepest wrapper
  // around the ticket number rather than as a sibling at the <td> level.
  // CW's grid framework positions that inner wrapper itself (it's not
  // plain table flow), so a sibling span at the <td> level doesn't
  // participate in that layout and ends up displaced. Stops one level
  // before the <a> itself so the badge doesn't become part of the link.
  function idHost(cell, id) {
    let host = cell;
    for (;;) {
      const next = [...host.children].find(c => c.tagName !== 'A' && plainText(c) === id);
      if (!next) return host;
      host = next;
    }
  }

  function markChat(cell, id, has) {
    // search the whole cell, not just direct children of whatever idHost
    // returns — the existing badge may be nested deeper than a single call
    // would redescend to, and missing it here is exactly how the last
    // refresh cycle ended up inserting a second one instead of finding it
    const existing = cell.querySelector('.' + CHAT_CLASS);
    if (!has) { existing?.remove(); return; }
    if (existing) return;
    const host = idHost(cell, id);
    const badge = document.createElement('span');
    badge.className = CHAT_CLASS;
    badge.textContent = '💬';
    badge.title = 'has an active chat about this ticket in Open WebUI';
    host.insertBefore(badge, host.firstChild);
  }

  function ageText(ms) {
    const min = Math.floor(ms / 60000);
    const hr  = Math.floor(ms / 3600000);
    if (min < 1)  return 'just now';
    if (min < 60) return `${min} min ago`;
    if (hr < 24)  return `${hr} hr ago`;
    const day = Math.floor(ms / 86400000), remHr = hr % 24;
    const d = `${day} day${day === 1 ? '' : 's'}`;
    return remHr ? `${d} ${remHr} hr ago` : `${d} ago`;
  }

  // CW's own "Last Update" cell text, e.g. "Tue 9/1/26 10:28 AM UTC-04" —
  // matched by shape (a date, then a time with AM/PM) rather than the exact
  // format, so a different locale/format still has a decent shot at matching
  const DATE_CELL = /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b[^0-9]{0,12}\b\d{1,2}:\d{2}\s*(AM|PM)\b/i;

  // the smallest descendant that still contains the whole date text —
  // appending inside that (not the outer <td>) keeps the mark on the same
  // line as the date itself, in case CW wraps the date in its own
  // block-level element. A block-level sibling forces a line break
  // regardless of white-space:nowrap on an ancestor, so appending too high
  // up would still push the mark below no matter what we set that to.
  function textHost(el) {
    for (;;) {
      const next = [...el.children].find(c =>
        !c.classList.contains(AGE_CLASS) && DATE_CELL.test((c.innerText || c.textContent || '').trim()));
      if (!next) return el;
      el = next;
    }
  }

  function markAge(tr, iso) {
    for (const cell of tr.querySelectorAll('td')) {
      const text = (cell.innerText || cell.textContent || '').trim();
      if (!DATE_CELL.test(text)) continue;
      let mark = cell.querySelector('.' + AGE_CLASS);
      if (!mark) {
        const host = textHost(cell);
        mark = document.createElement('span');
        mark.className = AGE_CLASS;
        // a trailing <br> already inside host would force a new line no
        // matter what CSS says, if we just appended after it — go before it
        const br = host.querySelector(':scope > br');
        if (br) host.insertBefore(mark, br); else host.appendChild(mark);
        // .style.whiteSpace alone can still lose to a stylesheet rule that
        // is itself !important — setProperty lets us match that
        cell.style.setProperty('white-space', 'nowrap', 'important');
        host.style.setProperty('white-space', 'nowrap', 'important');
      }
      mark.textContent = `(${ageText(Date.now() - new Date(iso).getTime())})`;
      return;
    }
  }

  function refreshDom(waitingIds, ages, chatIds) {
    ages = ages || {};
    const knownIds = Object.keys(ages);
    if (!knownIds.length) {
      document.querySelectorAll('tr.' + TINT_CLASS).forEach(tr => tr.classList.remove(TINT_CLASS));
      return;
    }
    ensureStyle();
    const waitingSet = new Set((waitingIds || []).map(String));
    const chatSet = chatIds || new Set();

    document.querySelectorAll('tr').forEach(tr => {
      let id = null, idCell = null;
      for (const cell of tr.querySelectorAll('td,th')) {
        const text = plainText(cell);
        if (ages[text] !== undefined) { id = text; idCell = cell; break; }
      }
      if (id == null) {
        tr.classList.remove(TINT_CLASS);
        tr.querySelectorAll('.' + AGE_CLASS).forEach(m => m.remove());
        return;
      }

      tr.classList.toggle(TINT_CLASS, waitingSet.has(id));
      markAge(tr, ages[id]);
      markChat(idCell, id, chatSet.has(id));
    });
  }

  // ConnectWise re-renders the grid in place (filter, sort, page through
  // results) without a real navigation — catch that with a debounced
  // observer, plus a slow poll as a backstop that also keeps the "X ago"
  // labels ticking up between background.js's own 5-minute polls
  let debounce = null;
  const mo = new MutationObserver(() => {
    clearTimeout(debounce);
    debounce = setTimeout(refresh, 400);
  });
  mo.observe(document.body, { childList: true, subtree: true });

  // same key shape sidepanel.js/background.js use for handoffChats —
  // "<cwOrigin>|<ticketId>" — kept in sync with cwlib.js's handoffKey().
  // Deliberately location.origin, not the stored cwOrigin setting: this
  // script already runs inside the ConnectWise tab, so it's the ground
  // truth — reading a separately-stored copy risked a mismatch (different
  // case, a stale value) the moment the side panel wrote its own cwOrigin
  // into storage, silently wiping every badge on the very next refresh.
  function chatIdsFor(handoffChats) {
    const prefix = location.origin + '|';
    return new Set(
      Object.keys(handoffChats || {})
        .filter(k => k.startsWith(prefix))
        .map(k => k.slice(prefix.length))
    );
  }

  function refresh() {
    chrome.storage.local.get(['waitingOnUsIds', 'boardLastUpdated', 'handoffChats'], r => {
      if (chrome.runtime.lastError) return;   // extension reloaded, this instance is orphaned
      // refreshDom's own writes (the age span, the class toggle, the chat
      // badge) are childList/subtree mutations too — without pausing, the
      // observer above would see them and schedule another refresh, forever
      mo.disconnect();
      refreshDom(r.waitingOnUsIds, r.boardLastUpdated, chatIdsFor(r.handoffChats));
      mo.observe(document.body, { childList: true, subtree: true });
    });
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' &&
        (changes.waitingOnUsIds || changes.boardLastUpdated || changes.handoffChats)) refresh();
  });

  refresh();
  setInterval(refresh, 5000);
})();
