const $ = id => document.getElementById(id);

let ticket = null;
let view = null;
let lastKey = '';
let busy = false;
let settingsOpen = false;   // while true, the tab poll must not swap the view out
let boardTab = 'latest';    // 'latest' | 'history' — a view, switching it never calls the model
let ticketLane = 'summary'; // 'summary' | 'standing' | 'ghissue' — which lane is showing

/* ---- board summary history, kept in chrome.storage.local ------------ */

const HISTORY_KEY = 'boardHistory';
const HISTORY_CAP = 50;   // bound growth — a run is a few KB, this stays well under quota

async function loadHistory() {
  const { [HISTORY_KEY]: hist = [] } = await chrome.storage.local.get(HISTORY_KEY);
  return hist;
}
async function saveHistoryEntry(entry) {
  const hist = await loadHistory();
  hist.unshift(entry);
  hist.length = Math.min(hist.length, HISTORY_CAP);
  await chrome.storage.local.set({ [HISTORY_KEY]: hist });
}
async function deleteHistoryEntry(id) {
  const hist = (await loadHistory()).filter(h => h.id !== id);
  await chrome.storage.local.set({ [HISTORY_KEY]: hist });
  return hist;
}

/* ---- per-ticket, per-lane "latest" — one saved doc per "ticket:lane", not
   a growing list: each run overwrites the last, so there's nothing to browse
   or prune, and storage grows with unique tickets visited, not runs made -- */

const TICKET_LATEST_KEY = 'ticketLatest';
const ticketLatestKey = (ticketId, lane) => `${ticketId}:${lane}`;

async function loadTicketLatest(ticketId, lane) {
  const { [TICKET_LATEST_KEY]: all = {} } = await chrome.storage.local.get(TICKET_LATEST_KEY);
  return all[ticketLatestKey(ticketId, lane)] || null;
}
async function saveTicketLatest(ticketId, lane, entry) {
  const { [TICKET_LATEST_KEY]: all = {} } = await chrome.storage.local.get(TICKET_LATEST_KEY);
  all[ticketLatestKey(ticketId, lane)] = entry;
  await chrome.storage.local.set({ [TICKET_LATEST_KEY]: all });
}

/* ---- GitHub issue draft — one per ticket, survives tab switches and
   revisits until it is finalised or discarded ----------------------- */

const ISSUE_DRAFT_KEY = 'issueDrafts';

async function loadIssueDraft(ticketId) {
  const { [ISSUE_DRAFT_KEY]: all = {} } = await chrome.storage.local.get(ISSUE_DRAFT_KEY);
  return all[ticketId] || null;
}
async function saveIssueDraft(ticketId, entry) {
  const { [ISSUE_DRAFT_KEY]: all = {} } = await chrome.storage.local.get(ISSUE_DRAFT_KEY);
  all[ticketId] = entry;
  await chrome.storage.local.set({ [ISSUE_DRAFT_KEY]: all });
}
async function deleteIssueDraft(ticketId) {
  const { [ISSUE_DRAFT_KEY]: all = {} } = await chrome.storage.local.get(ISSUE_DRAFT_KEY);
  delete all[ticketId];
  await chrome.storage.local.set({ [ISSUE_DRAFT_KEY]: all });
}

const fmtWhen = ts => new Date(ts).toLocaleString([], {
  month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
});

/* ---- header meta: "(As of ...)" becomes a human relative age, color-coded
   by staleness — it doubles as a nudge that a summary is due a re-run ---- */

function ageText(ms) {
  const min = Math.floor(ms / 60000);
  const hr  = Math.floor(ms / 3600000);
  if (min < 1)  return 'just now';
  if (min < 60) return `${min} min old`;
  if (hr < 24)  return `${hr} hr old`;
  const day = Math.floor(ms / 86400000), remHr = hr % 24;
  const d = `${day} day${day === 1 ? '' : 's'}`;
  return remHr ? `${d} ${remHr} hr old` : `${d} old`;
}

// fresh under 4h, worth a re-run under a day, stale beyond that — the board
// or ticket has likely moved on since this summary was generated
const ageClass = ms => ms < 4 * 3600000 ? 'age-ok' : ms < 86400000 ? 'age-warn' : 'age-bad';

let metaTs = null;   // timestamp behind the age currently shown in #meta, or null

function renderMetaAge() {
  if (metaTs == null) return;
  const ms = Date.now() - metaTs;
  $('meta').textContent = `(${ageText(ms)})`;
  $('meta').className = ageClass(ms);
}

// shows a live-aging, color-coded "(x hr old)" in the header meta slot
function setMetaAge(ts) { metaTs = ts; renderMetaAge(); }

// any other header meta text — resets the age class so it doesn't linger
function setMeta(text = '') { metaTs = null; $('meta').textContent = text; $('meta').className = ''; }

setInterval(renderMetaAge, 30000);   // keeps the age ticking up while the panel sits open

// a naive split('|') breaks on a shell pipe the model left inside a code
// span, e.g. `ss -tnp | grep 5902` — walk the row and ignore '|' while
// inside backticks instead
function tableCells(row) {
  const body = row.trim().replace(/^\||\|$/g, '');
  const cells = [];
  let cur = '', inCode = false;
  for (const c of body) {
    if (c === '`') inCode = !inCode;
    if (c === '|' && !inCode) { cells.push(cur.trim()); cur = ''; }
    else cur += c;
  }
  cells.push(cur.trim());
  return cells;
}

// the model is asked for "Ticket | Company | ..." but doesn't always follow
// casing exactly, so fix it up here rather than trust the prompt alone
const capHead = s => s.charAt(0).toUpperCase() + s.slice(1);

// pulls the first markdown table out of a run's saved text, for CSV export —
// same shape of table() below, but returns raw cells rather than rendered HTML
function tableRows(md) {
  for (const b of md.split(/\n{2,}/)) {
    const rows = b.split('\n').filter(l => l.trim().startsWith('|'));
    if (rows.length < 2 || !/^\s*\|[\s:|-]+\|\s*$/.test(rows[1])) continue;
    return { head: tableCells(rows[0]).map(capHead), body: rows.slice(2).map(tableCells) };
  }
  return null;
}

function toCsv({ head, body }) {
  const cell = v => /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  return [head, ...body].map(r => r.map(cell).join(',')).join('\r\n');
}

