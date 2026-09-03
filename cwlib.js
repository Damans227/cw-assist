/* Shared ConnectWise + model access.

   Loaded by the side panel rather than the service worker: a worker
   cannot use the certificate exception you grant in a tab, so a
   self-signed model server is unreachable from there. Extension pages
   can, which is why the settings "test connection" works and the
   worker's identical request does not.                               */

const COND = 'detailDescriptionFlag=true or internalAnalysisFlag=true or resolutionFlag=true';

const DEFAULTS = {
  clientId: '',

  /* ---- ConnectWise instance ---- */
  cwOrigin    : '',            // e.g. https://na.myconnectwise.net — auto-filled
                               // from the open ConnectWise tab when left blank
  cwApiVersion: 'v2025_1',     // the /vXXXX_Y/apis/3.0 path segment
  cwAppId     : 'bm-manageclient',

  /* ---- model: Open WebUI / any OpenAI-compatible /chat/completions ---- */
  aiBase : '',                 // e.g. https://webui.example.com/api
  aiKey  : '',
  aiModel: '',
  aiTools: '',                 // comma-separated Open WebUI tool ids for handoff
  maxUploadMb: 500,            // per-file cap when pushing attachments to the sandbox

  /* ---- how the assistant frames the work ---- */
  vendorName     : '',         // your team / company; blank => "our team"
  domainFocus    : '',         // optional product focus, e.g. "Apache CloudStack"
  boardExtraRules: '',         // freeform, appended to the board triage prompt

  /* ---- optional raw prompt overrides (blank => built-in default).
     Placeholders: {{ticket}} {{company}} {{vendor}} {{domain}} {{repo}}
                   {{extraRules}}                                      ---- */
  promptSystem  : '',
  promptSummary : '',
  promptStanding: '',
  promptBoard   : '',
  promptIssue   : '',
  promptHandoff        : '',   // first "Open in chat" for a ticket — full diagnosis
  promptHandoffFollowup: '',   // later clicks, once a chat already exists — catch-up
  promptAttach         : '',   // "Attachments" — analyse what was pushed to the sandbox

  /* ---- GitHub issue lane ---- */
  ghRepos: [],                 // [{ name, repo }] — repo is "owner/name" or a URL
  ghToken: '',

  /* ---- "Open in chat" reuses the same Open WebUI chat per ticket instead of
     spawning a new one every click. background.js fills this in once it
     spots the chat id Open WebUI assigns after the first message. ---- */
  handoffChats: {},            // { "<cwOrigin>|<ticketId>": "<chatId>" }

  /* ---- which ticket attachments already sit in the model's terminal sandbox,
     so a second "Attachments" click only pushes what is new. Keyed by the
     ConnectWise document id, which is stable across renames. ---- */
  sandboxUploads: {},          // { "<key>": { "<docId>": { name, path, size, at } } }

  /* Last attachment listing per ticket, so the Logs lane can paint the names
     you saw before instead of an empty pane while ConnectWise answers. */
  attachLists: {}              // { "<key>": { at, files: [{ id, filename, sent, name, path, size }] } }
};

// Same key shape used by background.js when it records a newly-created chat —
// keep the two in sync if this ever changes.
const handoffKey = (cwOrigin, ticketId) => `${cwOrigin || ''}|${ticketId}`;

const cfg = async () => ({ ...DEFAULTS, ...(await chrome.storage.local.get(DEFAULTS)) });

// origin + REST base, resolved per call so a settings change takes effect at once
async function cwUrls() {
  const c = await cfg();
  const origin = (c.cwOrigin || '').trim().replace(/\/+$/, '') || 'https://na.myconnectwise.net';
  const ver = (c.cwApiVersion || '').trim() || 'v2025_1';
  return { origin, rest: `${origin}/${ver}/apis/3.0` };
}

// blank => neutral wording; a name => branded wording
const vendorProse = c => (c.vendorName || '').trim() || 'our team';
const vendorTag   = c => (c.vendorName || '').trim() || 'Us';

// fills {{placeholders}} in a user-supplied override string; an unknown
// placeholder collapses to '' rather than being left in the text
const fillTemplate = (tpl, vars) =>
  String(tpl).replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] ?? '').toString());

// the full placeholder set every prompt override understands. Per-run values
// (ticket / company / repo) are passed in `extra`; the rest come from settings.
function promptVars(c, extra = {}) {
  return {
    vendor    : vendorProse(c),
    domain    : (c.domainFocus || '').trim(),
    extraRules: (c.boardExtraRules || '').trim(),
    ticket: '', company: '', repo: '', files: '',
    ...extra
  };
}

/* ---- ConnectWise -------------------------------------------------- */

