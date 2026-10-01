import {
  getScripts, saveScripts, buildScript, parseMetadata, DEFAULT_TEMPLATE, setupApiNotice,
  getSettings, saveSettings
} from './lib/userscript.js';
import { highlight } from './lib/highlight.js';
import { lint } from './lib/lint.js';

const $ = (s) => document.querySelector(s);

let scripts = [];
let errors = {};
let settings = {};
let globalEnabled = true;
let activeId = null;
let dirty = false;
let filter = '';

// ---------- init ----------

async function init() {
  const store = await chrome.storage.local.get(['lastErrors', 'apiStatus', 'globalEnabled']);
  errors = store.lastErrors || {};
  globalEnabled = store.globalEnabled !== false;
  await setupApiNotice(store.apiStatus);

  settings = await getSettings();
  applySettings();

  scripts = await getScripts();
  renderList();

  const params = new URLSearchParams(location.search);
  if (params.get('new')) {
    createNew(params.get('match') || '*://*/*');
  } else if (params.get('id') && scripts.some((s) => s.id === params.get('id'))) {
    open(params.get('id'));
  } else {
    showHome();
  }
  history.replaceState(null, '', location.pathname);
}

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local') return;
  if (changes.lastErrors) {
    errors = changes.lastErrors.newValue || {};
    renderList();
    renderHome();
    showErrorForActive();
  }
  if (changes.globalEnabled) {
    globalEnabled = changes.globalEnabled.newValue !== false;
    $('#setGlobal').checked = globalEnabled;
  }
  if (changes.scripts && !saving) {
    scripts = changes.scripts.newValue || [];
    renderList();
    renderHome();
    const s = current();
    if (s && !dirty) fillEditor(s);
    else if (activeId && !s) showHome();
  }
});

// ---------- home ----------

function showHome() {
  if (!confirmDiscard()) return;
  activeId = null;
  setDirty(false);
  $('#editor').hidden = true;
  $('#home').hidden = false;
  renderList();
  renderHome();
  renderDiagnostics();
}

function timeAgo(ts) {
  if (!ts) return '';
  const d = Date.now() - ts;
  const m = Math.floor(d / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  const days = Math.floor(h / 24);
  if (days < 30) return `${days} d ago`;
  return new Date(ts).toLocaleDateString();
}

function renderHome() {
  const saved = scripts.filter((s) => !s._unsaved);
  $('#statTotal').textContent = saved.length;
  $('#statEnabled').textContent = saved.filter((s) => s.enabled).length;
  $('#statErrors').textContent = saved.filter((s) => errors[s.id]).length;

  const recent = [...saved].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, 4);
  $('#recentEmpty').hidden = recent.length > 0;
  $('#recentHint').textContent = saved.length > 4 ? `showing 4 of ${saved.length}` : '';
  $('#recentGrid').replaceChildren(...recent.map((s) => {
    const card = document.createElement('div');
    card.className = 'card' + (s.enabled ? '' : ' disabled');

    const body = document.createElement('div');
    body.className = 'card-body';
    const name = document.createElement('div');
    name.className = 'card-name';
    name.textContent = s.name;
    const desc = document.createElement('div');
    desc.className = 'card-desc';
    desc.textContent = s.description || 'No description';
    const meta = document.createElement('div');
    meta.className = 'card-meta';
    const rules = [...(s.matches || []), ...(s.includes || [])];
    const rule = document.createElement('span');
    rule.className = 'mono';
    rule.textContent = rules[0] ? rules[0] + (rules.length > 1 ? ` +${rules.length - 1}` : '') : 'no match rules';
    const time = document.createElement('span');
    time.textContent = timeAgo(s.updatedAt);
    meta.append(rule, time);
    if (errors[s.id]) {
      const err = document.createElement('span');
      err.className = 'badge err';
      err.textContent = 'error';
      err.title = errors[s.id];
      meta.append(err);
    }
    body.append(name, desc, meta);
    body.addEventListener('click', () => open(s.id));

    const sw = document.createElement('label');
    sw.className = 'switch';
    sw.title = 'Enable / disable';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!s.enabled;
    cb.addEventListener('change', async () => {
      s.enabled = cb.checked;
      card.classList.toggle('disabled', !s.enabled);
      saving = true;
      try { await saveScripts(scripts); } finally { saving = false; }
      renderList();
      $('#statEnabled').textContent = saved.filter((x) => x.enabled).length;
    });
    const track = document.createElement('span');
    track.className = 'track';
    sw.append(cb, track);

    card.append(body, sw);
    return card;
  }));
}