function downloadCsv(entry) {
  const rows = tableRows(entry.text || '');
  if (!rows) { $('out').insertAdjacentHTML('afterbegin',
    '<p class="err">No table found in this run to export.</p>'); return; }

  const blob = new Blob([toCsv(rows)], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `board-summary-${new Date(entry.ts).toISOString().slice(0, 16).replace(/[:T]/g, '-')}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// shared by board history (unit "open tickets", CSV offered — there's a real
// table to export) and per-ticket history (unit "notes", prose only, no CSV)
function renderHistoryList(hist, { unit = 'runs', csv = false } = {}) {
  if (!hist.length) return '<span class="idle">No saved runs yet — hit Run.</span>';
  return '<div class="hist">' + hist.map(h => `
    <div class="hist-row" data-id="${h.id}">
      <div class="hist-head">
        <span class="hist-caret">&rsaquo;</span>
        <span class="hist-when">${fmtWhen(h.ts)}</span>
        <span class="hist-count">${h.noteCount ?? '?'} ${unit}</span>
        ${csv ? `<button class="hist-csv" data-id="${h.id}" title="download this run as CSV">CSV</button>` : ''}
        <button class="hist-del" data-id="${h.id}" title="delete this run">&times;</button>
      </div>
      <div class="hist-body" hidden>${render(h.text || '')}</div>
    </div>`).join('') + '</div>';
}

// deps.loadEntries / deps.onDelete let one function serve both board and
// per-ticket history lists rather than duplicating the row wiring
function wireHistoryRows({ loadEntries, onDelete }) {
  document.querySelectorAll('.hist-row').forEach(row => {
    row.querySelector('.hist-head').addEventListener('click', e => {
      if (e.target.closest('button')) return;
      const body = row.querySelector('.hist-body');
      body.hidden = !body.hidden;
      row.classList.toggle('open', !body.hidden);
    });
  });
  document.querySelectorAll('.hist-csv').forEach(btn => {
    btn.onclick = async e => {
      e.stopPropagation();
      const entry = (await loadEntries()).find(h => h.id === btn.dataset.id);
      if (entry) downloadCsv(entry);
    };
  });
  document.querySelectorAll('.hist-del').forEach(btn => {
    btn.onclick = async e => {
      e.stopPropagation();
      await onDelete(btn.dataset.id);
    };
  });
}

/* ---- board tabs: pure view switches, no model call ------------------- */

async function renderBoardLatest() {
  const hist = await loadHistory();
  if (!hist.length) {
    $('out').innerHTML = '<span class="idle">Summarise every open ticket and what to do first — hit Run summary.</span>';
    $('foot').textContent = '';
    setMeta();
    return;
  }
  const h = hist[0];
  $('out').innerHTML = render(h.text || '(empty response)');
  $('foot').textContent = `${h.noteCount} open tickets`;
  setMetaAge(h.ts);
}

async function renderBoardHistoryTab() {
  const hist = await loadHistory();
  $('out').innerHTML = renderHistoryList(hist, { unit: 'open tickets', csv: true });
  $('foot').textContent = hist.length ? `${hist.length} saved run${hist.length === 1 ? '' : 's'}` : '';
  setMeta();
  wireHistoryRows({
    loadEntries: loadHistory,
    onDelete: async id => { await deleteHistoryEntry(id); await renderBoardHistoryTab(); }
  });
}

function showBoardTab(tab) {
  boardTab = tab;
  document.querySelectorAll('#boardTabs .tab').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  return tab === 'history' ? renderBoardHistoryTab() : renderBoardLatest();
}

/* ---- ticket lanes (Summary / Outstanding) — no history, just the latest -- */

async function renderTicketLatest() {
  const h = await loadTicketLatest(ticket, ticketLane);
  if (!h) {
    $('out').innerHTML = '<span class="idle">Nothing saved yet for this ticket — hit Run.</span>';
    $('foot').textContent = '';
    setMeta();
    return;
  }
  $('out').innerHTML = render(h.text || '(empty response)');
  $('sum').textContent = [h.company, h.summary].filter(Boolean).join(' · ');
  $('foot').textContent = `${h.noteCount ?? '?'} notes`;
  setMetaAge(h.ts);
}

function showTicketLane(lane) {
  ticketLane = lane;
  document.querySelectorAll('#ticketLaneTabs .tab').forEach(b => b.classList.toggle('on', b.dataset.lane === lane));

  // the GH issue lane carries its own action buttons, so the shared Run button
  // steps aside for it
  const isIssue = lane === 'ghissue';
  $('ticketRun').hidden = isIssue;
  if (isIssue) return renderIssueLane();

  $('ticketRun').textContent = lane === 'summary' ? 'Run summary' : 'Run outstanding';
  return renderTicketLatest();
}

// picks the display name for a repo entry
const repoLabel = r => (r.name || '').trim() || r.repo;

// reads the configured [{ name, repo }] list, dropping blank entries; falls
// back to the seeded default when settings have never been touched
async function loadRepos() {
  const { ghRepos = [] } = await chrome.storage.local.get({ ghRepos: DEFAULTS.ghRepos });
  return (Array.isArray(ghRepos) ? ghRepos : []).filter(r => r && (r.repo || '').trim());
}

const repoOptions = (repos, selected) =>
  repos.map(r =>
    `<option value="${esc(r.repo)}"${r.repo === selected ? ' selected' : ''}>${esc(repoLabel(r))}</option>`
  ).join('');

// remembered across lane switches within this panel session
let lastRepoChoice = '';

// the GitHub lane: show the saved draft if there is one, otherwise a repo
// picker + a Draft button that only lights up once a repo is chosen
async function renderIssueLane() {
  const saved = await loadIssueDraft(ticket);
  if (saved) { showIssueDraft(saved); return; }

  $('sum').textContent = '';
  setMeta();
  $('foot').textContent = '';

  const repos = await loadRepos();
  if (!repos.length) {
    $('out').innerHTML =
      '<p class="idle">No GitHub repos configured yet — add one in <a href="#" id="toSettings">settings</a>.</p>';
    $('toSettings').onclick = e => { e.preventDefault(); openSettings(); };
    return;
  }

  const preset = repos.some(r => r.repo === lastRepoChoice) ? lastRepoChoice : '';
  $('out').innerHTML = `
    <div class="ghdraft">
      <label class="ghlabel" for="ghRepoSel">Repository</label>
      <select id="ghRepoSel" class="ghtitle">
        <option value="">Choose a repo…</option>
        ${repoOptions(repos, preset)}
      </select>
      <div class="ghactions">
        <button class="run" id="ghGen"${preset ? '' : ' disabled'}>Draft Issue</button>
      </div>
    </div>`;

  const sel = $('ghRepoSel'), gen = $('ghGen');
  sel.onchange = () => { lastRepoChoice = sel.value; gen.disabled = !sel.value; };
  gen.onclick = () => { if (!busy && sel.value) generateIssueDraft(sel.value); };
}

/* ---- which ticket is on screen ------------------------------------- */

// any ConnectWise-cloud pod: na / eu / au / staging.* etc.
const CW_HOST = /^https:\/\/([a-z0-9-]+\.)*myconnectwise\.net$/i;

function cwOriginOf(url) {
  try { const u = new URL(url); return CW_HOST.test(u.origin) ? u.origin : ''; }
  catch { return ''; }
}

// fill cwOrigin from the tab we are looking at, but never override a value the
// user set by hand
let learnedOrigin = null;
async function learnOrigin(origin) {
  if (!origin || learnedOrigin === origin) return;
  learnedOrigin = origin;
  const { cwOrigin } = await chrome.storage.local.get('cwOrigin');
  if (!cwOrigin) await chrome.storage.local.set({ cwOrigin: origin });
}

async function currentView() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const origin = cwOriginOf(tab?.url);
  if (!origin) return { view: null, ticket: null };
  learnOrigin(origin);
  try {
    return await chrome.tabs.sendMessage(tab.id, 'whichTicket');
  } catch {
    return { view: null, ticket: null };   // content script not in this tab yet
  }
}

function setView(v) {
  const key = `${v.view}:${v.ticket}`;
  if (key === lastKey) return;
  lastKey = key;
  ticket = v.ticket;
  view = v.view;

  const onTicket = view === 'ticket' && ticket;
  const onBoard  = view === 'board';

  $('ticketLaneBtns').hidden = !onTicket;   // ticketRun lives inside this row, hides with it
  $('tkBtns').hidden         = !onTicket;   // wrapper too, or its grid gap
  $('openChat').hidden       = !onTicket;   // still nudges boardRun off the edge
  $('attachRun').hidden      = !onTicket;
  $('boardBtns').hidden      = !onBoard;
  $('boardRun').hidden       = !onBoard;

  $('num').textContent = onTicket ? ticket : (onBoard ? 'Board' : '—');
  setMeta();
  $('sum').textContent = '';
  $('foot').textContent = '';

  refreshGhIssueTab();         // tab label shows if this ticket already has a draft
  if (onTicket) refreshOpenChatLabel();

  if (onBoard) {
    showBoardTab('latest');    // free — just redisplays the last saved run, if any
  } else if (onTicket) {
    showTicketLane('summary'); // reset to a sane default for the newly opened ticket
  } else {
    $('out').innerHTML = '<span class="idle">Open the service board or a ticket in ConnectWise.</span>';
  }
}

(async () => setView(await currentView()))();
setInterval(async () => { if (!busy && !settingsOpen) setView(await currentView()); }, 1500);

// the content script also pushes changes as they happen
chrome.runtime.onMessage.addListener(msg => {
  if (msg && 'onTicket' in msg && !busy && !settingsOpen) setView({ view: msg.view, ticket: msg.onTicket });
});

/* ---- rendering ------------------------------------------------------ */

const esc = s => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

// the board triage table carries a trailing "Whose move" column that is not
// meant to be read, only to color the row — Us gets a light-red background,
// everything else (Customer / Third party / missing) is left alone
function extractWhoseMove(head, body) {
  const idx = head.findIndex(h => h.trim().toLowerCase() === 'whose move');
  if (idx === -1) return { head, body, whoseMove: null };
  return {
    head: head.filter((_, i) => i !== idx),
    body: body.map(r => r.filter((_, i) => i !== idx)),
    whoseMove: body.map(r => (r[idx] || '').trim().toLowerCase())
  };
}

function table(block) {
  const rows = block.split('\n').filter(l => l.trim().startsWith('|'));
  if (rows.length < 2 || !/^\s*\|[\s:|-]+\|\s*$/.test(rows[1])) return null;

  const rawHead = tableCells(rows[0]).map(capHead);
  const rawBody = rows.slice(2).map(tableCells);
  const { head, body, whoseMove } = extractWhoseMove(rawHead, rawBody);

  // inside a cell there is no room for headings, so let a bold label like
  // "Blocked on:" start its own line rather than running on from the prose
  const inline = t => esc(t)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*(.+?)\*\*/g, (m, g) =>
      /:$/.test(g.trim()) ? `<span class="lbl">${g}</span>` : `<strong>${g}</strong>`)
    .replace(/(<\/code>|\.|\))\s*(<span class="lbl">)/g, '$1<br>$2');

  return `<table><thead><tr>${head.map(h => `<th>${inline(h)}</th>`).join('')}</tr></thead>` +
    `<tbody>${body.map((r, i) =>
      `<tr${whoseMove?.[i] === 'us' ? ' class="us-turn"' : ''}>${r.map(c => `<td>${inline(c)}</td>`).join('')}</tr>`
    ).join('')}</tbody></table>`;
}

function render(md) {
  const blocks = [];
  // pull fenced code out first so its contents are left alone
  const held = [];
  md = md.replace(/```[\w-]*\n([\s\S]*?)```/g, (_, code) => {
    held.push(`<pre><code>${esc(code.replace(/\n$/, ''))}</code></pre>`);
    return `\u0000${held.length - 1}\u0000`;
  });

  for (let b of md.split(/\n{2,}/)) {
    b = b.trim();
    if (!b) continue;

    const ph = b.match(/^\u0000(\d+)\u0000$/);
    if (ph) { blocks.push(held[+ph[1]]); continue; }

    if (b.startsWith('|')) {
      const t = table(b);
      if (t) { blocks.push(t); continue; }
    }

    let h = esc(b)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

    // a heading may be followed by its body in the same block
    if (/^#{1,4}\s/.test(b)) {
      const [first, ...rest] = h.split('\n');
      blocks.push(`<h4>${first.replace(/^#{1,4}\s*/, '')}</h4>`);
      const body = rest.join('\n').trim();
      if (body) {
        if (/^\s*([-*]|\d+[.)])\s/.test(body)) {
          blocks.push('<ul>' + body.split('\n').filter(l => l.trim())
            .map(l => `<li>${l.replace(/^\s*([-*]|\d+[.)])\s*/, '')}</li>`).join('') + '</ul>');
        } else {
          blocks.push(`<p>${body.replace(/\n/g, ' ')}</p>`);
        }
      }
      continue;
    }

    // models often lead a paragraph with a bold label instead of a real
    // heading — "**Where it stands** Customer's move…" — so split that out
    const lead = b.match(/^\*\*(.{2,60}?)\*\*[:.]?\s+([\s\S]+)$/);
    if (lead) {
      const head = esc(lead[1]).replace(/^\d+[.)]\s*/, '');
      const rest = esc(lead[2])
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\n/g, ' ');
      blocks.push(`<h4>${head}</h4><p>${rest}</p>`);
      continue;
    }

    if (/^\s*([-*]|\d+\.)\s/m.test(b) && b.split('\n').every(l => /^\s*([-*]|\d+\.)\s/.test(l) || !l.trim())) {
      const items = h.split('\n').filter(l => l.trim())
        .map(l => `<li>${l.replace(/^\s*([-*]|\d+\.)\s*/, '')}</li>`).join('');
      blocks.push(`<ul>${items}</ul>`);
      continue;
    }
    blocks.push(`<p>${h.replace(/\n/g, ' ')}</p>`);
  }
  return blocks.join('');
}