async function apiFetch(path, init = {}) {
  const { clientId, cwAppId } = await cfg();
  const { rest } = await cwUrls();
  const r = await fetch(`${rest}${path}`, {
    ...init,
    credentials: 'include',
    headers: {
      'cw-app-id': (cwAppId || 'bm-manageclient'),
      ...(clientId ? { clientId } : {}),
      ...(init.headers || {})
    }
  });
  if (r.status === 401 || r.status === 403) {
    throw new Error('ConnectWise rejected the request — reload a ConnectWise tab so the access key can be picked up.');
  }
  if (!r.ok) throw new Error(`ConnectWise returned HTTP ${r.status}`);
  return r;
}

const api = async path => (await apiFetch(path)).json();

async function notes(id) {
  const out = [];
  for (let page = 1; page <= 20; page++) {
    const qs = `?format=markdown&conditions=${encodeURIComponent(COND)}` +
               `&pageSize=100&page=${page}&orderby=${encodeURIComponent('sortByDate asc')}`;
    const batch = await api(`/service/tickets/${id}/allNotes${qs}`);
    out.push(...batch);
    if (batch.length < 100) break;
  }
  return out.map(n => {
    const types = [];
    if (n.detailDescriptionFlag) types.push('discussion');
    if (n.internalAnalysisFlag)  types.push('internal');
    if (n.resolutionFlag)        types.push('resolution');
    return {
      when: n._info?.dateEntered || null,
      by  : n.member?.name || n.contact?.name || n._info?.enteredBy || 'unknown',
      // 'vendor' = a ConnectWise member (your side); 'customer' = a contact.
      // The display label comes from vendorName at prompt-build time.
      side: n.member ? 'vendor' : 'customer',
      type: types.join('+') || 'note',
      text: n.text || ''
    };
  })
  // order by when it was written, not by the time entry logged against it
  .sort((a, b) => new Date(a.when || 0) - new Date(b.when || 0))
  .map((n, i) => ({ seq: i + 1, ...n }));
}

// Just who sent the most recent qualifying note — one API call, descending,
// pageSize=1. notes() reads the whole thread and doesn't scale to polling
// every open ticket on a timer; this is the cheap version for that, with no
// LLM involved at all. Returns null for a ticket with no notes yet (a fresh,
// untouched ticket — which still counts as waiting on us, just like 'customer'
// does, since nobody has responded).
async function lastNoteSide(id) {
  const qs = `?format=markdown&conditions=${encodeURIComponent(COND)}` +
             `&pageSize=1&page=1&orderby=${encodeURIComponent('sortByDate desc')}`;
  const [n] = await api(`/service/tickets/${id}/allNotes${qs}`);
  return n ? (n.member ? 'vendor' : 'customer') : null;
}

/* ---- prompts ------------------------------------------------------
   Each builder returns the user's override (with placeholders filled)
   when set, otherwise a de-branded default shaped by vendorName /
   domainFocus / boardExtraRules.                                    */

function buildSystem(c) {
  const v = vendorProse(c);
  const domain = (c.domainFocus || '').trim();
  if ((c.promptSystem || '').trim()) {
    return fillTemplate(c.promptSystem, promptVars(c));
  }
  return `You are helping ${v === 'our team' ? 'a support consultant' : `a support consultant at ${v}`} work a ConnectWise ticket.

Rules:
- Be concise. Short paragraphs or bullets, no preamble, no sign-off.
- Only use what is in the thread. If something is not there, say so rather than guessing.
- Notes marked "internal" are ${v === 'our team' ? 'for internal use only' : `${v}-only`}. Use them
  for context but never phrase anything as if the customer has seen them.${domain ? `
- Keep ${domain} specifics exact: versions, config keys, API names, log lines.` : ''}
- Do not restate the whole thread back.

You have no tools available here. The complete ticket thread is already included
in this message — everything you need is in front of you. Do not call any
function, and never emit tool-call syntax. Just answer from what is here.`;
}

function buildSummaryPrompt(c, t) {
  const vars = promptVars(c, { ticket: t.ticket, company: t.company || 'unknown company' });
  if ((c.promptSummary || '').trim()) return fillTemplate(c.promptSummary, vars);
  return `Summarise ticket ${vars.ticket} (${vars.company}).

Use exactly these three headings, each on its own line, written as markdown H3:

### What it is about
One or two sentences.

### The exchange
What we asked, what they gave us, what we found. Only the turns that moved things
forward — skip acknowledgements and chasing. Bullets are fine here.

### Where it stands
Whose move it is right now, and what is blocking.

Nothing before the first heading and nothing after the last.`;
}

