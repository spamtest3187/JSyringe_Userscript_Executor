// Finds lines that will not work: JavaScript syntax errors (via Acorn) and
// invalid userscript header values. Returns [{ line, message }] (1-based lines).

import { Parser } from './acorn.mjs';
import { isMatchPattern } from './userscript.js';

const RUN_AT = new Set(['document-start', 'document-end', 'document-idle', 'document_start', 'document_end', 'document_idle']);

export function lint(code) {
  const problems = [];

  // --- header checks ---
  const lines = code.split('\n');
  let inHeader = false;
  let sawHeader = false;
  let hasRule = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (/^\/\/\s*==UserScript==/.test(line)) { inHeader = true; sawHeader = true; continue; }
    if (/^\/\/\s*==\/UserScript==/.test(line)) { inHeader = false; continue; }
    if (!inHeader) continue;
    const kv = line.match(/^\/\/\s*@([\w:-]+)\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1].toLowerCase();
    const value = kv[2].trim();
    switch (key) {
      case 'match':
      case 'exclude-match':
        if (!value) problems.push({ line: i + 1, message: `@${key} needs a URL pattern` });
        else if (!isMatchPattern(value)) problems.push({ line: i + 1, message: `Invalid match pattern "${value}". Example: *://*.example.com/*` });
        else if (key === 'match') hasRule = true;
        break;
      case 'include':
        if (!value) problems.push({ line: i + 1, message: '@include needs a URL glob or /regex/' });
        else hasRule = true;
        if (value.length > 2 && value.startsWith('/') && value.endsWith('/')) {
          try { new RegExp(value.slice(1, -1)); } catch (e) { problems.push({ line: i + 1, message: `Invalid regex: ${e.message}` }); }
        }
        break;
      case 'exclude':
        if (value.length > 2 && value.startsWith('/') && value.endsWith('/')) {
          try { new RegExp(value.slice(1, -1)); } catch (e) { problems.push({ line: i + 1, message: `Invalid regex: ${e.message}` }); }
        }
        break;
      case 'run-at':
        if (!RUN_AT.has(value)) problems.push({ line: i + 1, message: `Unknown @run-at "${value}". Use document-start, document-end or document-idle` });
        break;
      case 'inject-into':
        if (!['page', 'main', 'content', 'isolated', 'user_script', 'auto'].includes(value.toLowerCase())) {
          problems.push({ line: i + 1, message: `Unknown @inject-into "${value}". Use page or isolated` });
        }
        break;
      case 'require':
      case 'resource':
        problems.push({ line: i + 1, message: `@${key} is not supported by JSyringe; inline the code instead` });
        break;
    }
  }
  if (sawHeader && !hasRule) {
    const hl = lines.findIndex((l) => /^\/\/\s*==UserScript==/.test(l.trim()));
    problems.push({ line: hl + 1, message: 'No @match or @include: this script will never run' });
  }
  if (inHeader) {
    problems.push({ line: 1, message: 'Header is not closed with // ==/UserScript==' });
  }

  // --- syntax check ---
  try {
    Parser.parse(code, {
      ecmaVersion: 'latest',
      sourceType: 'script',
      allowReturnOutsideFunction: true,
      allowAwaitOutsideFunction: true,
      allowHashBang: true,
      locations: false
    });
  } catch (e) {
    if (e.loc) {
      problems.push({ line: e.loc.line, message: e.message.replace(/\s*\(\d+:\d+\)$/, '') });
    } else {
      problems.push({ line: 1, message: e.message });
    }
  }

  return problems.sort((a, b) => a.line - b.line);
}