/* ---- run ------------------------------------------------------------ */

document.querySelectorAll('#ticketLaneTabs .tab').forEach(btn => {
  btn.onclick = () => { if (!busy) showTicketLane(btn.dataset.lane); };
});

$('ticketRun').onclick = async () => {
  if (busy || !ticket) return;
  busy = true;
  $('ticketRun').disabled = true;
  $('out').innerHTML = '<span class="wait">Reading the thread…</span>';
  $('foot').textContent = '';

  const t0 = Date.now();
  const show = () =>
    $('out').innerHTML =
      `<span class="wait">Reading the thread — ${((Date.now() - t0) / 1000).toFixed(0)}s…</span>`;
  show();
  const tick = setInterval(show, 1000);

  try {
    const res = await ask(ticketLane, ticket);
    clearInterval(tick);
    const ts = Date.now();

    $('out').innerHTML = render(res.text || '(empty response)');
    $('sum').textContent = [res.company, res.summary].filter(Boolean).join(' · ');
    $('foot').textContent = `${res.noteCount} notes · ${((Date.now() - t0) / 1000).toFixed(1)}s`;
    setMetaAge(ts);

    await saveTicketLatest(ticket, ticketLane, {
      ts,
      noteCount: res.noteCount,
      company: res.company,
      summary: res.summary,
      text: res.text || ''
    });
  } catch (e) {
    clearInterval(tick);
    $('out').innerHTML = `<span class="err">${esc(String(e.message || e))}</span>`;
    $('foot').textContent = `failed after ${((Date.now() - t0) / 1000).toFixed(1)}s`;
  } finally {
    clearInterval(tick);
    busy = false;
    $('ticketRun').disabled = false;
  }
};

