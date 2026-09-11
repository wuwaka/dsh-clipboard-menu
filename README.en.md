
<div align="center">

<img src="assets/poster.jpg" width="620" alt="dsh-clipboard-menu — a right-click clipboard menu for DeepSeek Harness">

**The right-click menu the DeepSeek Harness composer was missing**

[简体中文](README.md) | [English](README.en.md)

[![license](https://img.shields.io/badge/license-MIT-yellow.svg?style=flat-square)](LICENSE)
[![stars](https://img.shields.io/github/stars/wuwaka/dsh-clipboard-menu?style=flat-square)](https://github.com/wuwaka/dsh-clipboard-menu/stargazers)
[![topic](https://img.shields.io/badge/topic-dsh--plugin-4d6bfe?style=flat-square)](https://github.com/topics/dsh-plugin)
[![tested](https://img.shields.io/badge/tested%20on-DSH%200.1.5--rc.1-4d6bfe?style=flat-square)](#)

</div>

## What it is

Right-click the DeepSeek Harness composer and get a menu:

<img src="assets/preview.png" width="620" alt="the menu that opens on right-click: Cut / Copy / Paste / Select All">

| Item | Action |
| --- | --- |
| ✂️ Cut | Cut the selected text |
| 📋 Copy | Copy the selected text |
| 📥 Paste | Insert the system clipboard at the caret |
| 🗂️ Select All | Select the whole field |

Select text in a **read-only** surface — an AI reply, a document preview, a code block — and right-click for the two copy entries:

| Item | Action |
| --- | --- |
| 📋 Copy | Copy with formatting (paste into Word and the styling comes along) |
| 📝 Copy as plain text | Copy the characters only, which pastes cleanly into a terminal or editor |

Cut and Copy grey out when nothing is selected, and a right-click on read-only content with no selection is passed straight through to the app's own menu. Labels follow the interface language (Chinese / English); colours follow the system light or dark theme.

## Why it exists

**Electron ships no default context menu**, and the DSH Desktop shell does not add one, so right-clicking the composer in the desktop window does nothing — you are stuck with `Ctrl+C` / `Ctrl+V`.

The desktop main process is a packaged bundle (`lib/main.js` + `electron-runtime`), so a plugin cannot hook `webContents`. The menu is therefore built in the renderer.

## 🚀 Install

```sh
dsh plugin --profile <profile> add github:wuwaka/dsh-clipboard-menu
```

From a local checkout:

```sh
dsh plugin --profile <profile> add /path/to/dsh-clipboard-menu
```

Restart the host (or the desktop app wrapping it) to load it.

## 🔒 Scope

**It only activates in shells that have no context menu of their own.**

A normal browser tab already has a native menu that does more (paste and match style, search, inspect), so the plugin **does not install its listener there at all** — right-click keeps behaving exactly as the browser intends, rather than being downgraded.

Detection:

| Signal | Source |
| --- | --- |
| `dsh-desktop-mode` and friends (URL) | markers DSH Desktop stamps onto the renderer URL |
| `window.__DSH_DESKTOP_FILE_PATH__` | DSH Desktop's preload bridge |
| User-Agent containing `Electron/` | other Electron shells |
| `__TAURI__` / `__TAURI_INTERNALS__` | Tauri shells |

None of them (a plain browser) means it stays inert. To use the menu in a browser on purpose, set this before the plugin loads:

```js
window.__DSH_CLIPBOARD_MENU_FORCE__ = true
```

## ⚙️ How it works

The DSH composer is a **Lexical editor** (a `contenteditable` root), so pasting cannot go through a plain value setter. Three insertion paths are used:

| Target | Paste path |
| --- | --- |
| `contenteditable` (the Lexical editor) | dispatches a synthetic `ClipboardEvent('paste')` with a `DataTransfer`, consumed by Lexical's own paste listener; falls back to `execCommand('insertText')` |
| `<input>` / `<textarea>` (React-controlled) | writes through the native `value` setter and dispatches an `input` event |
| xterm | dispatches the same synthetic `paste` event |

Cut and copy use `document.execCommand('cut' | 'copy')` after restoring the selection captured at right-click time (a `Range` for contenteditable, `selectionStart/End` for inputs). If copy fails it falls back to `navigator.clipboard.writeText`.

Exactly two cases are intercepted: editable fields (the full menu) and read-only content with a selection (the two copy entries). Everything else is passed through, so context menus the app or other plugins provide (JSON copy buttons, sidebar previews) keep working.

## 🧪 Test

```sh
npm install --no-save jsdom
node test/smoke.cjs
```

21 assertions: menu rendering, cut/copy disabled without a selection, textarea caret insertion plus the `input` event, the synthetic paste event reaching a `contenteditable` listener, read-only text without a selection not being intercepted, Copy and Copy-as-plain-text on a read-only selection, Copy not stealing focus, the menu staying uninstalled in a browser, and the force flag opting back in.

## ⚠️ Limitations

- If `navigator.clipboard.readText()` is denied, the menu reports that the clipboard is unavailable and suggests `Ctrl+V`.
- No "paste and match style" entry.

## 📄 License

[MIT](LICENSE)
