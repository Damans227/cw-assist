const $ = id => document.getElementById(id);
const escAttr = s => String(s || '').replace(/[&"<]/g, c => ({ '&': '&amp;', '"': '&quot;', '<': '&lt;' }[c]));

async function draw() {
  const c = { ...DEFAULTS, ...(await chrome.storage.local.get(DEFAULTS)) };
  $('aiBase').value  = c.aiBase;
  $('aiModel').value = c.aiModel;
  $('aiKey').value   = c.aiKey;
  $('aiTools').value = c.aiTools;
  $('ghToken').value = c.ghToken;
  repos = Array.isArray(c.ghRepos) ? c.ghRepos.map(r => ({ name: r.name || '', repo: r.repo || '' })) : [];
  renderRepos();
  $('cwstate').textContent = c.clientId
    ? 'ConnectWise access key stored.'
    : 'No ConnectWise access key yet — open or reload a ConnectWise tab once.';
  $('cwstate').style.color = c.clientId ? 'var(--faint)' : 'var(--bad)';
}

['aiBase', 'aiModel', 'aiKey', 'aiTools', 'ghToken'].forEach(k => {
  $(k).onchange = e => chrome.storage.local.set({ [k]: e.target.value.trim() });
});

/* ---- GitHub repos: an editable [{ name, repo }] list ---------------- */

let repos = [];

const saveRepos = () =>
  chrome.storage.local.set({ ghRepos: repos.filter(r => r.name.trim() || r.repo.trim()) });

function renderRepos() {
  $('repoList').innerHTML = repos.length
    ? repos.map((r, i) => `
      <div class="repo-row" data-i="${i}">
        <input class="repo-name" placeholder="Name" value="${escAttr(r.name)}">
        <input class="repo-url" placeholder="owner/name or URL" value="${escAttr(r.repo)}">
        <button class="repo-del" title="remove">&times;</button>
      </div>`).join('')
    : '<p class="note">No repos yet — hit + to add one.</p>';

  $('repoList').querySelectorAll('.repo-row').forEach(row => {
    const i = +row.dataset.i;
    row.querySelector('.repo-name').onchange = e => { repos[i].name = e.target.value.trim(); saveRepos(); };
    row.querySelector('.repo-url').onchange  = e => { repos[i].repo = e.target.value.trim(); saveRepos(); };
    row.querySelector('.repo-del').onclick   = () => { repos.splice(i, 1); saveRepos(); renderRepos(); };
  });
}

$('repoAdd').onclick = () => {
  repos.push({ name: '', repo: '' });
  renderRepos();
  $('repoList').querySelector('.repo-row:last-child .repo-name')?.focus();
};

$('test').onclick = async () => {
  const st = $('state');
  st.textContent = 'testing…';
  st.style.color = 'var(--faint)';

  const c = { ...DEFAULTS, ...(await chrome.storage.local.get(DEFAULTS)) };
  try {
    const r = await fetch(`${c.aiBase}/models`, {
      headers: { Authorization: `Bearer ${c.aiKey}` }
    });
    if (!r.ok) {
      st.textContent = `HTTP ${r.status}`;
      st.style.color = 'var(--bad)';
      return;
    }
    const j = await r.json();
    const names = (j.data || j.models || []).map(m => m.id || m.name);
    const has = names.includes(c.aiModel);
    st.textContent = has ? `reachable · ${c.aiModel} found` : `reachable · ${c.aiModel} not listed`;
    st.style.color = has ? 'var(--ok)' : 'var(--bad)';
  } catch {
    st.textContent = 'unreachable — accept the cert first';
    st.style.color = 'var(--bad)';
  }
};

draw();
