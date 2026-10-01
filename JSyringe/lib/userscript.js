// Shared helpers: userscript header parsing, URL matching, storage.
// Loaded by background (ES module), popup and dashboard.

export const DEFAULT_SETTINGS = {
  defaultRunAt: 'document-idle',
  defaultInjectInto: 'page',
  editorFontSize: 13,
  editorWrap: false,
  aiProvider: 'cloud',            // 'cloud' (free, no key) or 'ollama' (local)
  aiCloudEndpoint: 'https://text.pollinations.ai',
  aiCloudModel: 'openai-fast',
  aiEndpoint: 'http://localhost:11434',
  aiModel: 'qwen2.5-coder:7b'
};

export async function getSettings() {
  const { settings = {} } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...settings };
}

export async function saveSettings(settings) {
  await chrome.storage.local.set({ settings });
}

export const DEFAULT_TEMPLATE = (name, match, opts = {}) => `// ==UserScript==
// @name         ${name}
// @version      1.0
// @description  Describe what this script does
// @match        ${match}
// @run-at       ${opts.runAt || DEFAULT_SETTINGS.defaultRunAt}
// @inject-into  ${opts.injectInto || DEFAULT_SETTINGS.defaultInjectInto}
// ==/UserScript==

(function () {
  'use strict';

  console.log('[JSyringe] ${name} injected');

})();
`;

/** Parse a ==UserScript== header block into a metadata object. */
export function parseMetadata(code) {
  const meta = {
    name: '',
    version: '',
    description: '',
    matches: [],
    includes: [],
    excludes: [],
    runAt: 'document-idle',
    // Default to the page's own JS context, like Tampermonkey. Scripts that
    // patch fetch/XHR/JSON.parse (ad blockers etc.) only work there.
    world: 'MAIN'
  };
  const m = code.match(/\/\/\s*==UserScript==([\s\S]*?)\/\/\s*==\/UserScript==/);
  if (!m) return meta;

  for (const rawLine of m[1].split('\n')) {
    const line = rawLine.trim();
    const kv = line.match(/^\/\/\s*@([\w:-]+)\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1].toLowerCase();
    const value = kv[2].trim();
    switch (key) {
      case 'name': meta.name = value; break;
      case 'version': meta.version = value; break;
      case 'description': meta.description = value; break;
      case 'match': if (value) meta.matches.push(value); break;
      case 'include': if (value) meta.includes.push(value); break;
      case 'exclude':
      case 'exclude-match': if (value) meta.excludes.push(value); break;
      case 'run-at': meta.runAt = value.replace(/_/g, '-'); break;
      case 'inject-into':
        meta.world = ['content', 'isolated', 'user_script'].includes(value.toLowerCase()) ? 'USER_SCRIPT' : 'MAIN';
        break;
    }
  }
  return meta;
}

