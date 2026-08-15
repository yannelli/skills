const $ = (id) => document.getElementById(id);

const state = {
  session: null,
  catalog: { plugins: [], artifacts: [] },
  selected: null,
  artifact: null
};

async function api(path, options = {}) {
  const headers = { ...options.headers };
  if (options.body && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(path, {
    ...options,
    headers
  });
  const text = await res.text();
  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(text);
    }
  }
  if (!res.ok) {
    throw new Error(data.error ?? (text || res.statusText));
  }
  return data;
}

function statusOf(id) {
  const session = state.session;
  if (!session) {
    return '—';
  }
  if (session.disabledPlugins.includes(id.split('/')[0])) {
    return 'off';
  }
  if (session.pinned.includes(id)) {
    return 'pinned';
  }
  if (session.hydrated.includes(id)) {
    return 'hydrated';
  }
  if (session.dynamicMode && !session.available.includes(id)) {
    return 'shelved';
  }
  return 'open';
}

function renderChips(el, ids, actionLabel, action) {
  el.replaceChildren();
  if (!ids.length) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = 'None';
    el.append(empty);
    return;
  }
  for (const id of ids) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = id;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = actionLabel;
    btn.addEventListener('click', () => action(id));
    li.append(name, btn);
    el.append(li);
  }
}

function renderSession() {
  const session = state.session;
  if (!session) {
    return;
  }
  $('dynamic').checked = session.dynamicMode;
  $('floor-lede').textContent = session.dynamicMode
    ? 'Only pinned and hydrated artifacts are in context. The rest stay searchable.'
    : 'Dynamic is off. Every enabled artifact is available.';
  renderChips($('pinned'), session.pinned, 'Unpin', (id) => postIds('/api/session/unpin', [id]));
  renderChips($('hydrated'), session.hydrated, 'Drop', (id) => postIds('/api/session/dehydrate', [id]));
  renderChips($('hooks'), session.hooksActive, 'Cut', (id) =>
    api('/api/session/hooks', { method: 'POST', body: JSON.stringify({ ids: [id], active: false }) }).then(applySession)
  );
  const plugins = $('plugins');
  plugins.replaceChildren();
  for (const plugin of state.catalog.plugins) {
    const li = document.createElement('li');
    const label = document.createElement('span');
    label.textContent = plugin.name;
    const btn = document.createElement('button');
    const enabled = !session.disabledPlugins.includes(plugin.name);
    btn.type = 'button';
    btn.textContent = enabled ? 'On' : 'Off';
    btn.addEventListener('click', () =>
      api(`/api/plugins/${plugin.name}/enabled`, {
        method: 'POST',
        body: JSON.stringify({ enabled: !enabled })
      }).then(applySession)
    );
    li.append(label, btn);
    plugins.append(li);
  }
  $('counts').textContent = `${state.catalog.plugins.length} plugins · ${state.catalog.artifacts.length} artifacts · ${session.available.length} live`;
}

function renderCatalog() {
  const rows = $('rows');
  rows.replaceChildren();
  for (const item of state.catalog.artifacts) {
    const tr = document.createElement('tr');
    if (state.selected === item.id) {
      tr.classList.add('active');
    }
    const status = statusOf(item.id);
    tr.innerHTML = `
      <td>${item.id}</td>
      <td class="kind">${item.kind}</td>
      <td class="state ${status === 'shelved' ? 'hold' : 'on'}">${status}</td>
      <td class="desc">${escapeHtml(item.description)}</td>
    `;
    tr.addEventListener('click', () => select(item.id));
    rows.append(tr);
  }
}

function renderInspector() {
  const artifact = state.artifact;
  const actions = $('inspect-actions');
  const editor = $('editor');
  const save = $('save');
  if (!artifact) {
    $('inspect-title').textContent = 'Select an artifact';
    $('inspect-desc').textContent = 'Bodies stay on disk until you hydrate them in dynamic mode.';
    actions.hidden = true;
    editor.value = '';
    editor.disabled = true;
    save.disabled = true;
    return;
  }
  const status = statusOf(artifact.id);
  $('inspect-title').textContent = artifact.id;
  $('inspect-desc').textContent = artifact.description || 'No description.';
  actions.hidden = false;
  actions.replaceChildren();
  addAction(actions, status === 'pinned' ? 'Unpin' : 'Pin', () =>
    postIds(status === 'pinned' ? '/api/session/unpin' : '/api/session/pin', [artifact.id])
  );
  addAction(actions, status === 'hydrated' ? 'Dehydrate' : 'Hydrate', () =>
    postIds(status === 'hydrated' ? '/api/session/dehydrate' : '/api/session/hydrate', [artifact.id])
  );
  if (artifact.kind === 'hook') {
    const live = state.session?.hooksActive.includes(artifact.id);
    addAction(actions, live ? 'Disable hooks' : 'Enable hooks', () =>
      api('/api/session/hooks', {
        method: 'POST',
        body: JSON.stringify({ ids: [artifact.id], active: !live })
      }).then(applySession)
    );
  }
  editor.value = artifact.raw;
  editor.disabled = false;
  save.disabled = false;
}

function addAction(root, label, onClick) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = label;
  btn.addEventListener('click', onClick);
  root.append(btn);
}

async function applySession(session) {
  state.session = session;
  renderSession();
  renderCatalog();
  renderInspector();
}

async function refresh() {
  const q = $('q').value;
  const kind = $('kind').value;
  const params = new URLSearchParams();
  if (q) {
    params.set('q', q);
  }
  if (kind) {
    params.set('kind', kind);
  }
  const [catalog, session] = await Promise.all([
    api(`/api/catalog?${params}`),
    api('/api/session')
  ]);
  state.catalog = catalog;
  state.session = session;
  renderSession();
  renderCatalog();
}

async function select(id) {
  state.selected = id;
  const data = await api(`/api/artifact?id=${encodeURIComponent(id)}`);
  state.artifact = data.artifact;
  renderCatalog();
  renderInspector();
}

async function postIds(path, ids) {
  const session = await api(path, { method: 'POST', body: JSON.stringify({ ids }) });
  await applySession(session);
}

function flash(message, isError) {
  const el = $('status');
  el.textContent = message;
  el.classList.toggle('err', Boolean(isError));
}

function escapeHtml(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

$('dynamic').addEventListener('change', async (event) => {
  const enabled = event.target.checked;
  await applySession(await api('/api/session/dynamic', { method: 'POST', body: JSON.stringify({ enabled }) }));
});

$('q').addEventListener('input', () => {
  void refresh();
});
$('kind').addEventListener('change', () => {
  void refresh();
});
$('reload').addEventListener('click', async () => {
  await api('/api/catalog/reload', { method: 'POST' });
  await refresh();
});
$('save').addEventListener('click', async () => {
  if (!state.artifact) {
    return;
  }
  try {
    const data = await api(`/api/artifact?id=${encodeURIComponent(state.artifact.id)}`, {
      method: 'PUT',
      body: JSON.stringify({ raw: $('editor').value })
    });
    state.artifact = data.artifact;
    flash('Saved');
    await refresh();
  } catch (error) {
    flash(error.message, true);
  }
});
$('create').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(event.target);
  try {
    await api('/api/plugins', {
      method: 'POST',
      body: JSON.stringify({
        name: String(form.get('name') ?? ''),
        description: String(form.get('description') ?? '')
      })
    });
    event.target.reset();
    flash('Plugin scaffolded');
    await refresh();
  } catch (error) {
    flash(error.message, true);
  }
});

void refresh().catch((error) => flash(error.message, true));