// ---------- diagnostics ----------

async function renderDiagnostics() {
  const apiEl = $('#diagApi');
  const apiBadge = $('#diagApiBadge');
  const regEl = $('#diagRegistered');
  const regBadge = $('#diagRegBadge');
  const listRow = $('#diagListRow');
  const list = $('#diagList');

  if (!chrome.userScripts) {
    apiEl.textContent = 'Not available. Enable "Allow User Scripts" for JSyringe on chrome://extensions, then reload the extension.';
    apiBadge.textContent = 'OFF';
    apiBadge.className = 'badge err';
    regEl.textContent = 'Nothing can be registered until the API is enabled.';
    regBadge.textContent = '0';
    regBadge.className = 'badge err';
    listRow.hidden = true;
    return;
  }
  apiEl.textContent = 'Available.' + (globalEnabled ? '' : ' Master switch is OFF, so nothing is registered.');
  apiBadge.textContent = 'OK';
  apiBadge.className = 'badge ok';

  try {
    const regs = await chrome.userScripts.getScripts();
    const enabled = scripts.filter((s) => s.enabled && !s._unsaved).length;
    regEl.textContent = `${regs.length} script(s) registered with the browser, ${enabled} enabled in JSyringe.` +
      (regs.length < enabled ? ' Some failed to register. Check the red error markers in the script list.' : '');
    regBadge.textContent = String(regs.length);
    regBadge.className = 'badge ' + (regs.length === enabled ? 'ok' : 'err');
    listRow.hidden = regs.length === 0;
    list.textContent = regs.map((r) => {
      const s = scripts.find((x) => x.id === r.id);
      return `${s ? s.name : r.id}  →  ${(r.matches || []).join(', ')}  [${r.world || 'USER_SCRIPT'}, ${r.runAt || 'document_idle'}]`;
    }).join('\n');
  } catch (e) {
    regEl.textContent = 'Could not read registrations: ' + (e.message || e);
    regBadge.textContent = '?';
    regBadge.className = 'badge err';
    listRow.hidden = true;
  }
}

$('#diagRefresh').addEventListener('click', renderDiagnostics);
$('#diagResync').addEventListener('click', async () => {
  try { await chrome.runtime.sendMessage({ type: 'sync' }); } catch { /* ignore */ }
  setTimeout(renderDiagnostics, 300);
  toast('Scripts re-synced');
});

// ---------- settings ----------

function applySettings() {
  document.documentElement.style.setProperty('--editor-font-size', settings.editorFontSize + 'px');
  $('#code').setAttribute('wrap', settings.editorWrap ? 'soft' : 'off');
  $('#codeWrap').classList.toggle('wrap', !!settings.editorWrap);
  // Line numbers can't follow soft-wrapped lines, so hide the gutter when wrapping.
  $('#gutter').hidden = !!settings.editorWrap;

  $('#setGlobal').checked = globalEnabled;
  $('#setRunAt').value = settings.defaultRunAt;
  $('#setInject').value = settings.defaultInjectInto;
  $('#setFont').value = String(settings.editorFontSize);
  $('#setWrap').checked = !!settings.editorWrap;
  $('#setAiProvider').value = settings.aiProvider || 'cloud';
  $('#setAiCloudEndpoint').value = settings.aiCloudEndpoint || '';
  $('#setAiEndpoint').value = settings.aiEndpoint || '';
  $('#aiProviderSelect').value = settings.aiProvider || 'cloud';
}

async function updateSetting(key, value) {
  settings = { ...settings, [key]: value };
  await saveSettings(settings);
  applySettings();
  updateGutter();
}

