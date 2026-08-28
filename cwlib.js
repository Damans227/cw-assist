/* Shared ConnectWise + model access.

   Loaded by the side panel rather than the service worker: a worker
   cannot use the certificate exception you grant in a tab, so a
   self-signed model server is unreachable from there. Extension pages
   can, which is why the popup's test connection works and the worker's
   identical request does not.                                        */

const ORIGIN = 'https://eu.myconnectwise.net';
const REST   = `${ORIGIN}/v2025_1/apis/3.0`;
const COND   = 'detailDescriptionFlag=true or internalAnalysisFlag=true or resolutionFlag=true';

const DEFAULTS = {
  clientId: '',
  aiBase : 'https://10.1.3.21/api',
  aiKey  : '',
  aiModel: 'cloudstack-support',
  aiTools: '',           // comma-separated Open WebUI tool ids to switch on
  // repos the GH issue lane can target, [{ name, repo }] where repo is
  // "owner/name" or a github.com URL. Seeded with a test fork.
  ghRepos: [{ name: 'CloudStack (test fork)', repo: 'Damans227/cloudstack' }],
  ghToken: ''            // GitHub personal access token, needs issues write
};

const cfg = async () => ({ ...DEFAULTS, ...(await chrome.storage.local.get(DEFAULTS)) });

/* ---- ConnectWise -------------------------------------------------- */

async function api(path) {
  const { clientId } = await cfg();
  const r = await fetch(`${REST}${path}`, {
    credentials: 'include',
    headers: { 'cw-app-id': 'bm-manageclient', ...(clientId ? { clientId } : {}) }
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
      side: n.member ? 'ShapeBlue' : 'customer',
      type: types.join('+') || 'note',
      text: n.text || ''
    };
  })
  // order by when it was written, not by the time entry logged against it
  .sort((a, b) => new Date(a.when || 0) - new Date(b.when || 0))
  .map((n, i) => ({ seq: i + 1, ...n }));
}

/* ---- prompts -------------------------------------------------------- */

const SYSTEM = `You are helping a ShapeBlue CloudStack support consultant work a ticket.

Rules:
- Be concise. Short paragraphs or bullets, no preamble, no sign-off.
- Only use what is in the thread. If something is not there, say so rather than guessing.
- Notes marked "internal" are ShapeBlue-only. Use them for context but never phrase
  anything as if the customer has seen them.
- Keep CloudStack specifics exact: versions, config keys, API names, log lines.
- Do not restate the whole thread back.

You have no tools available here. The complete ticket thread is already included
in this message — everything you need is in front of you. Do not call get_ticket,
get_ticket_notes, kb_exec or any other function, and never emit tool-call syntax.
Just answer from what is here.`;

const PROMPTS = {
  summary: t => `Summarise ticket ${t.ticket} (${t.company || 'unknown company'}).

Use exactly these three headings, each on its own line, written as markdown H3:

### What it is about
One or two sentences.

### The exchange
What we asked, what they gave us, what we found. Only the turns that moved things
forward — skip acknowledgements and chasing. Bullets are fine here.

### Where it stands
Whose move it is right now, and what is blocking.

Nothing before the first heading and nothing after the last.`,

  standing: t => `For ticket ${t.ticket}, work out what is actually outstanding.

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
outstanding on our side, say so plainly under "We owe".`,

};

// Drafts a GitHub issue for the Apache CloudStack project from the ticket
// thread. Written for maintainers who cannot see the ticket — no customer,
// no ShapeBlue, no mention of support.
const ISSUE_PROMPT = t => `From ticket ${t.ticket} (${t.company || 'unknown company'}), draft a GitHub issue for the Apache CloudStack project.

Write it for CloudStack maintainers who cannot see this support ticket. Do not
mention the customer, the ticket, ShapeBlue, or that it came from a support case.
Describe only the technical problem or request.

The very first line must be exactly:
TITLE: <a specific one-line summary of the bug or feature request>

Then a blank line, then the issue body as markdown using these sections. Drop any
section you genuinely have nothing for rather than writing "N/A":

### Problem / feature
What is wrong, or what is being asked for.

### Environment
CloudStack version, hypervisor, database, network setup — whatever the thread gives.

### Steps to reproduce
Numbered, only if the thread supports them.

### Expected vs actual

### Logs / evidence
The relevant log lines, stack traces or error strings from the thread, in a code
block, exact. No paraphrasing.

Only use what is in the thread. Do not invent versions, config keys or log lines.`;