/* ---- the GitHub lane: draft from the ticket, edit it, then create it ---- */

async function generateIssueDraft(repo) {
  if (busy || !ticket) return;
  busy = true;
  $('foot').textContent = '';

  const t0 = Date.now();
  const show = () =>
    $('out').innerHTML =
      `<span class="wait">Reading the thread for an issue draft — ${((Date.now() - t0) / 1000).toFixed(0)}s…</span>`;
  show();
  const tick = setInterval(show, 1000);

  try {
    const chosen = repo || lastRepoChoice || '';
    const repos = await loadRepos();
    const repoName = repos.find(r => r.repo === chosen)?.name?.trim() || chosen;
    const res = await askIssue(ticket, repoName);
    clearInterval(tick);
    const entry = {
      ts: Date.now(),
      repo: chosen,
      title: res.title, body: res.body,
      company: res.company, summary: res.summary, noteCount: res.noteCount
    };
    await saveIssueDraft(ticket, entry);
    showIssueDraft(entry);
    refreshGhIssueTab();
  } catch (e) {
    clearInterval(tick);
    $('out').innerHTML = `<span class="err">${esc(String(e.message || e))}</span>`;
    $('foot').textContent = `failed after ${((Date.now() - t0) / 1000).toFixed(1)}s — reopen the GitHub tab to retry`;
  } finally {
    clearInterval(tick);
    busy = false;
  }
}

// marks the GitHub tab when this ticket already has a draft / created issue
async function refreshGhIssueTab() {
  const tab = document.querySelector('#ticketLaneTabs .tab[data-lane="ghissue"]');
  if (!tab) return;
  const saved = ticket ? await loadIssueDraft(ticket) : null;
  tab.textContent = saved?.created ? 'GitHub ✓' : saved ? 'GitHub •' : 'GitHub';
}

// the draft editor: a repo picker plus an editable title + body persisted as you
// type, a Finalize button that POSTs to the GitHub API, Regenerate to re-ask the
// model, and Discard to drop the saved draft
let draftSaveTimer = null;

async function showIssueDraft(entry) {
  const { title = '', body = '', company, summary, noteCount, ts, created, repo = '' } = entry;

  $('sum').textContent = [company, summary].filter(Boolean).join(' · ');
  setMeta(created ? `Issue #${created.number} created` : 'Issue draft');
  $('foot').textContent = created
    ? `created ${fmtWhen(created.ts)}`
    : `${noteCount ?? '?'} notes${ts ? ' · drafted ' + fmtWhen(ts) : ''} · edit, then Finalize`;

  const repos = await loadRepos();
  // keep the draft's repo selectable even if it was later removed from settings
  const known = repos.some(r => r.repo === repo);
  const extra = repo && !known ? `<option value="${esc(repo)}" selected>${esc(repo)} (not in settings)</option>` : '';

  $('out').innerHTML = `
    <div class="ghdraft">
      <label class="ghlabel" for="ghRepoSel">Repository</label>
      <select id="ghRepoSel" class="ghtitle">
        <option value=""${repo ? '' : ' selected'}>Choose a repo…</option>
        ${extra}
        ${repoOptions(repos, repo)}
      </select>
      <label class="ghlabel" for="ghTitle">Title</label>
      <input id="ghTitle" class="ghtitle" type="text">
      <label class="ghlabel" for="ghBody">Body</label>
      <textarea id="ghBody" class="ghbody" rows="20" spellcheck="false"></textarea>
      <div class="ghactions">
        <button class="run" id="ghFinalize">Finalize &amp; create issue</button>
        <button class="ghost" id="ghRegen">Regenerate</button>
        <button class="ghost" id="ghDiscard">Discard</button>
        <span class="ghmsg" id="ghMsg"></span>
      </div>
    </div>`;
  $('ghTitle').value = title;
  $('ghBody').value = body;
  if (repo) $('ghRepoSel').value = repo;

  // persist edits (debounced while typing, flushed on blur) so a tab switch
  // or a revisit keeps them
  const snapshot = () => ({
    ...entry, repo: $('ghRepoSel').value, title: $('ghTitle').value, body: $('ghBody').value
  });
  const persist = () => {
    clearTimeout(draftSaveTimer);
    draftSaveTimer = setTimeout(() => saveIssueDraft(ticket, snapshot()), 400);
  };
  const flush = () => { clearTimeout(draftSaveTimer); saveIssueDraft(ticket, snapshot()); };
  $('ghTitle').oninput = persist;
  $('ghBody').oninput = persist;
  $('ghTitle').onblur = flush;
  $('ghBody').onblur = flush;
  $('ghRepoSel').onchange = () => { lastRepoChoice = $('ghRepoSel').value; flush(); };

  if (created) {
    $('ghRepoSel').disabled = true;
    $('ghFinalize').disabled = true;
    $('ghFinalize').textContent = 'Created';
    $('ghMsg').innerHTML =
      `<span class="ok">Created <a href="${esc(created.url)}" target="_blank" rel="noreferrer">#${created.number}</a></span>`;
  }

  $('ghRegen').onclick = () => { if (!busy) generateIssueDraft($('ghRepoSel').value); };

  $('ghDiscard').onclick = async () => {
    clearTimeout(draftSaveTimer);
    await deleteIssueDraft(ticket);
    refreshGhIssueTab();
    renderIssueLane();
  };

  $('ghFinalize').onclick = async () => {
    const selRepo = $('ghRepoSel').value;
    const t = $('ghTitle').value.trim();
    const b = $('ghBody').value.trim();
    if (!selRepo) { $('ghMsg').innerHTML = '<span class="err">Pick a repository.</span>'; return; }
    if (!t) { $('ghMsg').innerHTML = '<span class="err">A title is required.</span>'; return; }

    busy = true;
    clearTimeout(draftSaveTimer);
    $('ghFinalize').disabled = true;
    $('ghRegen').disabled = true;
    $('ghDiscard').disabled = true;
    $('ghMsg').innerHTML = '<span class="wait">Creating issue…</span>';
    try {
      const { number, url } = await createGithubIssue({ repo: selRepo, title: t, body: b });
      const done = { ...entry, repo: selRepo, title: t, body: b, created: { number, url, ts: Date.now() } };
      await saveIssueDraft(ticket, done);
      refreshGhIssueTab();
      $('ghRepoSel').disabled = true;
      $('ghMsg').innerHTML =
        `<span class="ok">Created <a href="${esc(url)}" target="_blank" rel="noreferrer">#${number}</a></span>`;
      $('ghFinalize').textContent = 'Created';
      setMeta(`Issue #${number} created`);
    } catch (e) {
      $('ghFinalize').disabled = false;
      $('ghRegen').disabled = false;
      $('ghDiscard').disabled = false;
      $('ghMsg').innerHTML = `<span class="err">${esc(String(e.message || e))}</span>`;
    } finally {
      busy = false;
    }
  };
}