$('#setGlobal').addEventListener('change', async (e) => {
  globalEnabled = e.target.checked;
  await chrome.storage.local.set({ globalEnabled });
  try { await chrome.runtime.sendMessage({ type: 'sync' }); } catch { /* storage listener handles it */ }
  toast(globalEnabled ? 'All scripts enabled. Reload pages to apply.' : 'All scripts paused. Reload pages to apply.');
});
$('#setRunAt').addEventListener('change', (e) => updateSetting('defaultRunAt', e.target.value));
$('#setInject').addEventListener('change', (e) => updateSetting('defaultInjectInto', e.target.value));
$('#setFont').addEventListener('change', (e) => updateSetting('editorFontSize', Number(e.target.value)));
$('#setWrap').addEventListener('change', (e) => updateSetting('editorWrap', e.target.checked));
$('#setAiProvider').addEventListener('change', (e) => updateSetting('aiProvider', e.target.value).then(aiCheck));
$('#setAiCloudEndpoint').addEventListener('change', (e) => {
  updateSetting('aiCloudEndpoint', e.target.value.trim().replace(/\/+$/, '') || 'https://text.pollinations.ai').then(aiCheck);
});
$('#setAiEndpoint').addEventListener('change', (e) => {
  updateSetting('aiEndpoint', e.target.value.trim().replace(/\/+$/, '') || 'http://localhost:11434').then(aiCheck);
});

$('#setDeleteAll').addEventListener('click', async () => {
  const n = scripts.filter((s) => !s._unsaved).length;
  if (!n) { toast('Nothing to delete'); return; }
  if (!confirm(`Delete all ${n} script(s)? This cannot be undone.`)) return;
  scripts = [];
  saving = true;
  try { await saveScripts(scripts); } finally { saving = false; }
  activeId = null;
  dirty = false;
  showHome();
  toast('All scripts deleted');
});

$('#homeBtn').addEventListener('click', showHome);
$('#homeNew').addEventListener('click', () => createNew());
$('#homeImport').addEventListener('click', () => $('#fileInput').click());
$('#homeImportUrl').addEventListener('click', () => importFromUrl());
$('#homeExport').addEventListener('click', () => exportAll());

// ---------- list ----------

function current() {
  return scripts.find((s) => s.id === activeId) || null;
}

function renderList() {
  const q = filter.trim().toLowerCase();
  const visible = scripts
    .filter((s) => !q || s.name.toLowerCase().includes(q) || (s.matches || []).join(' ').toLowerCase().includes(q))
    .sort((a, b) => a.name.localeCompare(b.name));

  $('#listEmpty').hidden = scripts.length > 0;
  $('#scriptList').replaceChildren(...visible.map((s) => {
    const li = document.createElement('li');
    li.className = 'script-item' + (s.enabled ? '' : ' disabled') + (errors[s.id] ? ' error' : '') + (s.id === activeId ? ' active' : '');
    li.dataset.id = s.id;
    const dot = document.createElement('span');
    dot.className = 'dot';
    const txt = document.createElement('div');
    txt.className = 'txt';
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = s.name;
    const sub = document.createElement('div');
    sub.className = 'sub';
    const rules = [...(s.matches || []), ...(s.includes || [])];
    sub.textContent = rules[0] ? rules[0] + (rules.length > 1 ? `  +${rules.length - 1}` : '') : 'no match rules';
    txt.append(name, sub);
    li.append(dot, txt);
    li.addEventListener('click', () => open(s.id));
    return li;
  }));
}

$('#search').addEventListener('input', (e) => { filter = e.target.value; renderList(); });

// ---------- editor ----------

function confirmDiscard() {
  if (dirty && !confirm('You have unsaved changes. Discard them?')) return false;
  // Drop scripts that were created but never saved.
  scripts = scripts.filter((s) => !s._unsaved);
  return true;
}

function open(id) {
  if (id === activeId) return;
  if (!confirmDiscard()) return;
  activeId = id;
  const s = current();
  if (!s) return;
  fillEditor(s);
  setDirty(false);
  $('#home').hidden = true;
  $('#editor').hidden = false;
  renderList();
  $('#code').focus();
}