const BOARD_PROMPT = `Produce a triage table for these open tickets.

A markdown table, one row per ticket, columns exactly:
Ticket | Company | Where things stand

Sort by ticket number, highest first. Do not reorder by urgency or age.

"where things stand" is the whole point of this table — it is the only thing the
board itself cannot show. Two or three sentences per ticket covering:
- what the problem actually is: component, version, the real error or symptom,
  not a restatement of the subject line
- how far the diagnosis has got — what has been ruled in or out, what was tried
- what it is blocked on right now, and who has to move

Say the specifics. "Snapshot job 6068 orphaned when the management server
restarted mid-run" beats "snapshot issue being investigated". Include config
keys, versions, error strings and ticket numbers where they matter. Give the
elapsed days whenever a ticket has been quiet more than a few days.

Flag these inside that same column, in the same prose:

- [OWED BY US] — our own last note commits us to doing something and it has not
  happened. Sending documentation, a link, a build, a repo fix, an email, a call.
  There will be no later note saying we failed to deliver — the absence of any
  note since IS the evidence. So: if the last note is ours, contains a promise,
  and several days have passed in silence, that is an unfulfilled promise. Flag
  it and say how many days it has been.

- [AUTO-CLOSE] — status is "Information Requested" or "Awaiting Customer" and
  the customer has been silent past 4 days. Closes at 5.

Do NOT flag a ticket just because we asked the customer a question and they
have not answered. That is the normal state of a support ticket and needs no
label. Waiting on a customer is not a problem; a promise we dropped is.

Instant Guru has no SLA. The ShapeBlue Migrate board is not covered by the
support process doc.

After the table, one line naming the one or two to do first, and why.`;


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
async function boardDigest(onProgress) {
  const rows = await boardRows();
  const open = rows.filter(t => !/resolved|closed/i.test(t.status?.name || ''));
  const now = Date.now();
  const lines = [];

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
      `notes: ${ns.length} | last: ${last?.by || '?'} (${last?.side || '?'}) ${days} days ago\n` +
      (prev ? `previous note (${prev.by}, ${prev.side}): ${prevBody}\n` : '') +
      `last note: ${body}`);
  }
  return { count: open.length, text: lines.join('\n\n') };
}

async function askBoard(onProgress) {
  const { aiBase, aiKey, aiModel } = await cfg();
  if (!aiKey) throw new Error('No API key set — open settings and add it.');

  const { count, text } = await boardDigest(onProgress);
  if (!count) throw new Error('No open tickets found');
  onProgress?.(count, count);      // fetching done, model call starts now

  const out = await chat(aiKey, aiBase, aiModel,
    `${count} open tickets.\n\n${text}\n\n=====\n\n${BOARD_PROMPT}`);
  return { text: out, noteCount: count };
}

const threadForModel = rec => [
  `Ticket ${rec.ticket}: ${rec.summary || ''}`,
  `Company: ${rec.company || '?'}   Contact: ${rec.contact || '?'}`,
  `Board: ${rec.board || '?'}   Status: ${rec.status || '?'}`,
  `Opened: ${rec.entered || '?'}`,
  '',
  ...(rec.notes || []).map(n =>
    `--- note ${n.seq} | ${n.by} (${n.side})` +
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

async function ask(action, ticketId) {
  const { aiBase, aiKey, aiModel } = await cfg();
  if (!aiKey) throw new Error('No API key set — open the extension popup and add it.');
  if (!PROMPTS[action]) throw new Error(`Unknown action: ${action}`);

  const rec = await ticketRecord(ticketId);
  if (!rec.notes.length) throw new Error('No notes on this ticket');

  return { text: await chat(aiKey, aiBase, aiModel,
             `${threadForModel(rec)}\n\n=====\n\n${PROMPTS[action](rec)}`),
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
  const title = (lines.shift() || 'CloudStack issue').replace(/^#{1,4}\s*/, '').trim();
  return { title, body: lines.join('\n').trim() };
}

async function askIssue(ticketId) {
  const { aiBase, aiKey, aiModel } = await cfg();
  if (!aiKey) throw new Error('No API key set — open settings and add it.');

  const rec = await ticketRecord(ticketId);
  if (!rec.notes.length) throw new Error('No notes on this ticket');

  const text = await chat(aiKey, aiBase, aiModel,
    `${threadForModel(rec)}\n\n=====\n\n${ISSUE_PROMPT(rec)}`);

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

async function chat(aiKey, aiBase, aiModel, userContent) {
  let r;
  try {
    r = await fetch(`${aiBase}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${aiKey}` },
      body: JSON.stringify({
        model: aiModel,
        stream: false,
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: userContent }
        ]
      })
    });
  } catch (e) {
    throw new Error(/Failed to fetch/i.test(String(e.message))
      ? `Could not reach ${aiBase}. Open it in a tab once and accept the certificate.`
      : String(e.message || e));
  }

  if (!r.ok) throw new Error(`Model returned HTTP ${r.status}`);
  const j = await r.json();
  const text = j?.choices?.[0]?.message?.content;
  if (!text) throw new Error('Model gave an empty response');
  return text;
}

/* ---- hand off to Open WebUI ------------------------------------------- */

// A chat opened from a URL selects the model but does NOT switch on the tools
// attached to it — that is why the same prompt works when typed into an
// existing chat and fails from here. Set Tool ids in settings to the
// ConnectWise tool (Workspace -> Tools in Open WebUI) and it behaves.
async function handoff(ticketId) {
  const { aiBase, aiModel, aiTools } = await cfg();
  const root = aiBase.replace(/\/api\/?$/, '');

  const prompt =
`fetch cw ticket ${ticketId}.
then work out what's going on — pull in similar past tickets if any help, plus anything else relevant, and tell me:
- next diagnostic step
- next useful thing to check, run, or ask`;

  const tools = aiTools ? `&tools=${encodeURIComponent(aiTools)}` : '';
  return `${root}/?model=${encodeURIComponent(aiModel)}${tools}&q=${encodeURIComponent(prompt)}`;
}
