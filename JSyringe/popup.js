import { getScripts, saveScripts, scriptMatchesUrl, urlToSitePattern, setupApiNotice } from './lib/userscript.js';

const $ = (s) => document.querySelector(s);

let currentUrl = '';
let scripts = [];
let errors = {};
let ran = {};   // scriptId -> { name, time } for the current tab

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentUrl = tab?.url || '';
  try {
    const { injections = {} } = await chrome.storage.session.get('injections');
    ran = (tab && injections[tab.id] && injections[tab.id].scripts) || {};
  } catch { ran = {}; }

  try {
    const u = new URL(currentUrl);
    $('#siteHost').textContent = /^https?:$/.test(u.protocol) ? u.hostname : u.protocol.replace(':', '') + ' page';
  } catch {
    $('#siteHost').textContent = 'No site';
  }

  const store = await chrome.storage.local.get(['apiStatus', 'lastErrors', 'globalEnabled']);
  errors = store.lastErrors || {};
  $('#globalToggle').checked = store.globalEnabled !== false;
  await setupApiNotice(store.apiStatus);

  scripts = await getScripts();
  render();
}

function render() {
  const onSite = [];
  const others = [];
  for (const s of scripts) (currentUrl && scriptMatchesUrl(s, currentUrl) ? onSite : others).push(s);

  $('#countBadge').textContent = onSite.length;
  $('#othersBadge').textContent = others.length;
  $('#siteEmpty').hidden = onSite.length > 0;

  $('#siteList').replaceChildren(...onSite.map(itemEl));
  $('#othersList').replaceChildren(...others.map(itemEl));
}

function itemEl(s) {
  const li = document.createElement('li');
  li.className = 'item' + (s.enabled ? '' : ' disabled');

  const info = document.createElement('div');
  info.className = 'info';
  info.title = 'Open in editor';
  const name = document.createElement('div');
  name.className = 'name';
  name.textContent = s.name;
  const sub = document.createElement('div');
  sub.className = 'sub';
  const rules = [...(s.matches || []), ...(s.includes || [])];
  sub.textContent = (s.version ? 'v' + s.version + ' · ' : '') + (rules[0] || 'no match rules') + (rules.length > 1 ? ` +${rules.length - 1}` : '');
  info.append(name, sub);

  // Execution proof for the current tab.
  if (currentUrl && scriptMatchesUrl(s, currentUrl)) {
    const st = document.createElement('div');
    st.className = 'ran ' + (ran[s.id] ? 'yes' : 'no');
    if (ran[s.id]) {
      const secs = Math.max(0, Math.round((Date.now() - ran[s.id].time) / 1000));
      st.textContent = '✔ ran on this page ' + (secs < 5 ? 'just now' : secs < 120 ? secs + ' s ago' : Math.round(secs / 60) + ' min ago');
    } else {
      st.textContent = s.enabled ? '✕ has not run on this page (reload the tab)' : 'disabled';
    }
    info.append(st);
  }
  info.addEventListener('click', () => openDashboard(s.id));

  li.append(info);

  if (errors[s.id]) {
    const dot = document.createElement('span');
    dot.className = 'err-dot';
    dot.title = 'Failed to register: ' + errors[s.id];
    li.append(dot);
  }

  const sw = document.createElement('label');
  sw.className = 'switch';
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = !!s.enabled;
  cb.addEventListener('change', async () => {
    s.enabled = cb.checked;
    s.updatedAt = Date.now();
    li.classList.toggle('disabled', !s.enabled);
    await saveScripts(scripts);
  });
  const track = document.createElement('span');
  track.className = 'track';
  sw.append(cb, track);
  li.append(sw);
  return li;
}

function openDashboard(id, extra = {}) {
  const params = new URLSearchParams({ ...(id ? { id } : {}), ...extra });
  chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') + (params.size ? '?' + params : '') });
  window.close();
}

$('#openDashboard').addEventListener('click', () => openDashboard());
$('#newForSite').addEventListener('click', () => openDashboard(null, { new: '1', match: urlToSitePattern(currentUrl) }));

$('#othersHead').addEventListener('click', () => {
  const wrap = $('#othersHead').parentElement;
  const open = wrap.classList.toggle('open');
  $('#othersList').hidden = !open;
});

$('#globalToggle').addEventListener('change', async (e) => {
  await chrome.storage.local.set({ globalEnabled: e.target.checked });
  try { await chrome.runtime.sendMessage({ type: 'sync' }); } catch { /* storage listener handles it */ }
});

init();
