const $ = id => document.getElementById(id);

let ticket = null;
let view = null;
let lastKey = '';
let busy = false;
let boardTab = 'latest';    // 'latest' | 'history' — a view, switching it never calls the model
let ticketLane = 'summary'; // 'summary' | 'standing' — which question, matches ask()'s PROMPTS keys

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
    $('meta').textContent = '';
    return;
  }
  const h = hist[0];
  $('out').innerHTML = render(h.text || '(empty response)');
  $('foot').textContent = `${h.noteCount} open tickets`;
  $('meta').textContent = `(As of ${fmtWhen(h.ts)})`;
}

async function renderBoardHistoryTab() {
  const hist = await loadHistory();
  $('out').innerHTML = renderHistoryList(hist, { unit: 'open tickets', csv: true });
  $('foot').textContent = hist.length ? `${hist.length} saved run${hist.length === 1 ? '' : 's'}` : '';
  $('meta').textContent = '';
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
    $('meta').textContent = '';
    return;
  }
  $('out').innerHTML = render(h.text || '(empty response)');
  $('sum').textContent = [h.company, h.summary].filter(Boolean).join(' · ');
  $('foot').textContent = `${h.noteCount ?? '?'} notes`;
  $('meta').textContent = `(As of ${fmtWhen(h.ts)})`;
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
  $('meta').textContent = '';
  $('foot').textContent = '';

  const repos = await loadRepos();
  if (!repos.length) {
    $('out').innerHTML =
      '<p class="idle">No GitHub repos configured yet — add one in <a href="#" id="toSettings">settings</a>.</p>';
    $('toSettings').onclick = e => { e.preventDefault(); chrome.runtime.openOptionsPage(); };
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

async function currentView() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab || !/eu\.myconnectwise\.net/.test(tab.url || '')) return { view: null, ticket: null };
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
  $('openChat').hidden       = !onTicket;
  $('boardBtns').hidden      = !onBoard;
  $('boardRun').hidden       = !onBoard;

  $('num').textContent = onTicket ? ticket : (onBoard ? 'Board' : '—');
  $('meta').textContent = '';
  $('sum').textContent = '';
  $('foot').textContent = '';

  refreshGhIssueTab();         // tab label shows if this ticket already has a draft

  if (onBoard) {
    showBoardTab('latest');    // free — just redisplays the last saved run, if any
  } else if (onTicket) {
    showTicketLane('summary'); // reset to a sane default for the newly opened ticket
  } else {
    $('out').innerHTML = '<span class="idle">Open the service board or a ticket in ConnectWise.</span>';
  }
}

(async () => setView(await currentView()))();
setInterval(async () => { if (!busy) setView(await currentView()); }, 1500);

// the content script also pushes changes as they happen
chrome.runtime.onMessage.addListener(msg => {
  if (msg && 'onTicket' in msg && !busy) setView({ view: msg.view, ticket: msg.onTicket });
});

/* ---- rendering ------------------------------------------------------ */

const esc = s => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

function table(block) {
  const rows = block.split('\n').filter(l => l.trim().startsWith('|'));
  if (rows.length < 2 || !/^\s*\|[\s:|-]+\|\s*$/.test(rows[1])) return null;

  const head = tableCells(rows[0]).map(capHead);
  const body = rows.slice(2).map(tableCells);

  // inside a cell there is no room for headings, so let a bold label like
  // "Blocked on:" start its own line rather than running on from the prose
  const inline = t => esc(t)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*(.+?)\*\*/g, (m, g) =>
      /:$/.test(g.trim()) ? `<span class="lbl">${g}</span>` : `<strong>${g}</strong>`)
    .replace(/(<\/code>|\.|\))\s*(<span class="lbl">)/g, '$1<br>$2');

  return `<table><thead><tr>${head.map(h => `<th>${inline(h)}</th>`).join('')}</tr></thead>` +
    `<tbody>${body.map(r => `<tr>${r.map(c => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
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
    $('meta').textContent = `(As of ${fmtWhen(ts)})`;

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
    const res = await askIssue(ticket);
    clearInterval(tick);
    const entry = {
      ts: Date.now(),
      repo: repo || lastRepoChoice || '',
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
  $('meta').textContent = created ? `issue #${created.number} created` : 'issue draft';
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
      $('meta').textContent = `issue #${number} created`;
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
    $('meta').textContent = `(As of ${fmtWhen(ts)})`;

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

$('openChat').onclick = async () => {
  if (!ticket) return;
  const b = $('openChat');
  b.disabled = true;
  try {
    await chrome.tabs.create({ url: await handoff(ticket) });
    window.close();
  } catch (e) {
    b.disabled = false;
    $('out').innerHTML = `<span class="err">${esc(String(e.message || e))}</span>`;
  }
};

$('settings').onclick = e => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
};