document.querySelectorAll('#boardTabs .tab').forEach(btn => {
  btn.onclick = () => { if (!busy) showBoardTab(btn.dataset.tab); };
});

$('boardRun').onclick = async () => {
  if (busy) return;
  busy = true;
  $('boardRun').disabled = true;
  await showBoardTab('latest');   // the fresh result is about to land here
  $('out').innerHTML = '<span class="wait">Reading the board…</span>';
  $('foot').textContent = '';

  const t0 = Date.now();
  const secs = () => ((Date.now() - t0) / 1000).toFixed(0);

  // the model call is one long request with no progress of its own, so keep
  // a clock running or it looks identical to a hang
  let tick = null;
  try {
    const res = await askBoard((done, total) => {
      if (done < total) {
        $('out').innerHTML = `<span class="wait">Reading ticket ${done} of ${total}…</span>`;
      } else if (!tick) {
        const started = Date.now();
        const show = () => {
          $('out').innerHTML =
            `<span class="wait">Read ${total} tickets. Waiting on the model — ` +
            `${((Date.now() - started) / 1000).toFixed(0)}s…</span>`;
        };
        show();
        tick = setInterval(show, 1000);
      }
    });
    clearInterval(tick);
    const ts = Date.now();
    $('out').innerHTML = render(res.text || '(empty response)');
    $('foot').textContent = `${res.noteCount} open tickets · ${secs()}s`;
    setMetaAge(ts);

    await saveHistoryEntry({
      id: `${ts}-${Math.random().toString(36).slice(2, 8)}`,
      ts,
      noteCount: res.noteCount,
      text: res.text || ''
    });
  } catch (e) {
    clearInterval(tick);
    $('out').innerHTML = `<span class="err">${esc(String(e.message || e))}</span>`;
    $('foot').textContent = `failed after ${secs()}s`;
  } finally {
    busy = false;
    $('boardRun').disabled = false;
  }
};

async function refreshOpenChatLabel() {
  const b = $('openChat');
  const c = await cfg();
  const known = !!(c.handoffChats || {})[handoffKey(c.cwOrigin, ticket)];
  b.textContent = known ? 'Continue chat →' : 'Open in chat →';
  b.title = known
    ? 'open the existing chat for this ticket and ask for the latest'
    : 'open this ticket in Open WebUI and ask for next steps';
}

// Opens (or reopens) this ticket's Open WebUI chat and closes the panel.
// Both header buttons end here; they differ only in what they put in opts.
async function openHandoff(opts = {}) {
  const { url, isNew, root, prompt } = await handoff(ticket, opts);
  const tab = await chrome.tabs.create({ url });
  if (isNew) {
    // background.js watches this tab for Open WebUI settling on /c/<id>
    // and files the chat id away so the next click reuses it.
    const { cwOrigin } = await chrome.storage.local.get('cwOrigin');
    await chrome.storage.local.set({
      pendingHandoff: { tabId: tab.id, ticket, cwOrigin, root, ts: Date.now() }
    });
  }
  // Open WebUI's own ?q= auto-send is racy against its chat-history load,
  // especially on an existing chat — background.js checks after the tab
  // loads and fills the prompt in itself if it never went out.
  await chrome.storage.local.set({
    pendingSend: { tabId: tab.id, prompt, ts: Date.now() }
  });
  window.close();
}

$('openChat').onclick = async () => {
  if (!ticket) return;
  const b = $('openChat');
  b.disabled = true;
  try {
    await openHandoff();
  } catch (e) {
    b.disabled = false;
    $('out').innerHTML = `<span class="err">${esc(String(e.message || e))}</span>`;
  }
};

/* ---- log analysis ----------------------------------------------------

   Lists what ConnectWise holds against the ticket, sends the ones you tick
   to the model's terminal, then opens the chat pointed at those paths.
   Anything already on the terminal from a previous run is named in the
   prompt but not re-uploaded — that is the whole reason the sandbox is used
   over a chat attachment, which would have to be re-sent every time.

   When something is skipped we stop on the result list rather than opening
   the chat: opening a tab closes this panel, and an error nobody sees is
   not an error report.                                                    */