const MATCH_PATTERN_RE = /^(\*|https?|file|ftp):\/\/(\*|\*\.[^/*]+|[^/*]+)?(\/.*)$/;

/** True if the string is a valid Chrome match pattern. */
export function isMatchPattern(p) {
  if (p === '<all_urls>') return true;
  return MATCH_PATTERN_RE.test(p);
}

/** Convert a Chrome match pattern to a RegExp. */
export function matchPatternToRegExp(p) {
  if (p === '<all_urls>') return /^(https?|file|ftp):\/\//;
  const m = p.match(MATCH_PATTERN_RE);
  if (!m) return null;
  const [, scheme, host = '', path] = m;
  const schemeRe = scheme === '*' ? 'https?' : scheme;
  let hostRe;
  if (host === '*') hostRe = '[^/]*';
  else if (host.startsWith('*.')) hostRe = '(?:[^/]+\\.)?' + escapeRe(host.slice(2));
  else hostRe = escapeRe(host);
  const pathRe = path.split('*').map(escapeRe).join('.*');
  return new RegExp(`^${schemeRe}://${hostRe}${pathRe}$`);
}

/** Convert a Greasemonkey-style @include glob (or /regex/) to a RegExp. */
export function globToRegExp(g) {
  if (g.length > 2 && g.startsWith('/') && g.endsWith('/')) {
    try { return new RegExp(g.slice(1, -1)); } catch { return null; }
  }
  return new RegExp('^' + g.split('*').map(escapeRe).join('.*') + '$');
}

function escapeRe(s) {
  return s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

/** Does this script apply to the given URL? */
export function scriptMatchesUrl(script, url) {
  const rules = [...(script.matches || []), ...(script.includes || [])];
  if (!rules.length) return false;
  const excluded = (script.excludes || []).some((r) => testRule(r, url));
  if (excluded) return false;
  return rules.some((r) => testRule(r, url));
}

function testRule(rule, url) {
  const re = isMatchPattern(rule) ? matchPatternToRegExp(rule) : globToRegExp(rule);
  return re ? re.test(url) : false;
}

/** Turn a URL into a sensible default @match pattern for the site. */
export function urlToSitePattern(url) {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return '*://*/*';
    return `${u.protocol}//${u.hostname}/*`;
  } catch {
    return '*://*/*';
  }
}

export function uid() {
  return 'js_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

// ---------- permissions (Firefox) ----------

/** True when userScripts is an optional permission (Firefox MV3). */
export function needsRuntimePermission() {
  const m = chrome.runtime.getManifest();
  return Array.isArray(m.optional_permissions) && m.optional_permissions.includes('userScripts');
}

/**
 * Wire the "API unavailable" notice. Shows the Chrome instructions or, on
 * Firefox, a button that requests the userScripts + host permissions.
 */
export async function setupApiNotice(apiStatus) {
  const notice = document.getElementById('apiNotice');
  const chromeMsg = document.getElementById('apiNoticeChrome');
  const ffMsg = document.getElementById('apiNoticeFirefox');
  const btn = document.getElementById('grantBtn');
  if (!notice) return;

  const firefox = needsRuntimePermission();
  let available = !!chrome.userScripts && apiStatus !== 'unavailable';
  if (firefox && chrome.permissions?.contains) {
    try {
      available = await chrome.permissions.contains({ permissions: ['userScripts'], origins: ['<all_urls>'] });
    } catch { /* keep computed value */ }
  }

  notice.hidden = available;
  chromeMsg.hidden = firefox;
  ffMsg.hidden = !firefox;

  // Chrome: offer a one-click jump to this extension's settings page, where the
  // "Allow User Scripts" switch lives.
  if (!firefox && !available && !chromeMsg.querySelector('button')) {
    const b = document.createElement('button');
    b.className = 'btn primary sm';
    b.style.marginTop = '8px';
    b.textContent = 'Open extension settings';
    b.addEventListener('click', () => {
      chrome.tabs.create({ url: 'chrome://extensions/?id=' + chrome.runtime.id });
    });
    chromeMsg.append(document.createElement('br'), b);
  }

  btn?.addEventListener('click', async () => {
    try {
      const ok = await chrome.permissions.request({ permissions: ['userScripts'], origins: ['<all_urls>'] });
      if (ok) {
        // Firefox exposes the userScripts namespace only after a restart of the extension.
        chrome.runtime.reload();
      }
    } catch (e) {
      alert('Permission request failed: ' + (e.message || e));
    }
  });
}

// ---------- storage ----------

export async function getScripts() {
  const { scripts = [] } = await chrome.storage.local.get('scripts');
  return scripts;
}

export async function saveScripts(scripts) {
  // Never persist scripts that were created in the editor but not saved yet.
  await chrome.storage.local.set({ scripts: scripts.filter((s) => !s._unsaved) });
}

/** Build a script record from raw source code. */
export function buildScript(code, existing = {}) {
  const meta = parseMetadata(code);
  return {
    id: existing.id || uid(),
    enabled: existing.enabled ?? true,
    createdAt: existing.createdAt || Date.now(),
    updatedAt: Date.now(),
    code,
    name: meta.name || existing.name || 'Untitled script',
    version: meta.version,
    description: meta.description,
    matches: meta.matches,
    includes: meta.includes,
    excludes: meta.excludes,
    runAt: meta.runAt,
    world: meta.world
  };
}