function buildStandingPrompt(c, t) {
  const vars = promptVars(c, { ticket: t.ticket, company: t.company || 'unknown company' });
  if ((c.promptStanding || '').trim()) return fillTemplate(c.promptStanding, vars);
  return `For ticket ${vars.ticket}, work out what is actually outstanding.

Use exactly these headings, each on its own line, written as markdown H3. Skip any
heading that has nothing under it rather than writing "none".

### Whose move
Who it is waiting on and since when.

### We owe
Anything we promised or said we would do with no follow-through in a later note.
This matters most — a ticket can look healthy because we replied last while the
reply committed us to something that never happened. Say how many days it has been.

### Unanswered
Any question from the customer nobody came back on.

### They owe
What we are waiting on from them.

Nothing before the first heading and nothing after the last. If nothing is
outstanding on our side, say so plainly under "We owe".`;
}

function buildBoardPrompt(c) {
  const extra = (c.boardExtraRules || '').trim();
  const domain = (c.domainFocus || '').trim();
  if ((c.promptBoard || '').trim()) {
    return fillTemplate(c.promptBoard, promptVars(c));
  }
  return `Produce a triage table for these open tickets.

A markdown table, one row per ticket, columns exactly:
Ticket | Company | Where things stand | Whose move

Sort by ticket number, highest first. Do not reorder by urgency or age.

"where things stand" is the whole point of this table — it is the only thing the
board itself cannot show. Two or three sentences per ticket covering:
- what the problem actually is: the real ${domain ? domain + ' ' : ''}error or symptom,
  not a restatement of the subject line
- how far the diagnosis has got — what has been ruled in or out, what was tried
- what it is blocked on right now, and who has to move

Say the specifics. Include error strings, versions, identifiers and ticket numbers
where they matter. Give the elapsed days whenever a ticket has been quiet more
than a few days.

Call out a broken promise inside that same column, in the same prose: if our own
last note commits us to doing something (sending documentation, a link, a build,
a fix, an email, a call) and there has been silence since, say so and give the
elapsed days. The absence of any later note is the evidence — there will not be
one saying we failed to deliver.

"Whose move" is a status ConnectWise itself cannot show reliably, especially on
Instant Guru tickets. Exactly one of these three values, nothing else: \`Us\`,
\`Customer\`, or \`Third party\` (vendor, upstream, internal team).

Decide it mechanically from who sent the LAST note, not from who ultimately
owns the underlying question — those are different things:
- Last note is ours, and it asks the customer something or asks them to do
  something (even just "can you confirm / try / clarify …"): \`Customer\`. We
  moved; now we are waiting on their reply. This is true even if our note
  is part of working toward something we still owe overall — the immediate
  next action is theirs, to answer us.
- Last note is ours, and it does not ask them anything — it only promises
  future work, states we are looking into it, or goes unanswered while we
  owe a deliverable: \`Us\`.
- Last note is ours, and it is a closing or handback statement — we answered
  in full, resolved the question, or told them what to do next (even without
  a literal question mark: "let us know if it recurs", "open a new ticket if
  you need more help") — with nothing left owed on our side: \`Customer\`.
  Not asking a question does not by itself make it \`Us\`; only an actual
  unpaid promise or an unanswered debt does.
- Last note is the customer's, and it asks or tells us something: \`Us\`.
- Last note is the customer's, and it is a bare acknowledgement with nothing
  for us to act on ("thanks", "got it"): \`Customer\` — nothing pending.
- Last note is from a third party (vendor, upstream): \`Third party\`.

Do not put \`Us\` on a ticket just because we asked the customer a question and
they have not answered — that is the normal state of a support ticket, and the
rule above already resolves it to \`Customer\`. This column is read by the
tool, not printed for a reader — keep it to exactly one of the three values.
${extra ? `\n${extra}\n` : ''}
After the table, one line naming the one or two to do first, and why.`;
}

function buildIssuePrompt(c, t, repoName) {
  const repo = (repoName || '').trim() || 'this project';
  const domain = (c.domainFocus || '').trim();
  const vars = promptVars(c, { ticket: t.ticket, company: t.company || 'unknown company', repo });
  if ((c.promptIssue || '').trim()) return fillTemplate(c.promptIssue, vars);
  return `From ticket ${vars.ticket} (${vars.company}), draft a GitHub issue for ${repo}.

Write it for ${repo} maintainers who cannot see this support ticket. Do not
mention the customer, the ticket, ${vendorProse(c)}, or that it came from a
support case. Describe only the technical problem or request.

The very first line must be exactly:
TITLE: <a specific one-line summary of the bug or feature request>

Then a blank line, then the issue body as markdown using these sections. Drop any
section you genuinely have nothing for rather than writing "N/A":

### Problem / feature
What is wrong, or what is being asked for.

### Environment
${domain ? domain + ' version, ' : 'Version, '}platform, configuration — whatever the thread gives.

### Steps to reproduce
Numbered, only if the thread supports them.

### Expected vs actual

### Logs / evidence
The relevant log lines, stack traces or error strings from the thread, in a code
block, exact. No paraphrasing.

Only use what is in the thread. Do not invent versions, config keys or log lines.`;
}