const fileSize = n =>
  n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB`
  : n >= 1024  ? `${Math.round(n / 1024)} KB`
  : `${n} B`;

function renderAttachResult(res) {
  const sent = res.all.length
    ? `<h4>On the model's terminal</h4><ul>${res.all.map(f =>
        `<li><code>${esc(f.name)}</code> — ${fileSize(f.size)}</li>`).join('')}</ul>`
    : '';
  const bad = res.skipped.length
    ? `<h4>Not sent</h4><ul class="err">${res.skipped.map(f =>
        `<li><code>${esc(f.filename)}</code> — ${esc(f.why)}</li>`).join('')}</ul>`
    : '';
  const go = res.all.length
    ? `<div class="ghactions"><button class="run" id="attachAnyway">Analyse the rest &rarr;</button></div>`
    : '';
  $('out').innerHTML = sent + bad + go;
  if (go) {
    $('attachAnyway').onclick = async () => {
      $('attachAnyway').disabled = true;
      const c = await cfg();
      try {
        await openHandoff({ prompt: buildAttachPrompt(c, ticket, res.all), terminalId: res.termId });
      } catch (e) {
        $('out').innerHTML = `<span class="err">${esc(String(e.message || e))}</span>`;
      }
    };
  }
}

$('attachRun').onclick = async () => {
  if (!ticket || busy) return;
  const b = $('attachRun');
  b.disabled = true;
  $('foot').textContent = '';
  $('out').innerHTML = '<span class="wait">Listing attachments…</span>';
  try {
    const state = await attachmentState(ticket);
    if (!state.files.length) {
      $('out').innerHTML = '<span class="idle">No attachments on this ticket.</span>';
      return;
    }
    renderPickList(state);
  } catch (e) {
    $('out').innerHTML = `<span class="err">${esc(String(e.message || e))}</span>`;
  } finally {
    b.disabled = false;
  }
};

// Everything is ticked to start with. A ticket often carries one screenshot
// worth looking at and one 200 MB bundle that is not, so the point of the
// list is being able to take things off it before anything moves.
function renderPickList(state) {
  const rows = state.files.map(f => `
    <label class="pick-row">
      <input type="checkbox" data-doc="${escAttr(f.id)}" checked>
      <span class="pick-name">${esc(f.filename)}</span>
      ${f.size ? `<span class="pick-size">${fileSize(f.size)}</span>` : ''}
      ${f.sent ? '<span class="pick-tag">on terminal</span>' : ''}
    </label>`).join('');

  $('out').innerHTML = `
    <div class="pick">
      <h4>Attachments on ticket ${ticket}</h4>
      ${rows}
      <button class="pick-all" id="pickAll" type="button">Clear all</button>
      <div class="ghactions"><button class="run" id="pickGo">Analyse &rarr;</button></div>
    </div>`;

  const boxes = () => [...$('out').querySelectorAll('input[data-doc]')];
  const sync = () => {
    const n = boxes().filter(b => b.checked).length;
    $('pickGo').disabled = !n;
    $('pickGo').textContent = n ? `Analyse ${n} file${n === 1 ? '' : 's'} \u2192` : 'Nothing picked';
    $('pickAll').textContent = n ? 'Clear all' : 'Select all';
  };
  boxes().forEach(b => b.addEventListener('change', sync));
  $('pickAll').onclick = () => {
    const on = !boxes().some(b => b.checked);
    boxes().forEach(b => { b.checked = on; });
    sync();
  };
  $('pickGo').onclick = () => sendPicked(boxes().filter(b => b.checked).map(b => b.dataset.doc));
  sync();
}

async function sendPicked(picks) {
  if (busy) return;
  busy = true;
  $('attachRun').disabled = true;
  try {
    const res = await pushAttachments(ticket, picks, p => {
      // total is 0 when the server sends no length — show what has moved so
      // far and an indeterminate bar rather than a percentage we cannot know
      const pct = p.total ? Math.min(100, Math.round(p.loaded / p.total * 100)) : null;
      const verb = p.phase === 'up' ? 'Uploading' : 'Fetching';
      $('out').innerHTML = `
        <div class="prog">
          <div class="prog-line">
            <span class="prog-name">${verb} ${esc(p.name)}</span>
            <span class="prog-pct">${pct === null ? fileSize(p.loaded) : pct + '%'}</span>
          </div>
          <div class="prog-bar${pct === null ? ' indet' : ''}"><i style="width:${pct ?? 0}%"></i></div>
          <div class="prog-sub">File ${p.index} of ${p.of}${
            p.total ? ` · ${fileSize(p.loaded)} of ${fileSize(p.total)}` : ''}</div>
        </div>`;
    });

    $('foot').textContent =
      `${res.uploaded.length} sent · ${res.all.length} on the terminal` +
      (res.skipped.length ? ` · ${res.skipped.length} skipped` : '');

    if (res.skipped.length || !res.all.length) { renderAttachResult(res); return; }

    const c = await cfg();
    await openHandoff({ prompt: buildAttachPrompt(c, ticket, res.all), terminalId: res.termId });
  } catch (e) {
    $('out').innerHTML = `<span class="err">${esc(String(e.message || e))}</span>`;
    $('foot').textContent = '';
  } finally {
    busy = false;
    $('attachRun').disabled = false;
  }
}

/* ---- settings view ----------------------------------------------------
   Lives inside the panel (there is no popup). Reads/writes the same
   chrome.storage.local keys cwlib's cfg() merges over DEFAULTS.        */

const escAttr = s => String(s ?? '').replace(/[&"<]/g, c => ({ '&': '&amp;', '"': '&quot;', '<': '&lt;' }[c]));
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

function openSettings() {
  if (settingsOpen) return;
  settingsOpen = true;
  $('out').hidden = true;
  $('ticketLaneBtns').hidden = true;
  $('boardBtns').hidden = true;
  $('boardRun').hidden = true;
  $('tkBtns').hidden = true;
  $('openChat').hidden = true;
  $('attachRun').hidden = true;
  $('settingsView').hidden = false;
  $('settings').textContent = '← Done';
  $('cfgExport').hidden = false;
  $('cfgImport').hidden = false;
  $('num').textContent = 'Settings';
  setMeta();
  $('sum').textContent = '';
  $('foot').textContent = '';
  renderSettings();
}

async function closeSettings() {
  settingsOpen = false;
  $('settingsView').hidden = true;
  $('settingsView').innerHTML = '';
  $('out').hidden = false;
  $('settings').textContent = 'Settings';
  $('cfgExport').hidden = true;
  $('cfgImport').hidden = true;
  $('foot').style.color = '';
  lastKey = '';                          // force a fresh redraw
  setView(await currentView());
}

$('settings').onclick = e => {
  e.preventDefault();
  settingsOpen ? closeSettings() : openSettings();
};

/* --- export / import the whole config as a JSON file --- */

// handoffChats is runtime data (which Open WebUI chat belongs to which
// ticket, on this machine) — never exported/imported as a setting.
const RUNTIME_KEYS = ['clientId', 'handoffChats', 'sandboxUploads'];
const CONFIG_KEYS = Object.keys(DEFAULTS).filter(k => !RUNTIME_KEYS.includes(k));

// brief coloured note in the footer's left slot
function footMsg(kind, text) {
  const f = $('foot');
  f.textContent = (kind === 'ok' ? '✓ ' : kind === 'bad' ? '✕ ' : '') + text;
  f.style.color = kind === 'ok' ? 'var(--ok)' : kind === 'bad' ? 'var(--bad)' : '';
  clearTimeout(footMsg._t);
  footMsg._t = setTimeout(() => { f.textContent = ''; f.style.color = ''; }, 4000);
}

async function exportConfig() {
  const stored = await chrome.storage.local.get(CONFIG_KEYS);
  const settings = {};
  for (const k of CONFIG_KEYS) settings[k] = (k in stored) ? stored[k] : DEFAULTS[k];

  if (((settings.aiKey || '') + (settings.ghToken || '')).trim() &&
      !confirm('Include your model API key and GitHub token in the file?\n\n' +
               'OK — include them (keep the file private)\n' +
               'Cancel — export everything else')) {
    settings.aiKey = '';
    settings.ghToken = '';
  }

  const blob = new Blob([JSON.stringify(
    { _type: 'cw-assist-config', _version: 1, exported: new Date().toISOString(), settings },
    null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `cw-assist-config-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function importConfig(file) {
  let doc;
  try { doc = JSON.parse(await file.text()); }
  catch { footMsg('bad', 'not valid JSON'); return; }

  const src = (doc && typeof doc.settings === 'object' && doc.settings) ||
              (doc && typeof doc === 'object' && doc) || null;
  if (!src) { footMsg('bad', 'no settings found in file'); return; }

  const patch = {};
  for (const k of CONFIG_KEYS) {
    if (!(k in src)) continue;
    if (k === 'ghRepos') {
      if (Array.isArray(src[k])) {
        patch[k] = src[k].filter(r => r && typeof r === 'object')
          .map(r => ({ name: String(r.name || ''), repo: String(r.repo || '') }));
      }
    } else {
      patch[k] = String(src[k] ?? '');
    }
  }
  if (!Object.keys(patch).length) { footMsg('bad', 'nothing recognised in file'); return; }

  await chrome.storage.local.set(patch);
  await renderSettings();
  footMsg('ok', `imported ${Object.keys(patch).length} setting${Object.keys(patch).length === 1 ? '' : 's'}`);
}