function fillEditor(s) {
  $('#code').value = s.code;
  $('#enabledToggle').checked = !!s.enabled;
  updateHeader(s);
  problems = [];
  updateGutter();
  runLint();
  showErrorForActive();
}

function updateHeader(s) {
  $('#scriptName').textContent = s.name || 'Untitled script';
  $('#statusBadge').textContent = s.enabled ? 'Enabled' : 'Disabled';
  $('#statusBadge').className = 'badge ' + (s.enabled ? 'ok' : 'off');
  const parts = [];
  if (s.version) parts.push('v' + s.version);
  parts.push(`${(s.matches || []).length + (s.includes || []).length} match rule(s)`);
  parts.push(s.runAt || 'document-idle');
  parts.push(s.world === 'MAIN' ? 'page world' : 'isolated world');
  $('#metaInfo').textContent = parts.join(' · ');
}

function showErrorForActive() {
  const n = $('#errorNotice');
  const err = activeId && errors[activeId];
  n.hidden = !err;
  if (err) n.textContent = 'Chrome could not register this script: ' + err;
}

function setDirty(v) {
  dirty = v;
  const el = $('#saveState');
  el.textContent = v ? 'Unsaved changes' : 'Saved';
  el.classList.toggle('dirty', v);
}

function createNew(match = '*://*/*') {
  if (!confirmDiscard()) return;
  const s = buildScript(DEFAULT_TEMPLATE('New script', match, {
    runAt: settings.defaultRunAt,
    injectInto: settings.defaultInjectInto
  }));
  s._unsaved = true;
  scripts.push(s);
  activeId = s.id;
  fillEditor(s);
  $('#home').hidden = true;
  $('#editor').hidden = false;
  renderList();
  setDirty(true);
  const ta = $('#code');
  ta.focus();
  const pos = ta.value.indexOf('New script');
  ta.setSelectionRange(pos, pos + 'New script'.length);
}

let saving = false;
async function save() {
  const s = current();
  if (!s) return;
  const code = $('#code').value;
  const updated = buildScript(code, s);
  updated.enabled = $('#enabledToggle').checked;
  Object.assign(s, updated);
  delete s._unsaved;

  saving = true;
  try {
    await saveScripts(scripts);
  } finally {
    saving = false;
  }
  updateHeader(s);
  renderList();
  setDirty(false);
  toast('Saved');
}

async function remove() {
  const s = current();
  if (!s) return;
  if (!confirm(`Delete "${s.name}"? This cannot be undone.`)) return;
  scripts = scripts.filter((x) => x.id !== s.id);
  saving = true;
  try { await saveScripts(scripts); } finally { saving = false; }
  setDirty(false);
  showHome();
  toast('Script deleted');
}