/* ---- board ------------------------------------------------------------ */

async function boardRows() {
  const fields = ['id','summary','status/name','company/name','board/name',
                  '_info/lastUpdated'].join(',');
  const out = [];
  for (let page = 1; page <= 5; page++) {
    const batch = await api(`/service/tickets?conditions=${encodeURIComponent('closedFlag=false')}` +
      `&fields=${fields}&pageSize=100&page=${page}&orderBy=id desc`);
    out.push(...batch);
    if (batch.length < 100) break;
  }
  return out;
}

// One condensed line per ticket rather than whole threads — 20+ full threads
// will not fit in context, and the table only needs the last exchange anyway.
async function boardDigest(onProgress, vendorLabel) {
  const rows = await boardRows();
  const open = rows.filter(t => !/resolved|closed/i.test(t.status?.name || ''));
  const now = Date.now();
  const lines = [];
  const sideLabel = s => (s === 'vendor' ? vendorLabel : s || '?');

  for (let i = 0; i < open.length; i++) {
    const t = open[i];
    onProgress?.(i + 1, open.length);
    let ns = [];
    try { ns = await notes(t.id); } catch { /* keep going */ }

    const last = ns[ns.length - 1];
    const days = last?.when ? ((now - new Date(last.when)) / 864e5).toFixed(1) : '?';
    const body = (last?.text || '').replace(/\s+/g, ' ').slice(0, 1200);

    // the note before last too — a promise with no follow-through is only
    // visible by comparing the last two turns
    const prev = ns[ns.length - 2];
    const prevBody = prev ? (prev.text || '').replace(/\s+/g, ' ').slice(0, 800) : '';

    lines.push(
      `### ${t.id} | ${t.company?.name || '?'} | ${t.board?.name || '?'} | status: ${t.status?.name || '?'}\n` +
      `subject: ${t.summary || ''}\n` +
      `notes: ${ns.length} | last: ${last?.by || '?'} (${sideLabel(last?.side)}) ${days} days ago\n` +
      (prev ? `previous note (${prev.by}, ${sideLabel(prev.side)}): ${prevBody}\n` : '') +
      `last note: ${body}`);
  }
  return { count: open.length, text: lines.join('\n\n') };
}

async function askBoard(onProgress) {
  const c = await cfg();
  if (!c.aiKey) throw new Error('No API key set — open settings and add it.');
  if (!c.aiBase) throw new Error('No model server set — open settings and add it.');

  const { count, text } = await boardDigest(onProgress, vendorTag(c));
  if (!count) throw new Error('No open tickets found');
  onProgress?.(count, count);      // fetching done, model call starts now

  const out = await chat(c.aiKey, c.aiBase, c.aiModel, buildSystem(c),
    `${count} open tickets.\n\n${text}\n\n=====\n\n${buildBoardPrompt(c)}`);
  return { text: out, noteCount: count };
}

const threadForModel = (rec, vendorLabel = 'Us') => [
  `Ticket ${rec.ticket}: ${rec.summary || ''}`,
  `Company: ${rec.company || '?'}   Contact: ${rec.contact || '?'}`,
  `Board: ${rec.board || '?'}   Status: ${rec.status || '?'}`,
  `Opened: ${rec.entered || '?'}`,
  '',
  ...(rec.notes || []).map(n =>
    `--- note ${n.seq} | ${n.by} (${n.side === 'vendor' ? vendorLabel : n.side})` +
    `${n.type !== 'discussion' ? ' [' + n.type + ']' : ''} | ${n.when || '?'}\n` +
    (n.text || '').trim())
].join('\n');

/* ---- the call --------------------------------------------------------- */

async function ticketRecord(ticketId) {
  const [t] = await api(
    `/service/tickets?conditions=${encodeURIComponent(`id=${ticketId}`)}` +
    `&fields=id,summary,company/name,contact/name,board/name,status/name,_info/dateEntered`);

  return {
    ticket : ticketId,
    summary: t?.summary,
    company: t?.company?.name,
    contact: t?.contact?.name,
    board  : t?.board?.name,
    status : t?.status?.name,
    entered: t?._info?.dateEntered,
    notes  : await notes(ticketId)
  };
}

const LANE_PROMPT = {
  summary : buildSummaryPrompt,
  standing: buildStandingPrompt
};