$('cfgExport').onclick = e => { e.preventDefault(); exportConfig(); };
$('cfgImport').onclick = e => { e.preventDefault(); $('cfgFile').click(); };
$('cfgFile').onchange = e => {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';                    // allow re-picking the same file later
  if (file) importConfig(file);
};

/* --- repos sub-list --- */

let setRepos = [];

const saveSettingRepos = () =>
  chrome.storage.local.set({ ghRepos: setRepos.filter(r => r.name.trim() || r.repo.trim()) });

function drawSettingRepos() {
  const box = $('repoList');
  box.innerHTML = setRepos.length
    ? setRepos.map((r, i) => `
      <div class="repo-row" data-i="${i}">
        <input class="rn" placeholder="Name" value="${escAttr(r.name)}">
        <input class="ru" placeholder="owner/name or URL" value="${escAttr(r.repo)}">
        <button class="rx" title="remove" type="button">&times;</button>
      </div>`).join('')
    : '<div class="set-state">No repos yet — add one.</div>';
  box.querySelectorAll('.repo-row').forEach(row => {
    const i = +row.dataset.i;
    row.querySelector('.rn').onchange = e => { setRepos[i].name = e.target.value.trim(); saveSettingRepos(); };
    row.querySelector('.ru').onchange = e => { setRepos[i].repo = e.target.value.trim(); saveSettingRepos(); };
    row.querySelector('.rx').onclick  = () => { setRepos.splice(i, 1); saveSettingRepos(); drawSettingRepos(); };
  });
}

/* --- model connection test + host permission --- */

// paints a .set-state span: kind is 'ok' | 'bad' | 'warn' | '' (neutral)
function stateMsg(el, kind, text) {
  if (!el) return;
  el.className = 'set-state' + (kind ? ' ' + kind : '');
  const mark = kind === 'ok' ? '✓ ' : kind === 'bad' ? '✕ '
             : kind === 'warn' ? '⚠ ' : '';
  el.textContent = text ? mark + text : '';
}

const originPattern = base => { try { return new URL(base).origin + '/*'; } catch { return ''; } };

async function refreshPermState(base) {
  const pat = originPattern(base);
  const btn = $('setGrant'), st = $('setGrantState');
  if (!btn) return;
  if (!pat) { stateMsg(st, '', ''); btn.hidden = true; return; }
  let has = false;
  try { has = await chrome.permissions.contains({ origins: [pat] }); } catch {}
  btn.hidden = has;
  has ? stateMsg(st, 'ok', `access granted for ${pat}`)
      : stateMsg(st, 'warn', `${pat} — not granted yet`);
}

async function grantModelAccess() {
  const { aiBase } = await cfg();
  const pat = originPattern(aiBase);
  if (!pat) { stateMsg($('setGrantState'), 'warn', 'set a valid server URL first'); return; }
  try {
    const ok = await chrome.permissions.request({ origins: [pat] });
    await refreshPermState(aiBase);
    if (!ok) stateMsg($('setGrantState'), 'bad', 'denied');
  } catch (e) {
    stateMsg($('setGrantState'), 'bad', String(e.message || e));
  }
}

async function testModel() {
  const st = $('setTestState');
  stateMsg(st, '', 'testing…');
  const c = await cfg();
  if (!c.aiBase) { stateMsg(st, 'warn', 'set a server URL first'); return; }
  try {
    const r = await fetch(`${c.aiBase.replace(/\/+$/, '')}/models`,
      { headers: c.aiKey ? { Authorization: `Bearer ${c.aiKey}` } : {} });
    if (!r.ok) { stateMsg(st, 'bad', `HTTP ${r.status}`); return; }
    const j = await r.json();
    const names = (j.data || j.models || []).map(m => m.id || m.name).filter(Boolean);
    if (c.aiModel && names.includes(c.aiModel)) {
      stateMsg(st, 'ok', `reachable · ${c.aiModel} found`);
    } else {
      stateMsg(st, 'warn',
        `reachable · ${names.length} model(s), "${c.aiModel || '(none set)'}" not listed`);
    }
  } catch {
    stateMsg(st, 'bad', 'unreachable — grant access / accept the cert first');
  }
}

/* --- built-in prompt defaults, for the "Load built-in" buttons ---
   Everything the override path can fill comes back as a {{placeholder}} —
   ticket / company / repo (per run) and vendor / domain / extraRules
   (settings) — so a loaded-and-edited copy stays fully dynamic and nothing
   is frozen in.                                                          */

function builtinTemplate(name, c) {
  const cc = { ...c,
    vendorName: '{{vendor}}', domainFocus: '{{domain}}', boardExtraRules: '{{extraRules}}',
    promptSystem: '', promptSummary: '', promptStanding: '', promptBoard: '', promptIssue: '',
    promptAttach: '' };
  const V = { ticket: '{{ticket}}', company: '{{company}}' };
  switch (name) {
    case 'system'  : return buildSystem(cc);
    case 'summary' : return buildSummaryPrompt(cc, V);
    case 'standing': return buildStandingPrompt(cc, V);
    case 'board'   : return buildBoardPrompt(cc);
    case 'issue'   : return buildIssuePrompt(cc, V, '{{repo}}');
    case 'handoff' : return `fetch cw ticket {{ticket}}.
then work out what's going on — pull in similar past tickets if any help, plus anything else relevant, and tell me:
- next diagnostic step
- next useful thing to check, run, or ask`;
    case 'handoffFollowup': return `fetch cw ticket {{ticket}} for the latest updates from the customer and advise what the next steps should be.`;
    case 'attach'  : return buildAttachPrompt(cc, '{{ticket}}', '{{files}}');
  }
  return '';
}

const promptField = (name, label) => {
  const key = 'prompt' + cap(name);
  return `
    <div class="set-row">
      <label for="s_${key}">${label}</label>
      <textarea id="s_${key}" data-key="${key}" placeholder="blank = built-in default"></textarea>
      <div class="set-inline">
        <button class="tmpl-reset tmpl-load" data-tmpl="${name}" type="button">Load built-in</button>
        <button class="tmpl-reset tmpl-clear" data-key="${key}" type="button">Clear</button>
      </div>
    </div>`;
};