function exportScript(s) {
  const blob = new Blob([s.code], { type: 'text/javascript' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (s.name || 'script').replace(/[^\w.-]+/g, '_') + '.user.js';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function exportAll() {
  const blob = new Blob([JSON.stringify({ jsyringe: 1, exportedAt: new Date().toISOString(), scripts }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'jsyringe-backup.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------- import ----------

async function importText(text, filename = '') {
  // JSON backup?
  if (filename.endsWith('.json') || text.trimStart().startsWith('{')) {
    try {
      const data = JSON.parse(text);
      if (data && Array.isArray(data.scripts)) {
        let n = 0;
        for (const s of data.scripts) {
          if (!s.code) continue;
          const existing = scripts.find((x) => x.id === s.id);
          const built = buildScript(s.code, existing || { id: s.id, enabled: s.enabled, createdAt: s.createdAt });
          if (existing) Object.assign(existing, built); else scripts.push(built);
          n++;
        }
        await saveScripts(scripts);
        renderList();
        toast(`Imported ${n} script(s) from backup`);
        return;
      }
    } catch { /* not JSON, fall through */ }
  }

  const meta = parseMetadata(text);
  const existing = meta.name && scripts.find((x) => x.name === meta.name);
  if (existing && !confirm(`A script named "${meta.name}" already exists. Replace it?`)) return;
  const built = buildScript(text, existing || {});
  if (existing) Object.assign(existing, built); else scripts.push(built);
  await saveScripts(scripts);
  renderList();
  activeId = null;
  open(built.id);
  toast(existing ? 'Script updated' : 'Script imported');
}

$('#fileInput').addEventListener('change', async (e) => {
  for (const f of e.target.files) importText(await f.text(), f.name);
  e.target.value = '';
});

async function importFromUrl() {
  const url = prompt('URL of a .user.js file:');
  if (!url) return;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(res.status + ' ' + res.statusText);
    await importText(await res.text(), url);
  } catch (err) {
    alert('Could not fetch script: ' + err.message);
  }
}

// ---------- editor behaviour ----------

const code = $('#code');
const gutter = $('#gutter');
const highlightEl = $('#highlightCode');
const highlightPre = $('#highlight');

let problems = [];      // [{ line, message }] from the linter
let lintTimer = null;

/** Redraw line numbers, error markers and the syntax-highlight layer. */
function updateGutter() {
  const value = code.value;
  const lineCount = value.split('\n').length;
  const byLine = new Map();
  for (const p of problems) {
    const ln = Math.min(Math.max(1, p.line), lineCount);
    byLine.set(ln, byLine.has(ln) ? byLine.get(ln) + '\n' + p.message : p.message);
  }
  const frag = document.createDocumentFragment();
  for (let i = 1; i <= lineCount; i++) {
    const el = document.createElement('div');
    el.className = 'ln' + (byLine.has(i) ? ' err' : '');
    el.textContent = i;
    if (byLine.has(i)) el.title = byLine.get(i);
    frag.append(el);
  }
  gutter.replaceChildren(frag);

  // Trailing newline needs an extra blank line so the layer height matches the textarea.
  highlightEl.innerHTML = highlight(value) + (value.endsWith('\n') ? '\n' : '');
  syncScroll();
}

function syncScroll() {
  gutter.scrollTop = code.scrollTop;
  highlightPre.scrollTop = code.scrollTop;
  highlightPre.scrollLeft = code.scrollLeft;
}

function runLint() {
  lintTimer = null;
  try {
    problems = lint(code.value);
  } catch (e) {
    problems = [];
    console.warn('lint failed', e);
  }
  const st = $('#lintState');
  if (!problems.length) {
    st.textContent = 'No problems';
    st.className = 'ok';
  } else {
    st.textContent = `${problems.length} problem${problems.length > 1 ? 's' : ''} · line ${problems[0].line}: ${problems[0].message}`;
    st.className = 'err';
    st.title = problems.map((p) => `Line ${p.line}: ${p.message}`).join('\n');
  }
  updateGutter();
}

function scheduleLint(delay = 350) {
  if (lintTimer) clearTimeout(lintTimer);
  lintTimer = setTimeout(runLint, delay);
}

function updateCursor() {
  const before = code.value.slice(0, code.selectionStart);
  const ln = before.split('\n').length;
  const col = before.length - before.lastIndexOf('\n');
  $('#cursorPos').textContent = `Ln ${ln}, Col ${col}`;
}

code.addEventListener('input', () => { setDirty(true); updateGutter(); updateCursor(); scheduleLint(); });
code.addEventListener('scroll', syncScroll);
code.addEventListener('keyup', updateCursor);
code.addEventListener('click', updateCursor);

code.addEventListener('keydown', (e) => {
  if (e.key === 'Tab') {
    e.preventDefault();
    const { selectionStart: s, selectionEnd: en, value } = code;
    if (e.shiftKey) {
      const lineStart = value.lastIndexOf('\n', s - 1) + 1;
      if (value.startsWith('  ', lineStart)) {
        code.setRangeText('', lineStart, lineStart + 2, 'end');
        code.setSelectionRange(Math.max(lineStart, s - 2), Math.max(lineStart, en - 2));
        code.dispatchEvent(new Event('input'));
      }
      return;
    }
    if (s !== en && value.slice(s, en).includes('\n')) {
      // indent block
      const lineStart = value.lastIndexOf('\n', s - 1) + 1;
      const block = value.slice(lineStart, en);
      const indented = block.replace(/^/gm, '  ');
      code.setRangeText(indented, lineStart, en, 'select');
    } else {
      code.setRangeText('  ', s, en, 'end');
    }
    code.dispatchEvent(new Event('input'));
  } else if (e.key === 'Enter') {
    e.preventDefault();
    const { selectionStart: s, value } = code;
    const lineStart = value.lastIndexOf('\n', s - 1) + 1;
    const indent = (value.slice(lineStart, s).match(/^[ \t]*/) || [''])[0];
    const extra = /[{([]\s*$/.test(value.slice(lineStart, s)) ? '  ' : '';
    code.setRangeText('\n' + indent + extra, s, code.selectionEnd, 'end');
    code.dispatchEvent(new Event('input'));
  }
});

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    if (activeId) save();
  }
});

$('#enabledToggle').addEventListener('change', async (e) => {
  const s = current();
  if (!s) return;
  s.enabled = e.target.checked;
  s.updatedAt = Date.now();
  saving = true;
  try { await saveScripts(scripts); } finally { saving = false; }
  updateHeader(s);
  renderList();
});

$('#saveBtn').addEventListener('click', save);
$('#deleteBtn').addEventListener('click', remove);
$('#exportBtn').addEventListener('click', () => { const s = current(); if (s) exportScript(s); });
$('#exportAllBtn').addEventListener('click', exportAll);
$('#newBtn').addEventListener('click', () => createNew());
$('#importBtn').addEventListener('click', () => $('#fileInput').click());
$('#importUrlBtn').addEventListener('click', importFromUrl);

window.addEventListener('beforeunload', (e) => {
  if (dirty) { e.preventDefault(); e.returnValue = ''; }
});

// ---------- AI assistant (Ollama, local, no API key) ----------

const AI_SYSTEM = `You are an expert at writing browser userscripts (Tampermonkey / Greasemonkey style) for a manager called JSyringe.
Rules:
- Reply with ONE complete userscript inside a single \`\`\`javascript code block, followed by at most two short sentences.
- The script MUST start with a // ==UserScript== header containing @name, @version, @description, @match (one per site), @run-at and @inject-into page.
- Use plain modern JavaScript, no external libraries, no build steps. Wrap the code in an IIFE with 'use strict'.
- Available helpers: GM_addStyle(css), GM_getValue(key, default), GM_setValue(key, value), GM_info, unsafeWindow.
- Prefer @run-at document-idle unless the task needs earlier execution. Use MutationObserver for dynamically loaded content.
- Never include explanations inside the code block other than short comments.`;

let aiHistory = [];
let aiAbort = null;
let aiLastCode = '';

function aiEl(role, text = '') {
  const el = document.createElement('div');
  el.className = 'ai-msg ' + role;
  el.textContent = text;
  $('#aiMessages').append(el);
  el.scrollIntoView({ block: 'end' });
  return el;
}

function extractCode(text) {
  const m = text.match(/```(?:javascript|js)?\s*\n([\s\S]*?)```/i);
  if (m) return m[1].trim();
  if (/==UserScript==/.test(text)) return text.trim();
  return '';
}

function renderAssistant(el, text, streaming) {
  const code = extractCode(text);
  const prose = text.replace(/```[\s\S]*?(```|$)/g, '').trim();
  el.replaceChildren();
  const p = document.createElement('span');
  p.textContent = prose || (code ? 'Here is the script:' : '');
  if (streaming) p.classList.add('typing');
  el.append(p);
  if (code) {
    const pre = document.createElement('pre');
    pre.textContent = code;
    el.append(pre);
  }
  el.scrollIntoView({ block: 'end' });
}

// Preferred open-source cloud models, in order. Used to pick a default.
const CLOUD_PREFERRED = ['qwen-coder', 'qwen', 'mistral', 'llama', 'deepseek', 'openai-fast', 'openai'];

function aiIsCloud() { return (settings.aiProvider || 'cloud') === 'cloud'; }
function aiModelKey() { return aiIsCloud() ? 'aiCloudModel' : 'aiModel'; }

/** models: [{name, label}] */
function fillModelSelect(models, wanted) {
  const sel = $('#aiModelSelect');
  const names = models.map((m) => m.name);
  sel.replaceChildren(...models.map((m) => {
    const o = document.createElement('option');
    o.value = m.name;
    o.textContent = m.label || m.name;
    o.title = m.label || m.name;
    return o;
  }));
  let pick = names.includes(wanted) ? wanted : null;
  if (!pick && aiIsCloud()) pick = CLOUD_PREFERRED.find((p) => names.includes(p)) || null;
  if (!pick) pick = names[0] || '';
  sel.value = pick;
  if (pick && pick !== wanted) updateSetting(aiModelKey(), pick);
  return pick;
}

async function aiCheck() {
  const status = $('#aiStatus');
  status.textContent = 'checking…';
  status.className = 'ai-status';
  $('#aiSetupCloud').hidden = !aiIsCloud();
  $('#aiSetupOllama').hidden = aiIsCloud();
  const fail = (msg) => {
    status.textContent = msg;
    status.className = 'ai-status err';
    $('#aiSetup').hidden = false;
    return false;
  };
  try {
    let models = [];
    if (aiIsCloud()) {
      const res = await fetch(settings.aiCloudEndpoint + '/models', { signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(res.status);
      const list = await res.json();
      models = (Array.isArray(list) ? list : (list.data || []))
        .map((m) => (typeof m === 'string' ? { name: m } : { name: m.name || m.id, label: m.description ? `${m.name || m.id} · ${m.description}` : (m.name || m.id) }))
        .filter((m) => m.name);
      if (!models.length) models = [{ name: 'openai-fast', label: 'openai-fast · GPT-OSS 20B' }];
    } else {
      const res = await fetch(settings.aiEndpoint + '/api/tags', { signal: AbortSignal.timeout(4000) });
      if (!res.ok) throw new Error(res.status);
      const list = await res.json();
      models = (list.models || []).map((m) => ({ name: m.name }));
      if (!models.length) return fail('no models pulled');
    }
    fillModelSelect(models, settings[aiModelKey()]);
    status.textContent = aiIsCloud() ? 'Cloud connected · free, no key' : 'Ollama connected';
    status.className = 'ai-status ok';
    $('#aiSetup').hidden = true;
    return true;
  } catch {
    return fail(aiIsCloud() ? 'Cloud service not reachable' : 'Ollama not reachable');
  }
}

function aiToggle(open) {
  const panel = $('#aiPanel');
  const show = open ?? panel.hidden;
  panel.hidden = !show;
  $('#aiFab').classList.toggle('open', show);
  if (show) {
    $('#aiCtxWrap').hidden = !current();
    $('#aiProviderSelect').value = settings.aiProvider || 'cloud';
    aiCheck();
    $('#aiPrompt').focus();
  }
}

/** Stream a chat completion from the active provider; calls onDelta(text) per chunk. */
async function aiStream(model, messages, signal, onDelta, onThinking) {
  if (aiIsCloud()) {
    const res = await fetch(settings.aiCloudEndpoint + '/openai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify({ model, messages, stream: true, temperature: 0.2 })
    });
    if (!res.ok) throw new Error(`Cloud service returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('text/event-stream')) {
      // Non-streaming fallback: plain JSON or plain text.
      const body = await res.text();
      try {
        const j = JSON.parse(body);
        onDelta(j.choices?.[0]?.message?.content || j.content || body);
      } catch { onDelta(body); }
      return;
    }
    await readLines(res.body, signal, (line) => {
      if (!line.startsWith('data:')) return;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') return;
      try {
        const j = JSON.parse(data);
        if (j.error) throw new Error(typeof j.error === 'string' ? j.error : j.error.message);
        const delta = j.choices?.[0]?.delta || {};
        if (delta.reasoning && !delta.content) onThinking?.();
        onDelta(delta.content || '');
      } catch (err) { if (!(err instanceof SyntaxError)) throw err; }
    });
  } else {
    const res = await fetch(settings.aiEndpoint + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify({ model, messages, stream: true, options: { temperature: 0.2 } })
    });
    if (!res.ok) throw new Error(`Ollama returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
    await readLines(res.body, signal, (line) => {
      try {
        const j = JSON.parse(line);
        if (j.error) throw new Error(j.error);
        onDelta(j.message?.content || '');
      } catch (err) { if (!(err instanceof SyntaxError)) throw err; }
    });
  }
}

async function readLines(body, signal, onLine) {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) onLine(line);
    }
  }
  if (buf.trim()) onLine(buf.trim());
}

async function aiSend(e) {
  e.preventDefault();
  const prompt = $('#aiPrompt').value.trim();
  if (!prompt || aiAbort) return;

  const model = $('#aiModelSelect').value || settings[aiModelKey()];
  if (!model) { aiEl('error', aiIsCloud() ? 'No model available. Press Retry.' : 'No model selected. Pull one in Ollama first.'); return; }

  $('#aiPrompt').value = '';
  $('#aiResult').hidden = true;
  aiEl('user', prompt);

  let userContent = prompt;
  const cur = current();
  if (cur && $('#aiCtx').checked) {
    userContent = `Current script (modify it if the request refers to it, otherwise write a new one):\n\`\`\`javascript\n${$('#code').value}\n\`\`\`\n\nRequest: ${prompt}`;
  }
  aiHistory.push({ role: 'user', content: userContent });

  const out = aiEl('assistant');
  renderAssistant(out, '', true);
  $('#aiSend').hidden = true;
  $('#aiStop').hidden = false;
  aiAbort = new AbortController();

  let text = '';
  try {
    let lastRender = 0;
    const messages = [{ role: 'system', content: AI_SYSTEM }, ...aiHistory.slice(-8)];
    const status = $('#aiStatus');
    const readyText = status.textContent;
    status.textContent = 'generating…';
    await aiStream(model, messages, aiAbort.signal, (delta) => {
      if (delta && status.textContent !== 'writing…') status.textContent = 'writing…';
      text += delta;
      if (Date.now() - lastRender > 80) { renderAssistant(out, text, true); lastRender = Date.now(); }
    }, () => { if (!text) status.textContent = 'thinking…'; });
    status.textContent = readyText;
    renderAssistant(out, text, false);
    aiHistory.push({ role: 'assistant', content: text });
    aiLastCode = extractCode(text);
    if (aiLastCode) {
      $('#aiResult').hidden = false;
      $('#aiUseReplace').hidden = !current();
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      renderAssistant(out, text || 'Stopped.', false);
    } else {
      out.remove();
      aiEl('error', err.message || String(err));
      aiHistory.pop();
    }
  } finally {
    aiAbort = null;
    $('#aiSend').hidden = false;
    $('#aiStop').hidden = true;
  }
}

function aiUseNew() {
  if (!aiLastCode) return;
  if (!confirmDiscard()) return;
  const s = buildScript(aiLastCode);
  s._unsaved = true;
  scripts.push(s);
  activeId = s.id;
  fillEditor(s);
  $('#home').hidden = true;
  $('#editor').hidden = false;
  renderList();
  setDirty(true);
  $('#aiCtxWrap').hidden = false;
  toast('Script opened in editor. Review it, then save.');
}

function aiUseReplace() {
  if (!aiLastCode || !current()) return;
  if (!confirm('Replace the editor content with the generated script?')) return;
  $('#code').value = aiLastCode;
  setDirty(true);
  updateGutter();
  updateCursor();
  runLint();
  toast('Editor updated. Review it, then save.');
}

$('#aiFab').addEventListener('click', () => aiToggle());
$('#aiClose').addEventListener('click', () => aiToggle(false));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#aiPanel').hidden) aiToggle(false);
});
$('#aiRetry').addEventListener('click', aiCheck);
$('#aiForm').addEventListener('submit', aiSend);
$('#aiStop').addEventListener('click', () => aiAbort?.abort());
$('#aiUseNew').addEventListener('click', aiUseNew);
$('#aiUseReplace').addEventListener('click', aiUseReplace);
$('#aiModelSelect').addEventListener('change', (e) => updateSetting(aiModelKey(), e.target.value));
$('#aiProviderSelect').addEventListener('change', (e) => updateSetting('aiProvider', e.target.value).then(aiCheck));
$('#aiPrompt').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#aiForm').requestSubmit(); }
});

// ---------- toast ----------

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 1800);
}

init();