async function ask(action, ticketId) {
  const c = await cfg();
  if (!c.aiKey) throw new Error('No API key set — open settings and add it.');
  if (!c.aiBase) throw new Error('No model server set — open settings and add it.');
  if (!LANE_PROMPT[action]) throw new Error(`Unknown action: ${action}`);

  const rec = await ticketRecord(ticketId);
  if (!rec.notes.length) throw new Error('No notes on this ticket');

  return { text: await chat(c.aiKey, c.aiBase, c.aiModel, buildSystem(c),
             `${threadForModel(rec, vendorTag(c))}\n\n=====\n\n${LANE_PROMPT[action](c, rec)}`),
           noteCount: rec.notes.length, company: rec.company, summary: rec.summary };
}

/* ---- GitHub issue draft + create ------------------------------------ */

// Splits the model's reply into { title, body }. It is asked for a leading
// "TITLE: ..." line; fall back to the first non-empty line if it strays.
function splitIssueDraft(text) {
  const s = (text || '').trim();
  const m = s.match(/^\s*#{0,4}\s*TITLE:\s*(.+?)\s*(?:\n+([\s\S]*))?$/i);
  if (m) return { title: m[1].trim(), body: (m[2] || '').trim() };
  const lines = s.split('\n');
  const title = (lines.shift() || 'New issue').replace(/^#{1,4}\s*/, '').trim();
  return { title, body: lines.join('\n').trim() };
}

async function askIssue(ticketId, repoName) {
  const c = await cfg();
  if (!c.aiKey) throw new Error('No API key set — open settings and add it.');
  if (!c.aiBase) throw new Error('No model server set — open settings and add it.');

  const rec = await ticketRecord(ticketId);
  if (!rec.notes.length) throw new Error('No notes on this ticket');

  const text = await chat(c.aiKey, c.aiBase, c.aiModel, buildSystem(c),
    `${threadForModel(rec, vendorTag(c))}\n\n=====\n\n${buildIssuePrompt(c, rec, repoName)}`);

  return { ...splitIssueDraft(text), noteCount: rec.notes.length,
           company: rec.company, summary: rec.summary };
}

// accepts "owner/name" or any github.com URL, returns "owner/name" or ''
function normalizeRepo(s) {
  s = (s || '').trim();
  const url = s.match(/github\.com[/:]([^/\s]+\/[^/\s#?]+?)(?:\.git)?(?:[/#?].*)?$/i);
  if (url) return url[1];
  return /^[^/\s]+\/[^/\s]+$/.test(s) ? s : '';
}

async function createGithubIssue({ repo, title, body }) {
  const { ghToken } = await cfg();
  const slug = normalizeRepo(repo);
  if (!ghToken) throw new Error('No GitHub token set — open settings and add a personal access token.');
  if (!slug) throw new Error('Pick a repository first (or fix its owner/name in settings).');

  let r;
  try {
    r = await fetch(`https://api.github.com/repos/${slug}/issues`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ghToken}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28'
      },
      body: JSON.stringify({ title, body })
    });
  } catch (e) {
    throw new Error(`Could not reach api.github.com — ${String(e.message || e)}`);
  }

  if (r.status === 401) throw new Error('GitHub rejected the token (401).');
  if (r.status === 403) throw new Error('GitHub refused (403) — the token lacks issue-write on this repo.');
  if (r.status === 404) throw new Error(`Repo ${slug} not found, or the token cannot see it.`);
  if (r.status === 410) throw new Error(`Issues are disabled on ${slug}.`);
  if (!r.ok) throw new Error(`GitHub returned HTTP ${r.status}`);

  const j = await r.json();
  return { number: j.number, url: j.html_url };
}

async function chat(aiKey, aiBase, aiModel, system, userContent) {
  let r;
  try {
    r = await fetch(`${aiBase.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${aiKey}` },
      body: JSON.stringify({
        model: aiModel,
        stream: false,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: userContent }
        ]
      })
    });
  } catch (e) {
    throw new Error(/Failed to fetch/i.test(String(e.message))
      ? `Could not reach ${aiBase}. Open it in a tab once and accept the certificate, or grant access in settings.`
      : String(e.message || e));
  }

  if (!r.ok) throw new Error(`Model returned HTTP ${r.status}`);
  const j = await r.json();
  const text = j?.choices?.[0]?.message?.content;
  if (!text) throw new Error('Model gave an empty response');
  return text;
}

/* ---- ticket attachments -> the model's terminal sandbox ---------------

   Open WebUI's terminal is a real filesystem the model can read, extract
   and grep. Anything pushed there is usable whatever it is — a log, a
   screenshot, a support bundle — which a chat attachment is not: that path
   text-extracts, so a .tar.gz arrives as nothing.

   The bytes go ConnectWise -> this page -> the sandbox. Nothing is written
   to disk, but a file is held whole in memory on the way through, which is
   what maxUploadMb is really capping.                                    */

