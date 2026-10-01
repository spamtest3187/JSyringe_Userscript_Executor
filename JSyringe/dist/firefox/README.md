# JSyringe

A lightweight userscript manager for Chrome. Inject your own JavaScript into any website, Tampermonkey-style.

## Install (unpacked)

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this folder.
4. On the JSyringe card, turn on **Allow User Scripts** (Chrome 138+). On older Chrome, Developer mode alone is enough.
5. Click the reload icon on the JSyringe card once so it picks up the permission.

The extension uses Chrome's `chrome.userScripts` API, which is the only supported way to run arbitrary user code on pages under Manifest V3. It requires Chrome 120 or newer.

## Install in Firefox (136 or newer)

Firefox needs a slightly different manifest (no service worker, `userScripts` as an optional permission). Build it once:

```powershell
powershell -ExecutionPolicy Bypass -File .\build-firefox.ps1
```

This creates `dist\firefox` and `dist\jsyringe-firefox.zip`.

Temporary install (resets when Firefox closes):

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…** and select `dist\firefox\manifest.json`.
3. Click the JSyringe toolbar icon and press **Enable user scripts**. Accept the permission prompt. The extension restarts itself.

Permanent install: Firefox only installs signed add-ons, so either upload the zip to https://addons.mozilla.org/developers/ for a free "self-distribution" signature, or use Firefox Developer Edition / Nightly and set `xpinstall.signatures.required` to `false` in `about:config`, then open the zip via `about:addons` → gear icon → **Install Add-on From File…**.

## Usage

- Click the toolbar icon to see which scripts apply to the current page and toggle them.
- **New script for this site** creates a script pre-filled with a `@match` for the current host.
- **Dashboard** opens the full editor: create, edit, enable/disable, delete, import (`.user.js` file or URL) and export.
- `Ctrl+S` saves in the editor. Saving re-registers the script immediately; reload the page to see it run.

## AI assistant (no API key)

The dashboard has an AI button in the bottom-right corner that writes userscripts from a plain-text description. Two providers are available, switchable in the panel or under Settings:

**Cloud (default, nothing to install)** uses [Pollinations.ai](https://pollinations.ai), a free public gateway to open-weight models (currently GPT-OSS 20B on the anonymous tier). No account or API key is required. Your prompt, and your current script if the context box is ticked, are sent to that service, so do not paste secrets. Free tiers can be rate-limited or change their model list; the panel always shows what is available right now. Any other OpenAI-compatible endpoint that works without a key can be entered as the cloud endpoint.

**Local (Ollama)** keeps everything on your machine:

1. Install Ollama from https://ollama.com and start it.
2. Pull a coding model once, for example `ollama pull qwen2.5-coder:7b`.
3. Switch the provider to Local.

Ollama allows browser-extension origins by default; if you changed `OLLAMA_ORIGINS`, make sure it includes `chrome-extension://*` (or `moz-extension://*` on Firefox).

**Using it**: click the AI button, describe the script, and press Enter. "Open as new script" loads the result into the editor for review; "Replace editor content" is available while editing an existing script, and the context checkbox sends the current code so you can ask for changes.

## Script format

```js
// ==UserScript==
// @name         Example
// @version      1.0
// @description  Does something useful
// @match        https://example.com/*
// @exclude      https://example.com/admin/*
// @run-at       document-idle
// @inject-into  page
// ==/UserScript==

(function () {
  'use strict';
  GM_addStyle('body { background: #f4f9ff !important; }');
})();
```

Supported header keys:

| Key | Notes |
| --- | --- |
| `@match` | Chrome match patterns, e.g. `*://*.example.com/*` |
| `@include` | Greasemonkey globs (`https://*.example.com/*foo*`) or `/regex/` |
| `@exclude` / `@exclude-match` | Same forms as above |
| `@run-at` | `document-start`, `document-end`, `document-idle` (default) |
| `@inject-into` | `page` (default, like Tampermonkey) runs in the page's own JS context; `content` or `isolated` runs in a separate world |

Every injected script logs a red **JSyringe** tag with its name to the page console (F12), so you can confirm it ran. The dashboard home page has a Diagnostics section that shows whether the user script API is enabled and which scripts the browser currently has registered.

Available helpers: `GM_info`, `GM_addStyle`, `GM_getValue`, `GM_setValue`, `GM_deleteValue`, `GM_log`, `unsafeWindow`, and a promise-based `GM.*` object with the same functions. Values are stored in the page's `localStorage`.

## Files

| File | Purpose |
| --- | --- |
| `manifest.json` | Manifest V3 definition |
| `background.js` | Service worker; registers scripts with `chrome.userScripts` |
| `lib/userscript.js` | Header parsing, URL matching, storage helpers |
| `lib/highlight.js` | Syntax highlighter for the editor (VS Code Light+ colours) |
| `lib/lint.js` | Marks lines that won't work: syntax errors via Acorn, invalid header values |
| `lib/acorn.mjs` | [Acorn](https://github.com/acornjs/acorn) JavaScript parser (MIT), bundled locally |
| `popup.html/css/js` | Toolbar popup |
| `dashboard.html/css/js` | Script manager and editor |
| `theme.css` | Shared white / red design tokens |
| `icons/logo.png` | Full logo artwork; the `icon*.png` files are a crop of the syringe |
