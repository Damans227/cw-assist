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
  promptHandoff : '',

  /* ---- GitHub issue lane ---- */
  ghRepos: [],                 // [{ name, repo }] — repo is "owner/name" or a URL
  ghToken: ''
};

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

// fills {{placeholders}} in a user-supplied override string
const fillTemplate = (tpl, vars) =>
  String(tpl).replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] ?? '').toString());

/* ---- ConnectWise -------------------------------------------------- */

async function api(path) {
  const { clientId, cwAppId } = await cfg();
  const { rest } = await cwUrls();
  const r = await fetch(`${rest}${path}`, {
    credentials: 'include',
    headers: { 'cw-app-id': (cwAppId || 'bm-manageclient'), ...(clientId ? { clientId } : {}) }
  });
  if (r.status === 401 || r.status === 403) {
    throw new Error('ConnectWise rejected the request — reload a ConnectWise tab so the access key can be picked up.');
  }
  if (!r.ok) throw new Error(`ConnectWise returned HTTP ${r.status}`);
  return r.json();
}

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

/* ---- prompts ------------------------------------------------------
   Each builder returns the user's override (with placeholders filled)
   when set, otherwise a de-branded default shaped by vendorName /
   domainFocus / boardExtraRules.                                    */

function buildSystem(c) {
  const v = vendorProse(c);
  const domain = (c.domainFocus || '').trim();
  if ((c.promptSystem || '').trim()) {
    return fillTemplate(c.promptSystem, { vendor: v, domain });
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
  const vars = { ticket: t.ticket, company: t.company || 'unknown company',
                 vendor: vendorProse(c), domain: (c.domainFocus || '').trim() };
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
  const vars = { ticket: t.ticket, company: t.company || 'unknown company',
                 vendor: vendorProse(c), domain: (c.domainFocus || '').trim() };
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
    return fillTemplate(c.promptBoard, { vendor: vendorProse(c), domain, extraRules: extra });
  }
  return `Produce a triage table for these open tickets.

A markdown table, one row per ticket, columns exactly:
Ticket | Company | Where things stand

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

Flag this inside that same column, in the same prose:

- [OWED BY US] — our own last note commits us to doing something and it has not
  happened. Sending documentation, a link, a build, a fix, an email, a call.
  There will be no later note saying we failed to deliver — the absence of any
  note since IS the evidence. So: if the last note is ours, contains a promise,
  and several days have passed in silence, that is an unfulfilled promise. Flag
  it and say how many days it has been.

Do NOT flag a ticket just because we asked the customer a question and they
have not answered. That is the normal state of a support ticket and needs no
label. Waiting on a customer is not a problem; a promise we dropped is.
${extra ? `\n${extra}\n` : ''}
After the table, one line naming the one or two to do first, and why.`;
}

function buildIssuePrompt(c, t, repoName) {
  const repo = (repoName || '').trim() || 'this project';
  const domain = (c.domainFocus || '').trim();
  const vars = { ticket: t.ticket, company: t.company || 'unknown company',
                 vendor: vendorProse(c), domain, repo };
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

/* ---- hand off to Open WebUI ----------------------------------------- */

// A chat opened from a URL selects the model but does NOT switch on the tools
// attached to it — that is why the same prompt works when typed into an
// existing chat and fails from here. Set Tool ids in settings (Open WebUI:
// Workspace -> Tools) and they are passed as ?tool_ids=[...] so the new chat
// has them enabled.
async function handoff(ticketId) {
  const c = await cfg();
  const root = (c.aiBase || '').replace(/\/api\/?$/, '').replace(/\/+$/, '');

  const prompt = (c.promptHandoff || '').trim()
    ? fillTemplate(c.promptHandoff, { ticket: ticketId })
    : `fetch cw ticket ${ticketId}.
then work out what's going on — pull in similar past tickets if any help, plus anything else relevant, and tell me:
- next diagnostic step
- next useful thing to check, run, or ask`;

  const ids = (c.aiTools || '').split(',').map(s => s.trim()).filter(Boolean);
  const tools = ids.length ? `&tool_ids=${encodeURIComponent(JSON.stringify(ids))}` : '';
  return `${root}/?model=${encodeURIComponent(c.aiModel)}${tools}&q=${encodeURIComponent(prompt)}`;
}