// Every real attachment on a ticket. ConnectWise files its own copy of each
// notification email as a .eml against the ticket, and there are usually
// more of those than actual files, so they never make the list.
async function documents(ticketId) {
  const docs = await api(`/service/tickets/${ticketId}/documents?pageSize=500`);
  return docs
    .map(d => ({ id: d.id, filename: d._info?.filename || d.title || `document-${d.id}` }))
    .filter(d => !/\.eml$/i.test(d.filename));
}

// The name this file gets in the sandbox. ConnectWise filenames routinely
// carry spaces and non-ASCII ("Captura de pantalla 2026-08-13 092810.png"),
// which the model then has to quote correctly every time it shells out —
// so flatten to something a command line cannot trip over.
const safeName = s =>
  String(s).replace(/[^\w.\-]+/g, '_').replace(/_+/g, '_').replace(/^[._]+/, '').slice(-120) || 'file';

// Read in chunks rather than one await on .blob(). A support bundle takes
// long enough that a caller with nothing to show looks hung, and since
// ConnectWise sends these chunked with no Content-Length, counting bytes as
// they arrive is also the only way the cap can bite — the read is abandoned
// the moment it goes over. Returns { size } and no blob when it was too big.
async function documentBytes(docId, cap, onProgress) {
  const r = await apiFetch(`/system/documents/${docId}/download`);
  const declared = Number(r.headers.get('content-length')) || 0;
  if (declared > cap) { r.body?.cancel?.(); return { size: declared }; }

  if (!r.body?.getReader) {                       // no streams — take it whole
    const blob = await r.blob();
    return blob.size > cap ? { size: blob.size } : { blob, size: blob.size };
  }

  const reader = r.body.getReader();
  const parts = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    loaded += value.length;
    if (loaded > cap) { reader.cancel(); return { size: loaded }; }
    parts.push(value);
    onProgress?.(loaded, declared);
  }
  return { blob: new Blob(parts), size: loaded };
}

/* ---- the sandbox side (Open WebUI's own API, not OpenAI-compatible) --- */

// aiBase already ends in /api — these routes hang off it
const aiRoot = c => (c.aiBase || '').trim().replace(/\/+$/, '');

async function aiFetch(c, path, init = {}) {
  const r = await fetch(`${aiRoot(c)}${path}`, {
    ...init,
    headers: { ...(c.aiKey ? { Authorization: `Bearer ${c.aiKey}` } : {}), ...(init.headers || {}) }
  });
  if (!r.ok) throw new Error(`${path.split('?')[0]} returned HTTP ${r.status}`);
  return r;
}

// The terminal id and the home directory are both discovered, never assumed:
// a list with no `directory` answers with the home path it defaulted to.
async function sandbox(c) {
  const list = await (await aiFetch(c, '/v1/terminals/')).json();
  if (!Array.isArray(list) || !list.length) {
    throw new Error('No terminal on the model server — open a chat there and switch the terminal on once.');
  }
  const id = list[0].id;
  const { dir } = await (await aiFetch(c, `/v1/terminals/${id}/files/list`)).json();
  return { id, home: (dir || '').replace(/\/+$/, '') };
}

// XHR rather than fetch: fetch cannot report how far an upload has got, and
// on a bundle that is most of the wait. Content-Type is left unset either
// way — the multipart boundary is the browser's to write.
function sandboxUpload(c, termId, dir, filename, blob, onProgress) {
  const body = new FormData();
  body.append('file', blob, filename);
  const url = `${aiRoot(c)}/v1/terminals/${termId}/files/upload?directory=${encodeURIComponent(dir)}`;

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    if (c.aiKey) xhr.setRequestHeader('Authorization', `Bearer ${c.aiKey}`);
    xhr.upload.onprogress = e => onProgress?.(e.loaded, e.lengthComputable ? e.total : 0);
    xhr.onload = () => {
      if (xhr.status < 200 || xhr.status >= 300) return reject(new Error(`upload returned HTTP ${xhr.status}`));
      try { resolve(JSON.parse(xhr.responseText).path); }
      catch { reject(new Error('upload gave back no path')); }
    };
    xhr.onerror = () => reject(new Error('upload failed — could not reach the model server'));
    xhr.send(body);
  });
}

/* What this ticket has, and which of it the sandbox is already holding.
   Read on its own so the panel can show a pick list before anything moves. */
