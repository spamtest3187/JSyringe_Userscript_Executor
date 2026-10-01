// Small JavaScript syntax highlighter producing HTML with VS Code-like token classes.
// No dependencies; good enough for userscripts. Returns escaped HTML.

const KEYWORDS = new Set(('async await break case catch class const continue debugger default delete do else enum export extends ' +
  'finally for function if import in instanceof let new of return static super switch this throw try typeof var void while with yield get set').split(' '));
const CONTROL = new Set('if else for while do switch case default break continue return throw try catch finally yield await import export from as of'.split(' '));
const LITERALS = new Set(['true', 'false', 'null', 'undefined', 'NaN', 'Infinity']);
const BUILTINS = new Set(('console document window globalThis Math JSON Object Array String Number Boolean Promise Date RegExp Map Set WeakMap WeakSet Symbol ' +
  'Error TypeError MutationObserver IntersectionObserver ResizeObserver setTimeout setInterval clearTimeout clearInterval requestAnimationFrame fetch ' +
  'localStorage sessionStorage location navigator history Element Node HTMLElement Event CustomEvent XMLHttpRequest URL URLSearchParams FormData ' +
  'parseInt parseFloat isNaN encodeURIComponent decodeURIComponent alert confirm prompt ' +
  'GM_addStyle GM_getValue GM_setValue GM_deleteValue GM_log GM_info GM unsafeWindow').split(' '));

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const span = (cls, text) => `<span class="tk-${cls}">${esc(text)}</span>`;

function commentHtml(text) {
  // Highlight userscript header keys inside comments.
  return esc(text)
    .replace(/(==\/?UserScript==)/g, '<span class="tk-meta-block">$1</span>')
    .replace(/(@[\w:-]+)/g, '<span class="tk-meta-key">$1</span>');
}

export function highlight(code) {
  let out = '';
  let i = 0;
  const n = code.length;
  let lastSig = ''; // last significant token type, for regex detection

  const isIdStart = (c) => /[A-Za-z_$ -￿]/.test(c);
  const isId = (c) => /[\w$ -￿]/.test(c);

  while (i < n) {
    const c = code[i];
    const c2 = code[i + 1];

    // whitespace
    if (/\s/.test(c)) {
      let j = i;
      while (j < n && /\s/.test(code[j])) j++;
      out += esc(code.slice(i, j));
      i = j;
      continue;
    }

    // line comment
    if (c === '/' && c2 === '/') {
      let j = code.indexOf('\n', i);
      if (j < 0) j = n;
      out += `<span class="tk-comment">${commentHtml(code.slice(i, j))}</span>`;
      i = j;
      continue;
    }

    // block comment
    if (c === '/' && c2 === '*') {
      let j = code.indexOf('*/', i + 2);
      j = j < 0 ? n : j + 2;
      out += `<span class="tk-comment">${commentHtml(code.slice(i, j))}</span>`;
      i = j;
      continue;
    }

    // strings
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && code[j] !== c && code[j] !== '\n') { if (code[j] === '\\') j++; j++; }
      j = Math.min(n, j + 1);
      out += span('string', code.slice(i, j));
      i = j; lastSig = 'value';
      continue;
    }

    // template literal (with ${} highlighted recursively)
    if (c === '`') {
      let j = i + 1;
      let html = span('string', '`');
      let seg = i + 1;
      while (j < n && code[j] !== '`') {
        if (code[j] === '\\') { j += 2; continue; }
        if (code[j] === '$' && code[j + 1] === '{') {
          html += span('string', code.slice(seg, j));
          let depth = 1, k = j + 2;
          while (k < n && depth) { if (code[k] === '{') depth++; else if (code[k] === '}') depth--; k++; }
          html += span('punct', '${') + highlight(code.slice(j + 2, k - 1)) + span('punct', '}');
          j = k; seg = k;
          continue;
        }
        j++;
      }
      html += span('string', code.slice(seg, j));
      if (j < n) { html += span('string', '`'); j++; }
      out += html;
      i = j; lastSig = 'value';
      continue;
    }

    // numbers
    if (/\d/.test(c) || (c === '.' && /\d/.test(c2 || ''))) {
      const m = code.slice(i).match(/^(0[xX][\da-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|\d[\d_]*(\.[\d_]*)?([eE][+-]?\d+)?|\.\d[\d_]*([eE][+-]?\d+)?)n?/);
      const t = m ? m[0] : c;
      out += span('number', t);
      i += t.length; lastSig = 'value';
      continue;
    }

    // identifiers / keywords
    if (isIdStart(c)) {
      let j = i + 1;
      while (j < n && isId(code[j])) j++;
      const word = code.slice(i, j);
      let k = j;
      while (k < n && (code[k] === ' ' || code[k] === '\t')) k++;
      const next = code[k];
      // previous significant char
      let p = i - 1;
      while (p >= 0 && (code[p] === ' ' || code[p] === '\t')) p--;
      const prev = code[p];

      let cls;
      if (prev === '.' && !KEYWORDS.has(word)) cls = next === '(' ? 'function' : 'property';
      else if (CONTROL.has(word)) cls = 'control';
      else if (KEYWORDS.has(word)) cls = 'keyword';
      else if (LITERALS.has(word)) cls = 'literal';
      else if (BUILTINS.has(word)) cls = 'builtin';
      else if (next === '(') cls = 'function';
      else if (/^[A-Z]/.test(word)) cls = 'type';
      else cls = 'variable';
      out += span(cls, word);
      i = j;
      lastSig = (KEYWORDS.has(word) && !['this', 'super'].includes(word)) ? 'keyword' : 'value';
      continue;
    }

    // regex literal
    if (c === '/' && lastSig !== 'value') {
      let j = i + 1, inClass = false, ok = false;
      while (j < n && code[j] !== '\n') {
        const ch = code[j];
        if (ch === '\\') { j += 2; continue; }
        if (ch === '[') inClass = true;
        else if (ch === ']') inClass = false;
        else if (ch === '/' && !inClass) { ok = true; break; }
        j++;
      }
      if (ok) {
        j++;
        while (j < n && /[a-z]/i.test(code[j])) j++;
        out += span('regex', code.slice(i, j));
        i = j; lastSig = 'value';
        continue;
      }
    }

    // punctuation / operators
    if (/[()[\]{}]/.test(c)) {
      out += span('punct', c);
      lastSig = (c === ')' || c === ']' || c === '}') ? 'value' : 'op';
      i++;
      continue;
    }
    const opm = code.slice(i).match(/^(=>|\.\.\.|\?\?=|\?\.|\|\|=|&&=|\*\*=|===|!==|<<=|>>>=|>>=|\+\+|--|\+=|-=|\*=|\/=|%=|&=|\|=|\^=|==|!=|<=|>=|&&|\|\||\?\?|\*\*|<<|>>>|>>|[-+*/%=<>!&|^~?:;,.])/);
    if (opm) {
      out += span('op', opm[0]);
      i += opm[0].length; lastSig = 'op';
      continue;
    }

    out += esc(c);
    i++;
  }
  return out;
}
