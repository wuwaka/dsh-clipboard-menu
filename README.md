# dsh-clipboard-menu

Adds a right-click **Cut / Copy / Paste / Select All** menu to DeepSeek Harness
composer inputs.

## Why

Electron ships no default context menu, and DSH Desktop's shell does not add
one, so right-clicking the composer does nothing. This plugin supplies the menu
in the renderer.

The desktop main process is a packaged bundle (`lib/main.js` +
`electron-runtime`), so a DSH plugin cannot hook `webContents` and pop a native
`Menu`. Hence the browser half.

## Install

```sh
dsh plugin --profile <profile> add github:wuwaka/dsh-clipboard-menu
```

Or from a local checkout:

```sh
dsh plugin --profile <profile> add /path/to/dsh-clipboard-menu
```

Restart the host (or the desktop app wrapping it) to load the new bundle.

## What it does

| Target | Paste path |
|---|---|
| `contenteditable` (the DSH composer is a Lexical editor) | dispatches a synthetic `ClipboardEvent('paste')` carrying a `DataTransfer`, which Lexical's own paste listener consumes; falls back to `execCommand('insertText')` |
| `<input>` / `<textarea>` (React-controlled) | writes through the native `value` setter and dispatches an `input` event |
| xterm | dispatches the same synthetic `paste` event |

Cut and copy use `document.execCommand('cut' | 'copy')` after restoring the
selection captured at right-click time (a `Range` for contenteditable, or
`selectionStart/End` for inputs). If copy fails it falls back to
`navigator.clipboard.writeText`.

The menu only intercepts right-clicks inside editable fields. Context menus the
app or other plugins provide (JSON copy buttons, sidebar previews) are left
untouched. Labels follow the document language (Chinese or English). Colours use
the system `Canvas` / `CanvasText` / `Highlight` palette so the menu matches
the active light or dark theme.

## Layout

```
package.json          dsh.bundle.patch + dsh.client manifest
cordis.patch.yml      inserts the host row
lib/index.js          host half (no-op)
lib/client.js         renderer half: listener + menu
test/smoke.cjs        jsdom smoke test
```

## Test

```sh
npm install --no-save jsdom
node test/smoke.cjs
```

Covers menu rendering, disabled state without a selection, textarea caret
insertion plus the `input` event, the synthetic paste event reaching a
`contenteditable` listener, and non-editable targets not being intercepted.

## Limitations

- If `navigator.clipboard.readText()` is denied, the menu reports that the
  clipboard is unavailable and suggests Ctrl+V.
- No "paste and match style" entry.

## License

MIT