async function attachmentState(ticketId) {
  const c = await cfg();
  const key = handoffKey(c.cwOrigin, ticketId);
  const already = { ...((c.sandboxUploads || {})[key] || {}) };

  const docs = await documents(ticketId);
  const { id: termId, home } = await sandbox(c);
  const dir = `${home}/cw-${ticketId}/`;            // created by the upload itself

  // The sandbox is not permanent — it gets reset, and files can be deleted
  // from the Files pane. A record of something that is no longer there would
  // put a dead path in the prompt and send the model hunting for it, so the
  // directory listing is the authority, not what we wrote down last time.
  let onDisk = new Set();
  try {
    const { entries } = await (await aiFetch(c,
      `/v1/terminals/${termId}/files/list?directory=${encodeURIComponent(dir)}`)).json();
    onDisk = new Set((entries || []).map(e => e.name));
  } catch { /* no such directory yet */ }

  let pruned = false;
  for (const [id, rec] of Object.entries(already)) {
    if (!onDisk.has(rec.name)) { delete already[id]; pruned = true; }
  }
  if (pruned) {
    await chrome.storage.local.set({ sandboxUploads: { ...(c.sandboxUploads || {}), [key]: already } });
  }

  /* Unsent files carry no size. ConnectWise answers HEAD with 405 and sends
     every download chunked with no Content-Length, so the only way to learn
     a file's size is to pull the whole thing — which is the transfer you are
     trying to decide about. Files already on the terminal do have one; it
     was counted on the way through.                                       */
  const files = docs.map(d => ({ ...d, sent: !!already[d.id], ...(already[d.id] || {}) }));

  const { attachLists = {} } = await chrome.storage.local.get('attachLists');
  await chrome.storage.local.set({ attachLists: { ...attachLists, [key]: { at: Date.now(), files } } });

  return { termId, dir, key, already, files };
}

/* Sends the picked attachments the sandbox has not already got. `picks` is
   a list of ConnectWise document ids; anything already there is left alone
   but still comes back in `all`, which is what the prompt names.          */
// What the Logs lane paints before the network answers: whatever the last
// listing found. Null when this ticket has never been opened there.
async function cachedAttachments(ticketId) {
  const c = await cfg();
  return (c.attachLists || {})[handoffKey(c.cwOrigin, ticketId)] || null;
}

async function pushAttachments(ticketId, picks, onProgress) {
  const c = await cfg();
  const cap = Math.max(1, Number(c.maxUploadMb) || 500) * 1024 * 1024;
  const { termId, dir, key, already, files } = await attachmentState(ticketId);

  const wanted = new Set((picks || files.map(f => f.id)).map(String));
  const chosen = files.filter(f => wanted.has(String(f.id)));
  const fresh = chosen.filter(f => !already[f.id]);
  const uploaded = [], skipped = [];

  for (let i = 0; i < fresh.length; i++) {
    const d = fresh[i];
    const step = phase => (loaded, total) =>
      onProgress?.({ index: i + 1, of: fresh.length, name: d.filename, phase, loaded, total });
    step('down')(0, 0);
    try {
      const { blob, size } = await documentBytes(d.id, cap, step('down'));
      if (!blob) {
        skipped.push({ ...d, why: `${(size / 1048576).toFixed(0)} MB — over the ${c.maxUploadMb} MB limit` });
        continue;
      }
      // two CW documents can carry the same filename; the sandbox would
      // silently overwrite, so make it unique before it goes
      const taken = new Set(Object.values(already).map(a => a.name));
      const base = safeName(d.filename);
      let name = base, n = 1;
      while (taken.has(name)) {
        const dot = base.lastIndexOf('.');
        name = dot > 0 ? `${base.slice(0, dot)}-${n}${base.slice(dot)}` : `${base}-${n}`;
        n++;
      }
      const path = await sandboxUpload(c, termId, dir, name, blob, step('up'));
      const rec = { name, path, size, at: Date.now() };
      already[d.id] = rec;
      uploaded.push({ ...d, ...rec });
    } catch (e) {
      skipped.push({ ...d, why: String(e.message || e) });
    }
  }

  // re-read rather than reuse `c`: attachmentState may have pruned since
  const { sandboxUploads = {} } = await chrome.storage.local.get('sandboxUploads');
  await chrome.storage.local.set({ sandboxUploads: { ...sandboxUploads, [key]: already } });

  const all = chosen.filter(f => already[f.id]).map(f => already[f.id]);
  return { uploaded, skipped, all, termId, dir };
}

// `files` is the record list from pushAttachments; the settings preview
// passes a literal '{{files}}' through instead, so an override keeps the
// paths it would otherwise silently drop.
function buildAttachPrompt(c, ticketId, files) {
  const list = Array.isArray(files) ? files.map(f => `- ${f.path}`).join('\n') : String(files);
  const vars = promptVars(c, { ticket: ticketId, files: list });
  if ((c.promptAttach || '').trim()) return fillTemplate(c.promptAttach, vars);
  const domain = (c.domainFocus || '').trim();
  return `The attachments from ticket ${ticketId} are on your terminal:

${list}

Work out what each one is and open it the right way — extract archives, look at
images, read short text files.

Never read a log file whole. Check its size first, and on anything big work
through the shell instead: grep for errors, exceptions and stack traces, tail
the end, count what you find, then read only the surrounding lines that matter.
Reading a full log is what blows your context before you have learnt anything.

Do not guess at the contents of a file you have not actually opened, and say so
if one turns out to be unreadable.

Then tell me:
- what each file actually shows
- anything in there that explains the problem or moves the diagnosis on${domain ? `, in ${domain} terms` : ''}
- what to check or ask for next`;
}