async function renderSettings() {
  const c = await cfg();
  const v = $('settingsView');

  v.innerHTML = `
    <div class="set-h">ConnectWise</div>
    <div class="set-row">
      <label for="s_cwOrigin">ConnectWise URL</label>
      <input id="s_cwOrigin" data-key="cwOrigin" placeholder="https://na.myconnectwise.net">
      <div class="hint">Auto-detected from the open ConnectWise tab. Override only for a non-cloud instance.</div>
    </div>
    <div class="set-row">
      <label for="s_cwApiVersion">API version segment</label>
      <input id="s_cwApiVersion" data-key="cwApiVersion" placeholder="v2025_1">
      <div class="hint">The <code>/vYYYY_R/apis/3.0</code> part of the REST path. Bump it after a ConnectWise release.</div>
    </div>
    <div class="set-state" id="setCwState"></div>

    <div class="set-h">Model — Open WebUI / OpenAI-compatible</div>
    <div class="set-row">
      <label for="s_aiBase">Server</label>
      <input id="s_aiBase" data-key="aiBase" placeholder="https://webui.example.com/api">
    </div>
    <div class="set-row">
      <label for="s_aiModel">Model</label>
      <input id="s_aiModel" data-key="aiModel" placeholder="my-model">
    </div>
    <div class="set-row">
      <label for="s_aiKey">API key</label>
      <input id="s_aiKey" data-key="aiKey" type="password" placeholder="sk-…">
    </div>
    <div class="set-row">
      <label for="s_aiTools">Tool ids (handoff only)</label>
      <input id="s_aiTools" data-key="aiTools" placeholder="connectwise">
      <div class="hint">Comma-separated Open WebUI tool ids switched on in chats opened by “Open in chat”.</div>
    </div>
    <div class="set-row">
      <label for="s_maxUploadMb">Attachment size limit (MB)</label>
      <input id="s_maxUploadMb" data-key="maxUploadMb" type="number" min="1" placeholder="500">
      <div class="hint">Anything larger is listed as skipped instead of being sent. Each file passes through
        this browser whole, so the cap is really a memory limit.</div>
    </div>
    <div class="set-inline">
      <button class="set-btn" id="setTest" type="button">Test connection</button>
      <span class="set-state" id="setTestState"></span>
    </div>
    <div class="set-inline">
      <button class="set-btn" id="setGrant" type="button" hidden>Grant access</button>
      <span class="set-state" id="setGrantState"></span>
    </div>

    <div class="set-h">Assistant</div>
    <div class="set-row">
      <label for="s_vendorName">Your team / company name</label>
      <input id="s_vendorName" data-key="vendorName" placeholder="e.g. Acme Support">
      <div class="hint">Labels your side of the thread and appears in the prompts. Blank = neutral wording (“our team”).</div>
    </div>
    <div class="set-row">
      <label for="s_domainFocus">Product / domain focus <span class="hint">(optional)</span></label>
      <input id="s_domainFocus" data-key="domainFocus" placeholder="e.g. Apache CloudStack">
      <div class="hint">Told to keep versions, config keys and log lines for this exact.</div>
    </div>
    <div class="set-row">
      <label for="s_boardExtraRules">Extra board-triage rules <span class="hint">(optional)</span></label>
      <textarea id="s_boardExtraRules" data-key="boardExtraRules" placeholder="e.g. Auto-close tickets in “Awaiting Customer” after 5 days. Ignore the Sandbox board."></textarea>
      <div class="hint">Appended verbatim to the board triage prompt.</div>
    </div>

    <div class="set-h">GitHub</div>
    <div class="set-row">
      <label>Repositories</label>
      <div id="repoList"></div>
      <div class="set-inline"><button class="set-btn" id="repoAdd" type="button">+ Add repo</button></div>
      <div class="hint">Name is free text; repo is <code>owner/name</code> or a github.com URL. These fill the picker on the GitHub tab.</div>
    </div>
    <div class="set-row">
      <label for="s_ghToken">GitHub token</label>
      <input id="s_ghToken" data-key="ghToken" type="password" placeholder="ghp_… / github_pat_…">
      <div class="hint">Personal access token with issue-write on the repos above.</div>
    </div>

    <details class="set-adv">
      <summary>Advanced</summary>
      <div class="set-row">
        <label for="s_cwAppId">ConnectWise app id</label>
        <input id="s_cwAppId" data-key="cwAppId" placeholder="bm-manageclient">
        <div class="hint">The <code>cw-app-id</code> header. Leave as-is unless your instance rejects it.</div>
      </div>
      <div class="hint" style="margin:10px 0 4px">
        Prompt overrides — leave blank to use the built-in default, which already
        reflects the fields above. Placeholders:
        <code>{{ticket}} {{company}} {{vendor}} {{domain}} {{repo}} {{extraRules}}</code>,
        plus <code>{{files}}</code> in the attachments prompt.
      </div>
      ${promptField('system',   'System prompt')}
      ${promptField('summary',  'Summary lane')}
      ${promptField('standing', 'Outstanding lane')}
      ${promptField('board',    'Board triage')}
      ${promptField('issue',    'GitHub issue draft')}
      ${promptField('handoff',         '“Open in chat” prompt — new chat')}
      ${promptField('handoffFollowup', '“Continue chat” prompt — chat already exists')}
      ${promptField('attach',          '“Log analysis” prompt — analyse what was sent')}
    </details>`;

  // generic bind for every [data-key] field
  v.querySelectorAll('[data-key]').forEach(el => {
    el.value = c[el.dataset.key] ?? '';
    el.addEventListener('change', () => {
      const val = el.value;                       // textareas keep leading indent
      chrome.storage.local.set({ [el.dataset.key]: el.tagName === 'TEXTAREA' ? val : val.trim() });
      if (el.dataset.key === 'aiBase') refreshPermState(el.value.trim());
    });
  });

  c.clientId
    ? stateMsg($('setCwState'), 'ok', 'ConnectWise access key stored.')
    : stateMsg($('setCwState'), 'bad', 'No access key yet — open or reload a ConnectWise tab once.');

  setRepos = (Array.isArray(c.ghRepos) ? c.ghRepos : []).map(r => ({ name: r.name || '', repo: r.repo || '' }));
  drawSettingRepos();
  $('repoAdd').onclick = () => {
    setRepos.push({ name: '', repo: '' });
    drawSettingRepos();
    $('repoList').querySelector('.repo-row:last-child .rn')?.focus();
  };

  $('setTest').onclick = testModel;
  $('setGrant').onclick = grantModelAccess;
  refreshPermState(c.aiBase);

  v.querySelectorAll('.tmpl-load').forEach(btn => {
    btn.onclick = async () => {
      const c2 = await cfg();
      const ta = v.querySelector(`textarea[data-key="prompt${cap(btn.dataset.tmpl)}"]`);
      ta.value = builtinTemplate(btn.dataset.tmpl, c2);
      chrome.storage.local.set({ [ta.dataset.key]: ta.value });
    };
  });
  v.querySelectorAll('.tmpl-clear').forEach(btn => {
    btn.onclick = () => {
      const ta = v.querySelector(`textarea[data-key="${btn.dataset.key}"]`);
      ta.value = '';
      chrome.storage.local.set({ [btn.dataset.key]: '' });
    };
  });
}
