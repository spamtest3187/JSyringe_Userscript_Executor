import {
  getScripts,
  isMatchPattern,
  globToRegExp,
  matchPatternToRegExp,
  parseMetadata
} from './lib/userscript.js';

// Small runtime shim prepended to every injected script.
// Provides a few Greasemonkey-style helpers so common scripts just work.
function buildShim(script) {
  const info = JSON.stringify({
    script: { name: script.name, version: script.version, description: script.description },
    scriptHandler: 'JSyringe',
    version: chrome.runtime.getManifest().version
  });
  return `
const GM_info = ${info};
const unsafeWindow = window;
try { console.log('%cJSyringe%c ' + GM_info.script.name + ' injected (' + ${JSON.stringify(script.world === 'MAIN' ? 'page world' : 'isolated world')} + ', ' + ${JSON.stringify(script.runAt || 'document-idle')} + ')', 'background:#d90000;color:#fff;padding:1px 6px;border-radius:4px;font-weight:600', ''); } catch {}
function GM_addStyle(css) {
  const s = document.createElement('style');
  s.textContent = css;
  (document.head || document.documentElement).appendChild(s);
  return s;
}
function GM_getValue(k, d) {
  try { const v = localStorage.getItem('__jsyringe_' + k); return v === null ? d : JSON.parse(v); } catch { return d; }
}
function GM_setValue(k, v) { try { localStorage.setItem('__jsyringe_' + k, JSON.stringify(v)); } catch {} }
function GM_deleteValue(k) { try { localStorage.removeItem('__jsyringe_' + k); } catch {} }
function GM_log(...a) { console.log('[JSyringe]', ...a); }
const GM = { info: GM_info, addStyle: GM_addStyle, getValue: async (k, d) => GM_getValue(k, d),
  setValue: async (k, v) => GM_setValue(k, v), deleteValue: async (k) => GM_deleteValue(k), log: GM_log };
`;
}

// Build a runtime URL guard for glob-style @include / @exclude rules that
// cannot be expressed as Chrome match patterns. `includeRules` holds regex
// sources for every include rule (patterns + globs); when non-empty the
// script is registered on all URLs and this guard decides at runtime.
function buildGuard(includeRules, excludeGlobs) {
  if (!includeRules.length && !excludeGlobs.length) return '';
  const toSrc = (r) => (r ? [r.source, r.flags] : null);
  const inc = JSON.stringify(includeRules.map(toSrc).filter(Boolean));
  const exc = JSON.stringify(excludeGlobs.map((g) => toSrc(globToRegExp(g))).filter(Boolean));
  return `
{
  const __inc = ${inc}.map(([s,f]) => new RegExp(s,f));
  const __exc = ${exc}.map(([s,f]) => new RegExp(s,f));
  const __u = location.href;
  if (__exc.some(r => r.test(__u))) return;
  if (__inc.length && !__inc.some(r => r.test(__u))) return;
}
`;
}

function toRegistration(script) {
  let matches = [];
  const includeGlobs = [];
  for (const r of [...(script.matches || []), ...(script.includes || [])]) {
    if (isMatchPattern(r)) matches.push(r); else includeGlobs.push(r);
  }
  const excludeMatches = [];
  const excludeGlobs = [];
  for (const r of script.excludes || []) {
    if (isMatchPattern(r)) excludeMatches.push(r); else excludeGlobs.push(r);
  }
  if (!matches.length && !includeGlobs.length) return null;

  // Globs can't be handled by Chrome, so fall back to matching every URL and
  // let the runtime guard check both the real patterns and the globs.
  let includeRules = [];
  if (includeGlobs.length) {
    includeRules = [
      ...matches.map(matchPatternToRegExp),
      ...includeGlobs.map(globToRegExp)
    ].filter(Boolean);
    matches = ['*://*/*'];
  }

  const runAt = { 'document-start': 'document_start', 'document-end': 'document_end' }[script.runAt] || 'document_idle';

  const code = `(function(){\n${buildGuard(includeRules, excludeGlobs)}${buildShim(script)}\n${script.code}\n})();`;

  return {
    id: script.id,
    matches,
    excludeMatches: excludeMatches.length ? excludeMatches : undefined,
    js: [{ code }],
    runAt,
    world: script.world === 'MAIN' ? 'MAIN' : 'USER_SCRIPT',
    allFrames: false
  };
}

let syncing = Promise.resolve();

/** Re-register every enabled script with chrome.userScripts. */
function syncScripts() {
  syncing = syncing.then(async () => {
    if (!chrome.userScripts) {
      await chrome.storage.local.set({ apiStatus: 'unavailable', lastErrors: {} });
      return;
    }
    const scripts = await getScripts();
    const { globalEnabled = true } = await chrome.storage.local.get('globalEnabled');
    const errors = {};
    try {
      await chrome.userScripts.unregister();
    } catch (e) {
      console.warn('unregister failed', e);
    }
    for (const stored of globalEnabled ? scripts.filter((x) => x.enabled) : []) {
      // Always derive match rules, run time and world from the current header so
      // scripts saved by older versions pick up new defaults.
      const s = { ...stored, ...parseMetadata(stored.code), name: stored.name, id: stored.id, code: stored.code };
      const reg = toRegistration(s);
      if (!reg) { errors[s.id] = 'No @match or @include rules'; continue; }
      try {
        await chrome.userScripts.register([reg]);
      } catch (e) {
        errors[s.id] = e.message || String(e);
        console.warn('register failed for', s.name, e);
      }
    }
    await chrome.storage.local.set({ apiStatus: 'ok', lastErrors: errors });
    await updateBadge(globalEnabled);
  }).catch((e) => console.error('sync error', e));
  return syncing;
}

/** Show "OFF" on the toolbar icon while the master switch is off. */
async function updateBadge(globalEnabled) {
  try {
    await chrome.action.setBadgeText({ text: globalEnabled ? '' : 'OFF' });
    await chrome.action.setBadgeBackgroundColor({ color: '#d90000' });
    if (chrome.action.setBadgeTextColor) await chrome.action.setBadgeTextColor({ color: '#ffffff' });
  } catch (e) {
    console.warn('badge update failed', e);
  }
}

chrome.runtime.onInstalled.addListener(syncScripts);
chrome.runtime.onStartup.addListener(syncScripts);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.scripts || changes.globalEnabled) syncScripts();
});

chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  if (msg?.type === 'sync') {
    syncScripts().then(() => respond({ ok: true }));
    return true;
  }
});