/* Two jobs, both about the chat we think this ticket owns.

   A chat deleted in Open WebUI leaves its id behind here, and opening
   /c/<gone> does not fail visibly — Open WebUI redirects to a fresh chat
   and drops the whole query string on the way, so ?model= and ?q= are lost
   and the handoff lands on the server's default model with no prompt (the
   prompt only appears because background.js types it in as a fallback).
   So confirm the chat is really there, and forget it if it is not.

   And a chat remembers the model it was created with, which ?model= cannot
   override on an existing chat — realign that through the API while we are
   already asking about it.                                                */
async function resolveChat(c, ticketId, chatId) {
  if (!chatId) return null;
  let rec;
  try {
    rec = await (await aiFetch(c, `/v1/chats/${chatId}`)).json();
  } catch {
    // gone (or unreachable) — drop it so the URL takes the new-chat route,
    // where ?model= and ?q= are read
    const { handoffChats = {} } = await chrome.storage.local.get('handoffChats');
    delete handoffChats[handoffKey(c.cwOrigin, ticketId)];
    await chrome.storage.local.set({ handoffChats });
    return null;
  }
  const want = (c.aiModel || '').trim();
  const models = rec?.chat?.models || [];
  if (want && !(models.length === 1 && models[0] === want)) {
    try {
      await aiFetch(c, `/v1/chats/${chatId}`, {
        method : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body   : JSON.stringify({ chat: { ...rec.chat, models: [want] } })
      });
    } catch { /* opening it still beats not opening it */ }
  }
  return chatId;
}

/* ---- hand off to Open WebUI ----------------------------------------- */

// A chat opened from a URL selects the model but does NOT switch on the tools
// attached to it — that is why the same prompt works when typed into an
// existing chat and fails from here. Set Tool ids in settings (Open WebUI:
// Workspace -> Tools). Different Open WebUI versions read a different query
// param, so pass both: `tools=` (comma list) and `tool_ids=` (JSON array).
//
// Reuses one Open WebUI chat per ticket rather than spawning a new one every
// click: the first "Open in chat" opens `/` (new chat) with the full
// diagnosis prompt; background.js watches that tab, notices Open WebUI
// settle on `/c/<id>`, and remembers it against this ticket. Every click
// after that opens `/c/<id>` directly with a short catch-up prompt instead.
/* opts.prompt overrides the built-in ticket prompt (the attachment lane
   sends its own); opts.terminalId attaches a sandbox to the chat, which is
   what makes uploaded files visible to the model. */
async function handoff(ticketId, opts = {}) {
  const c = await cfg();
  const root = (c.aiBase || '').replace(/\/api\/?$/, '').replace(/\/+$/, '');
  const stored = (c.handoffChats || {})[handoffKey(c.cwOrigin, ticketId)];
  const vars = promptVars(c, { ticket: ticketId });

  const prompt = opts.prompt || (stored
    ? ((c.promptHandoffFollowup || '').trim()
        ? fillTemplate(c.promptHandoffFollowup, vars)
        : `fetch cw ticket ${ticketId} for the latest updates from the customer and advise what the next steps should be.`)
    : ((c.promptHandoff || '').trim()
        ? fillTemplate(c.promptHandoff, vars)
        : `fetch cw ticket ${ticketId}.
then work out what's going on — pull in similar past tickets if any help, plus anything else relevant, and tell me:
- next diagnostic step
- next useful thing to check, run, or ask`));

  const ids = (c.aiTools || '').split(',').map(s => s.trim()).filter(Boolean);
  const tools = ids.length
    ? `&tools=${encodeURIComponent(ids.join(','))}` +
      `&tool_ids=${encodeURIComponent(JSON.stringify(ids))}`
    : '';
  const chatId = await resolveChat(c, ticketId, stored);

  const term = opts.terminalId ? `&terminal_id=${encodeURIComponent(opts.terminalId)}` : '';
  const base = chatId ? `${root}/c/${chatId}` : `${root}/`;
  const url = `${base}?model=${encodeURIComponent(c.aiModel)}${tools}${term}&q=${encodeURIComponent(prompt)}`;
  return { url, isNew: !chatId, root, prompt };
}
