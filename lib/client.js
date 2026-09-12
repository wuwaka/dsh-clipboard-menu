window.__ModuleLoader__.load({ id: "dsh-clipboard-menu", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
"use strict";

/*
 * dsh-clipboard-menu — browser half.
 *
 * Electron ships no default context menu, and DSH Desktop's shell does not
 * implement one, so a right-click inside the composer does nothing. This
 * module installs a capture-phase contextmenu listener and renders its own
 * menu with Cut / Copy / Paste / Select All.
 *
 * Scope: desktop shells only. A normal browser already has a native menu that
 * does more than this one, so replacing it there would be a downgrade. The
 * listener is not installed at all unless the host looks like a shell without
 * a platform menu (see hasNativeContextMenu below).
 *
 * The DSH composer is a Lexical editor (a contenteditable root), so pasting
 * cannot go through a plain value setter. Two insertion paths are used:
 *   1. contenteditable / xterm -> synthesise a real "paste" ClipboardEvent,
 *      because those widgets install their own paste listeners;
 *   2. plain input / textarea -> native value setter + an "input" event, the
 *      React-compatible way to update a controlled field.
 */

var MENU_ATTR = "data-dsh-clipboard-menu";
var STYLE_ID = "dsh-clipboard-menu-style";

/**
 * Pages cannot read the browser's own default search engine — no web API
 * exposes it. So the engine is remembered here once the operator picks one,
 * and the very first guess follows the UI language.
 */
var ENGINE_KEY = "dsh-clipboard-menu.engine";
var ENGINES = [
  { id: "baidu", name: "\u767e\u5ea6", url: "https://www.baidu.com/s?wd=" },
  { id: "bing", name: "Bing", url: "https://www.bing.com/search?q=" },
  { id: "google", name: "Google", url: "https://www.google.com/search?q=" },
  { id: "duckduckgo", name: "DuckDuckGo", url: "https://duckduckgo.com/?q=" }
];
var FALLBACK_ENGINE = ENGINES[1];

var CUSTOM_KEY = "dsh-clipboard-menu.custom";
var CUSTOM_NAME_KEY = "dsh-clipboard-menu.customName";

function readStoredEngine() {
  try { return window.localStorage.getItem(ENGINE_KEY) || ""; } catch (e) { return ""; }
}
function storeEngine(id) {
  try { window.localStorage.setItem(ENGINE_KEY, id); } catch (e) {}
}
function readCustomTemplate() {
  try { return window.localStorage.getItem(CUSTOM_KEY) || ""; } catch (e) { return ""; }
}
function storeCustomTemplate(template) {
  try { window.localStorage.setItem(CUSTOM_KEY, template); } catch (e) {}
}
function readCustomName() {
  try { return window.localStorage.getItem(CUSTOM_NAME_KEY) || ""; } catch (e) { return ""; }
}
function storeCustomName(name) {
  try { window.localStorage.setItem(CUSTOM_NAME_KEY, name); } catch (e) {}
}
/** A readable label for a URL template: its host, minus "www.". */
function engineNameFromUrl(template) {
  try {
    var probe = template.indexOf("{query}") >= 0 ? template.split("{query}").join("q") : template;
    return new URL(probe).hostname.replace(/^www\./, "");
  } catch (e) {
    return "";
  }
}
/** Build the search URL; {query} is substituted, otherwise the query is appended. */
function searchWith(engine, q) {
  var encoded = encodeURIComponent(q);
  return engine.url.indexOf("{query}") >= 0
    ? engine.url.split("{query}").join(encoded)
    : engine.url + encoded;
}
function langCode() {
  return String(document.documentElement.getAttribute("lang") || navigator.language || "en").toLowerCase();
}
function findEngine(id) {
  for (var i = 0; i < ENGINES.length; i++) if (ENGINES[i].id === id) return ENGINES[i];
  return null;
}
/** Explicit override > remembered choice > language guess. */
function currentEngine() {
  var override = window.__DSH_CLIPBOARD_MENU_SEARCH__;
  if (typeof override === "string" && override) return { id: "override", name: labels().custom, url: override };
  var stored = readStoredEngine();
  if (stored === "custom") {
    var template = readCustomTemplate();
    if (template) return { id: "custom", name: readCustomName() || engineNameFromUrl(template) || labels().custom, url: template };
  }
  return findEngine(stored) || findEngine(langCode().indexOf("zh") === 0 ? "baidu" : "google") || FALLBACK_ENGINE;
}

/** Wrap path data in a 24x24 outline that inherits the menu's text colour. */
function icon(paths) {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"' +
         ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + paths + '</svg>';
}
var ICONS = {
  cut: icon('<circle cx="6" cy="6" r="3"/><path d="M8.12 8.12 12 12"/><path d="M20 4 8.12 15.88"/><circle cx="6" cy="18" r="3"/><path d="M14.8 14.8 20 20"/>'),
  copy: icon('<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>'),
  paste: icon('<rect width="8" height="4" x="8" y="2" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>'),
  copyPlain: icon('<rect width="8" height="4" x="8" y="2" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M9 12h6"/><path d="M9 16h4"/>'),
  selectAll: icon('<rect x="3" y="3" width="18" height="18" rx="2" stroke-dasharray="3.5 3"/>'),
  search: icon('<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>'),
  engine: icon('<path d="m7 15 5 5 5-5"/><path d="m7 9 5-5 5 5"/>')
};

var ZH = { cut: "\u526a\u5207", copy: "\u590d\u5236", paste: "\u7c98\u8d34", selectAll: "\u5168\u9009",
           copyPlain: "\u590d\u5236\u4e3a\u7eaf\u6587\u672c", copyFailed: "\u590d\u5236\u5931\u8d25",
           search: "\u641c\u7d22",
           engine: "\u641c\u7d22\u5f15\u64ce\u2026", custom: "\u81ea\u5b9a\u4e49", current: "\u5f53\u524d",
           customName: "\u540d\u79f0", customUrl: "\u7f51\u5740",
           customHint: "\u7528 {query} \u8868\u793a\u5173\u952e\u8bcd\uff1b\u6ca1\u6709\u5c31\u62fc\u5728\u672b\u5c3e",
           save: "\u4fdd\u5b58",
           empty: "\u526a\u8d34\u677f\u4e3a\u7a7a", noClipboard: "\u65e0\u6cd5\u8bfb\u53d6\u526a\u8d34\u677f\uff0c\u8bf7\u6309 Ctrl+V" };
var EN = { cut: "Cut", copy: "Copy", paste: "Paste", selectAll: "Select All",
           copyPlain: "Copy as plain text", copyFailed: "Copy failed",
           search: "Search",
           engine: "Search engine\u2026", custom: "Custom", current: "current",
           customName: "Name", customUrl: "URL",
           customHint: "Use {query} for the keywords; without it the query is appended",
           save: "Save",
           empty: "Clipboard is empty", noClipboard: "Clipboard unavailable - press Ctrl+V" };

function labels() {
  var lang = document.documentElement.getAttribute("lang") || navigator.language || "en";
  return String(lang).toLowerCase().indexOf("zh") === 0 ? ZH : EN;
}

/**
 * True when the platform already provides a context menu, i.e. when this plugin
 * should stay out of the way.
 *
 * DSH Desktop stamps Electron-owned markers onto the renderer URL
 * (dsh-desktop-mode / -platform / -material / -version / -mica) and exposes a
 * preload bridge; both are absent outside that shell. Other embedded shells are
 * recognised by their own runtime signals.
 *
 * Set window.__DSH_CLIPBOARD_MENU_FORCE__ = true to install anyway (for example
 * to use the menu in a browser on purpose).
 */
function hasNativeContextMenu() {
  if (window.__DSH_CLIPBOARD_MENU_FORCE__ === true) return false;
  try {
    if (new URLSearchParams(window.location.search).has("dsh-desktop-mode")) return false;
  } catch (e) {}
  if ("__DSH_DESKTOP_FILE_PATH__" in window) return false;
  if (/Electron\//.test(navigator.userAgent || "")) return false;
  if ("__TAURI__" in window || "__TAURI_INTERNALS__" in window) return false;
  return true;
}

var menuEl = null;
var activeEl = null;      // element that owned focus when the menu opened
var targetEl = null;      // element actually right-clicked
var savedRanges = [];     // DOM selection, for contenteditable
var savedInput = null;    // {start,end,dir}, for input/textarea
var savedText = "";
var readOnlySel = false;  // the selection lives in read-only content, not a field
var submenuEl = null;     // the hover submenu hanging off a row
var submenuTimer = 0;
var fieldMenuEl = null;   // the clipboard menu for a field inside the submenu
var toastEl = null;
var toastTimer = 0;

/* ---------------------------------------------------------------- helpers */

function isTextInput(el) {
  if (!el || el.nodeType !== 1) return false;
  if (el.tagName === "TEXTAREA") return true;
  if (el.tagName !== "INPUT") return false;
  var t = (el.getAttribute("type") || "text").toLowerCase();
  return ["text", "search", "url", "tel", "email", "password", "number"].indexOf(t) !== -1;
}

function isXterm(el) {
  if (!el || el.nodeType !== 1 || !el.classList) return false;
  if (el.classList.contains("xterm-helper-textarea")) return true;
  return !!(el.closest && el.closest(".xterm"));
}

/** Nearest element the user can type into, or null. */
function editableRoot(el) {
  var n = el;
  while (n && n.nodeType === 1) {
    if (n.getAttribute && n.getAttribute(MENU_ATTR) !== null) return null;
    if (isTextInput(n) || isXterm(n)) return n;
    if (n.isContentEditable) {
      // Walk to the outermost contenteditable host (Lexical mounts listeners
      // on its root, not on nested nodes).
      var host = n;
      var p = n.parentElement;
      while (p && p.isContentEditable) { host = p; p = p.parentElement; }
      return host;
    }
    n = n.parentElement;
  }
  return null;
}

/** Selection inside a plain input/textarea; window.getSelection is unreliable there. */
function inputSelectionText(el) {
  try {
    if (el && typeof el.selectionStart === "number" && el.selectionEnd > el.selectionStart) {
      return String(el.value).slice(el.selectionStart, el.selectionEnd);
    }
  } catch (e) {}
  return "";
}

function selectionText() {
  try {
    var s = window.getSelection();
    return s ? String(s) : "";
  } catch (e) { return ""; }
}

function readRanges() {
  var out = [];
  try {
    var s = window.getSelection();
    if (!s || s.rangeCount === 0) return out;
    for (var i = 0; i < s.rangeCount; i++) out.push(s.getRangeAt(i).cloneRange());
  } catch (e) {}
  return out;
}

function restoreRanges() {
  if (!savedRanges.length) return;
  try {
    var s = window.getSelection();
    s.removeAllRanges();
    for (var i = 0; i < savedRanges.length; i++) s.addRange(savedRanges[i]);
  } catch (e) {}
}

function focusBack() {
  var el = activeEl;
  // A selection in read-only content lives in the document itself, so moving
  // focus would collapse it — restore the range and leave focus alone. body and
  // html are skipped for the same reason.
  if (!readOnlySel && el && el.nodeType === 1 && el !== document.body && el !== document.documentElement && typeof el.focus === "function") {
    try {
      if (document.activeElement !== el) el.focus({ preventScroll: true });
    } catch (e) {
      try { el.focus(); } catch (e2) {}
    }
  }
  if (isTextInput(el) && savedInput) {
    try { el.setSelectionRange(savedInput.start, savedInput.end, savedInput.dir); } catch (e) {}
  } else {
    restoreRanges();
  }
}

/* ------------------------------------------------------------- clipboard */

function runCopy(cut) {
  focusBack();
  var ok = false;
  try { ok = document.execCommand(cut ? "cut" : "copy"); } catch (e) {}
  if (!ok && !cut && savedText && navigator.clipboard && navigator.clipboard.writeText) {
    try { navigator.clipboard.writeText(savedText); ok = true; } catch (e) {}
  }
  return ok;
}

/** Copy text without any rich/HTML serialisation. */
function runCopyPlain(text) {
  var value = text == null ? savedText : text;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    try {
      var pending = navigator.clipboard.writeText(value);
      if (pending && pending.catch) pending.catch(function () { toast(labels().copyFailed); });
      return true;
    } catch (e) {}
  }
  return runCopy(false);
}

/** Hand the selection to the default browser's search engine. */
function runSearch(text) {
  var q = text == null ? savedText : text;
  if (!q) return false;
  var url = searchWith(currentEngine(), q);
  try {
    var w = window.open(url, "_blank", "noopener,noreferrer");
    if (w) { try { w.opener = null; } catch (e) {} }
    return true;
  } catch (e) {}
  // Fallback: a plain anchor click travels the same path markdown links take.
  try {
    var a = document.createElement("a");
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    document.body.appendChild(a);
    a.click();
    a.remove();
    return true;
  } catch (e2) {}
  return false;
}

/** The engine list offered by the hover submenu, custom entry included. */
function engineItems(anchor, reopen) {
  var L = labels();
  var cur = currentEngine();
  var items = ENGINES.map(function (en) {
    return {
      label: en.name,
      icon: ICONS.search,
      hint: en.id === cur.id ? L.current : "",
      run: function () {
        storeEngine(en.id);
        closeSubmenu();
        if (reopen) reopen();
      }
    };
  });
  items.push({ sep: true });
  items.push({
    // keepOpen keeps the main menu — and therefore the anchor row — in the DOM,
    // so the form can be positioned from a real rect instead of 0,0.
    label: readCustomName() || L.custom,
    icon: ICONS.engine,
    hint: cur.id === "custom" ? L.current : "",
    keepOpen: true,
    run: function () { showCustomEngineForm(anchor, reopen); }
  });
  return items;
}

/** Hovering the row opens this; picking an engine reopens the parent menu. */
function openEngineSubmenu(anchor, reopen) {
  cancelSubmenuClose();
  showSubmenu(anchor, engineItems(anchor, reopen));
}

/**
 * Inline editor for a custom engine: a name and a URL template. window.prompt is
 * unavailable in Electron, so the fields live in the submenu layer instead.
 * Enter or Save stores; Escape backs out one level. Paste is a button because
 * right-clicking the field must not tear the form down.
 */
function showCustomEngineForm(anchor, reopen) {
  ensureStyle();
  closeSubmenu();
  var L = labels();

  var el = document.createElement("div");
  el.setAttribute(MENU_ATTR, "");
  el.classList.add("dcm-submenu");
  el.style.minWidth = "292px";

  function makeLabel(text) {
    var s = document.createElement("span");
    s.className = "dcm-form-label";
    s.textContent = text;
    return s;
  }
  function makeField(value, placeholder) {
    var i = document.createElement("input");
    i.type = "text";
    i.className = "dcm-input";
    i.spellcheck = false;
    i.value = value;
    i.placeholder = placeholder;
    return i;
  }

  var nameInput = makeField(readCustomName(), L.custom);
  var urlInput = makeField(readCustomTemplate(), "https://example.com/search?q={query}");

  var msg = document.createElement("span");
  msg.className = "dcm-form-hint";
  msg.textContent = L.customHint;

  var actions = document.createElement("div");
  actions.className = "dcm-form-actions";
  var pasteBtn = document.createElement("button");
  pasteBtn.type = "button";
  pasteBtn.className = "dcm-btn";
  pasteBtn.textContent = L.paste;
  var saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.className = "dcm-btn dcm-btn-primary";
  saveBtn.textContent = L.save;
  actions.appendChild(pasteBtn);
  actions.appendChild(saveBtn);

  el.appendChild(makeLabel(L.customName));
  el.appendChild(nameInput);
  el.appendChild(makeLabel(L.customUrl));
  el.appendChild(urlInput);
  el.appendChild(msg);
  el.appendChild(actions);
  document.body.appendChild(el);

  var r = anchor.getBoundingClientRect();
  var box = el.getBoundingClientRect();
  el.style.left = Math.max(8, Math.min(r.left, window.innerWidth - box.width - 8)) + "px";
  el.style.top = Math.max(8, Math.min(r.bottom + 2, window.innerHeight - box.height - 8)) + "px";
  el.addEventListener("mouseenter", cancelSubmenuClose);
  el.addEventListener("mouseleave", scheduleSubmenuClose);
  submenuEl = el;

  function commit() {
    var template = String(urlInput.value || "").trim();
    if (!template) return;
    storeCustomTemplate(template);
    storeCustomName(String(nameInput.value || "").trim());
    storeEngine("custom");
    closeSubmenu();
    if (reopen) reopen();
  }

  var lastFocused = urlInput;
  [nameInput, urlInput].forEach(function (input) {
    input.addEventListener("focus", function () { lastFocused = input; });
    input.addEventListener("keydown", function (ev) {
      ev.stopPropagation();
      if (ev.key === "Enter") { ev.preventDefault(); commit(); }
      else if (ev.key === "Escape") { ev.preventDefault(); closeSubmenu(); }
    });
  });

  pasteBtn.addEventListener("click", function (ev) {
    ev.preventDefault();
    ev.stopPropagation();
    if (!navigator.clipboard || !navigator.clipboard.readText) return;
    navigator.clipboard.readText().then(function (text) {
      if (text == null) return;
      lastFocused.value = String(text).trim();
      try { lastFocused.focus(); } catch (e) {}
    }).catch(function () { toast(labels().noClipboard); });
  });

  saveBtn.addEventListener("click", function (ev) {
    ev.preventDefault();
    ev.stopPropagation();
    commit();
  });

  try { urlInput.focus(); } catch (e) {}
}

function dispatchPasteEvent(root, text) {
  try {
    var dt = new DataTransfer();
    dt.setData("text/plain", text);
    var ev = new ClipboardEvent("paste", {
      clipboardData: dt, bubbles: true, cancelable: true, composed: true
    });
    // dispatchEvent returns false when a listener called preventDefault(),
    // which is exactly what an editor does when it consumes the paste.
    return root.dispatchEvent(ev) === false;
  } catch (e) {
    return false;
  }
}

function insertIntoInput(root, text) {
  var proto = root.tagName === "TEXTAREA"
    ? window.HTMLTextAreaElement.prototype
    : window.HTMLInputElement.prototype;
  var desc = Object.getOwnPropertyDescriptor(proto, "value");
  var start = root.selectionStart;
  var end = root.selectionEnd;
  if (start == null) start = root.value.length;
  if (end == null) end = start;
  var next = root.value.slice(0, start) + text + root.value.slice(end);
  if (desc && desc.set) desc.set.call(root, next);
  else root.value = next;
  var caret = start + text.length;
  try { root.setSelectionRange(caret, caret); } catch (e) {}
  root.dispatchEvent(new Event("input", { bubbles: true }));
}

function runPaste() {
  var root = editableRoot(targetEl);
  if (!root) return;
  var reading;
  try {
    reading = (navigator.clipboard && navigator.clipboard.readText)
      ? navigator.clipboard.readText()
      : Promise.reject(new Error("clipboard-read unavailable"));
  } catch (e) {
    reading = Promise.reject(e);
  }
  reading.then(function (text) {
    if (text == null) text = "";
    if (isXterm(root)) { dispatchPasteEvent(root, text); return; }
    if (isTextInput(root)) { insertIntoInput(root, text); return; }
    if (!dispatchPasteEvent(root, text)) {
      focusBack();
      try { document.execCommand("insertText", false, text); } catch (e) {}
    }
  }).catch(function () {
    toast(labels().noClipboard);
  });
}

function runSelectAll() {
  var root = editableRoot(targetEl);
  if (isTextInput(activeEl)) {
    try {
      activeEl.focus({ preventScroll: true });
      activeEl.select();
      return;
    } catch (e) {}
  }
  if (root && root.isContentEditable) {
    try {
      var r = document.createRange();
      r.selectNodeContents(root);
      var s = window.getSelection();
      s.removeAllRanges();
      s.addRange(r);
      return;
    } catch (e) {}
  }
  focusBack();
  try { document.execCommand("selectAll"); } catch (e) {}
}

/* ------------------------------------------------------------------- menu */

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  var st = document.createElement("style");
  st.id = STYLE_ID;
  st.textContent =
    "[" + MENU_ATTR + "]{position:fixed;z-index:2147483000;min-width:148px;padding:5px;" +
    "border:1px solid rgba(128,128,128,.35);border-radius:9px;background:Canvas;color:CanvasText;" +
    "box-shadow:0 10px 30px rgba(0,0,0,.30);font:400 13px/1.45 system-ui,'Segoe UI',sans-serif;" +
    "user-select:none;-webkit-user-select:none}" +
    "[" + MENU_ATTR + "] .dcm-item{display:flex;align-items:center;gap:9px;width:100%;text-align:left;" +
    "padding:6px 11px;border:0;border-radius:6px;background:transparent;color:inherit;font:inherit;cursor:default}" +
    "[" + MENU_ATTR + "] .dcm-icon{display:inline-flex;flex:0 0 auto;width:15px;height:15px;opacity:.9}" +
    "[" + MENU_ATTR + "] .dcm-icon svg{display:block;width:15px;height:15px}" +
    "[" + MENU_ATTR + "] .dcm-hint{margin-left:auto;padding-left:14px;opacity:.5;font-size:11.5px}" +
    "[" + MENU_ATTR + "].dcm-submenu{z-index:2147483001;min-width:174px}" +
    "[" + MENU_ATTR + "].dcm-fieldmenu{z-index:2147483002}" +
    "[" + MENU_ATTR + "] .dcm-input{box-sizing:border-box;display:block;width:100%;margin:3px 0 5px;" +
    "padding:5px 7px;border:1px solid rgba(128,128,128,.45);border-radius:6px;background:transparent;" +
    "color:inherit;font:inherit;outline:none}" +
    "[" + MENU_ATTR + "] .dcm-input:focus{border-color:Highlight}" +
    "[" + MENU_ATTR + "] .dcm-form-label{display:block;padding:2px 2px 0;font-size:11.5px;opacity:.7}" +
    "[" + MENU_ATTR + "] .dcm-form-hint{display:block;padding:3px 2px 0;font-size:11px;opacity:.5}" +
    "[" + MENU_ATTR + "] .dcm-form-actions{display:flex;gap:6px;margin-top:7px}" +
    "[" + MENU_ATTR + "] .dcm-btn{flex:1;padding:5px 8px;border:1px solid rgba(128,128,128,.4);" +
    "border-radius:6px;background:transparent;color:inherit;font:inherit;cursor:default}" +
    "[" + MENU_ATTR + "] .dcm-btn:hover{background:Highlight;color:HighlightText}" +
    "[" + MENU_ATTR + "] .dcm-btn-primary{border-color:Highlight}" +
    "[" + MENU_ATTR + "] .dcm-item:hover:not(:disabled){background:Highlight;color:HighlightText}" +
    "[" + MENU_ATTR + "] .dcm-item:disabled{opacity:.38}" +
    "[" + MENU_ATTR + "] .dcm-sep{height:1px;margin:5px 7px;background:rgba(128,128,128,.30)}";
  (document.head || document.documentElement).appendChild(st);
}

function closeFieldMenu() {
  if (!fieldMenuEl) return;
  try { fieldMenuEl.remove(); } catch (e) {}
  fieldMenuEl = null;
}

/** The submenu is a second layer: it must not take the main menu down with it. */
function closeSubmenu() {
  clearTimeout(submenuTimer);
  closeFieldMenu();
  if (!submenuEl) return;
  try { submenuEl.remove(); } catch (e) {}
  submenuEl = null;
}
function scheduleSubmenuClose() {
  clearTimeout(submenuTimer);
  // While the field menu is up it governs dismissal. Closing the form here would
  // take the field menu down with it, since the third layer hangs off the second.
  if (fieldMenuEl) return;
  submenuTimer = setTimeout(closeSubmenu, 160);
}
function cancelSubmenuClose() {
  clearTimeout(submenuTimer);
}

function closeMenu() {
  closeSubmenu();
  if (!menuEl) return;
  try { menuEl.remove(); } catch (e) {}
  menuEl = null;
  document.removeEventListener("mousedown", onDocMouseDown, true);
  document.removeEventListener("keydown", onDocKeyDown, true);
  window.removeEventListener("blur", closeMenu);
  window.removeEventListener("resize", closeMenu);
  // Deliberately no document-level scroll listener: a fixed-position menu does
  // not move with the content, and the conversation keeps scrolling while a
  // turn streams — which used to close the menu the instant it opened.
}

function onDocMouseDown(ev) {
  if (fieldMenuEl && fieldMenuEl.contains(ev.target)) return;
  if (submenuEl && submenuEl.contains(ev.target)) return;
  if (!menuEl) return;
  if (menuEl.contains(ev.target)) return;
  closeMenu();
}

function onDocKeyDown(ev) {
  if (ev.key !== "Escape") return;
  // Escape unwinds one layer at a time: field menu, then submenu, then the menu.
  if (fieldMenuEl) {
    ev.preventDefault();
    ev.stopPropagation();
    closeFieldMenu();
    return;
  }
  // Escape inside the custom-engine field backs out one level, not all of them.
  if (submenuEl && document.activeElement && submenuEl.contains(document.activeElement)) {
    ev.preventDefault();
    ev.stopPropagation();
    closeSubmenu();
    return;
  }
  ev.preventDefault();
  ev.stopPropagation();
  closeMenu();
}

/**
 * Build menu DOM from item specs; shared by every layer. `dismiss` decides what
 * a click closes by default, so a field menu can leave its form standing.
 */
function buildMenu(items, dismiss) {
  var dismissLayer = dismiss || closeMenu;
  var el = document.createElement("div");
  el.setAttribute(MENU_ATTR, "");
  items.forEach(function (it) {
    if (it.sep) {
      var d = document.createElement("div");
      d.className = "dcm-sep";
      el.appendChild(d);
      return;
    }
    var b = document.createElement("button");
    b.type = "button";
    b.className = "dcm-item";
    if (it.icon) {
      var ic = document.createElement("span");
      ic.className = "dcm-icon";
      ic.innerHTML = it.icon;   // constant markup from ICONS, never user input
      b.appendChild(ic);
    }
    var lb = document.createElement("span");
    lb.className = "dcm-label";
    lb.textContent = it.label;
    b.appendChild(lb);
    if (it.hint) {
      var hn = document.createElement("span");
      hn.className = "dcm-hint";
      hn.textContent = it.hint;
      b.appendChild(hn);
    }
    if (it.hover) {
      b.addEventListener("mouseenter", function () { it.hover(b); });
      b.addEventListener("mouseleave", function () { if (it.leave) it.leave(); });
    }
    if (it.disabled) b.disabled = true;
    else b.addEventListener("click", function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      if (!it.keepOpen) dismissLayer();
      it.run(b);
    });
    el.appendChild(b);
  });
  return el;
}

/**
 * Attach a floating panel near (x, y). When it would not fit to the right or
 * below, it flips to the other side rather than being pinned against the edge —
 * pinning made two nearby anchors produce the same position, so the panel looked
 * like it had not moved at all.
 */
function placePanel(el, x, y) {
  document.body.appendChild(el);
  var r = el.getBoundingClientRect();
  var left = x + r.width <= window.innerWidth - 8 ? x : Math.max(8, x - r.width);
  var top = y + r.height <= window.innerHeight - 8 ? y : Math.max(8, y - r.height);
  el.style.left = Math.max(8, left) + "px";
  el.style.top = Math.max(8, top) + "px";
  return el;
}

function showMenu(x, y, items) {
  closeMenu();
  ensureStyle();
  menuEl = placePanel(buildMenu(items), x, y);
  setTimeout(function () {
    if (!menuEl) return;
    document.addEventListener("mousedown", onDocMouseDown, true);
    document.addEventListener("keydown", onDocKeyDown, true);
    window.addEventListener("blur", closeMenu);
    window.addEventListener("resize", closeMenu);
  }, 0);
}

/** Third layer: the clipboard menu for a field inside the submenu. */
function showFieldMenu(x, y, items) {
  closeFieldMenu();
  cancelSubmenuClose();   // drop any timer left over from hovering the row
  ensureStyle();
  fieldMenuEl = placePanel(buildMenu(items, closeFieldMenu), x, y);
  fieldMenuEl.classList.add("dcm-fieldmenu");
  return fieldMenuEl;
}

/** A second layer hanging directly below the row it belongs to. */
function showSubmenu(anchor, items) {
  ensureStyle();
  closeSubmenu();
  var el = buildMenu(items, closeSubmenu);
  el.classList.add("dcm-submenu");
  document.body.appendChild(el);
  var r = anchor.getBoundingClientRect();
  var box = el.getBoundingClientRect();
  // Directly below the row, aligned to its left edge.
  el.style.left = Math.max(8, Math.min(r.left, window.innerWidth - box.width - 8)) + "px";
  el.style.top = Math.max(8, Math.min(r.bottom + 2, window.innerHeight - box.height - 8)) + "px";
  el.addEventListener("mouseenter", cancelSubmenuClose);
  el.addEventListener("mouseleave", scheduleSubmenuClose);
  submenuEl = el;
  return el;
}

function toast(msg) {
  try {
    if (toastEl) { toastEl.remove(); toastEl = null; }
    clearTimeout(toastTimer);
    toastEl = document.createElement("div");
    toastEl.setAttribute(MENU_ATTR, "");
    toastEl.textContent = msg;
    toastEl.style.cssText =
      "left:50%;top:24px;transform:translateX(-50%);padding:7px 14px;border-radius:8px;" +
      "font:400 13px/1.4 system-ui,'Segoe UI',sans-serif;pointer-events:none";
    document.body.appendChild(toastEl);
    toastTimer = setTimeout(function () {
      if (toastEl) { toastEl.remove(); toastEl = null; }
    }, 2600);
  } catch (e) {}
}

/* ------------------------------------------------------------------ entry */

function onContextMenu(ev) {
  if (menuEl && menuEl.contains(ev.target)) return;
  // The submenu (and its custom-engine form) owns its own right-clicks. A text
  // field in there gets the same clipboard menu, on a third layer, so the form
  // survives; anything else in the submenu is left alone.
  if (submenuEl && submenuEl.contains(ev.target)) {
    var field = editableRoot(ev.target);
    if (!field) return;
    targetEl = ev.target;
    readOnlySel = false;
    activeEl = field;
    savedRanges = readRanges();
    savedInput = isTextInput(field)
      ? { start: field.selectionStart, end: field.selectionEnd, dir: field.selectionDirection || "forward" }
      : null;
    savedText = inputSelectionText(field);
    var LF = labels();
    var fieldHasSel = !!savedText;
    ev.preventDefault();
    ev.stopPropagation();
    showFieldMenu(ev.clientX, ev.clientY, [
      { label: LF.cut, icon: ICONS.cut, disabled: !fieldHasSel, run: function () { runCopy(true); } },
      { label: LF.copy, icon: ICONS.copy, disabled: !fieldHasSel, run: function () { runCopy(false); } },
      { label: LF.paste, icon: ICONS.paste, run: function () { runPaste(); } },
      { label: LF.selectAll, icon: ICONS.selectAll, run: function () { runSelectAll(); } }
    ]);
    return;
  }
  var t = ev.target;
  if (t && t.closest && t.closest("[data-json-copy-button]")) return;

  var root = editableRoot(t);
  var selText = selectionText();

  // Read-only surfaces: an AI reply, a document preview, a code block. Offer
  // copy only when something is actually selected, so a right-click that isn't
  // about the selection still reaches the app's own menus untouched.
  if (!root) {
    if (!selText) return;
    targetEl = t;
    activeEl = document.activeElement;
    savedRanges = readRanges();
    savedInput = null;
    savedText = selText;
    readOnlySel = true;
    var LO = labels();
    var rx = ev.clientX;
    var ry = ev.clientY;
    var buildReadOnly = function () {
      return [
        { label: LO.copy, icon: ICONS.copy, run: function () { runCopy(false); } },
        { label: LO.copyPlain, icon: ICONS.copyPlain, run: function () { runCopyPlain(selText); } },
        { sep: true },
        { label: LO.search, icon: ICONS.search, hint: currentEngine().name, run: function () { runSearch(selText); } },
        {
          label: LO.engine,
          icon: ICONS.engine,
          keepOpen: true,
          hover: function (row) { openEngineSubmenu(row, showReadOnly); },
          leave: scheduleSubmenuClose,
          run: function (row) { openEngineSubmenu(row, showReadOnly); }
        }
      ];
    };
    // "reopen" has to re-render, not merely rebuild: pass the showing action.
    var showReadOnly = function () { showMenu(rx, ry, buildReadOnly()); };
    ev.preventDefault();
    ev.stopPropagation();
    showReadOnly();
    return;
  }

  targetEl = t;
  readOnlySel = false;
  activeEl = root.isContentEditable ? document.activeElement : root;
  savedRanges = readRanges();
  savedInput = isTextInput(activeEl)
    ? { start: activeEl.selectionStart, end: activeEl.selectionEnd, dir: activeEl.selectionDirection || "forward" }
    : null;
  if (!selText && savedInput && savedInput.end > savedInput.start) {
    try { selText = activeEl.value.slice(savedInput.start, savedInput.end); } catch (e) {}
  }
  savedText = selText;

  var L = labels();
  var hasSel = !!selText;
  var readOnly = root.isContentEditable === false && (root.readOnly || root.disabled);
  var mx = ev.clientX;
  var my = ev.clientY;
  var buildComposer = function () {
    return [
      { label: L.cut, icon: ICONS.cut, disabled: !hasSel || readOnly, run: function () { runCopy(true); } },
      { label: L.copy, icon: ICONS.copy, disabled: !hasSel, run: function () { runCopy(false); } },
      { label: L.paste, icon: ICONS.paste, disabled: readOnly, run: function () { runPaste(); } },
      { label: L.selectAll, icon: ICONS.selectAll, run: function () { runSelectAll(); } },
      { sep: true },
      { label: L.search, icon: ICONS.search, hint: currentEngine().name, disabled: !hasSel, run: function () { runSearch(selText); } },
      {
        label: L.engine,
        icon: ICONS.engine,
        keepOpen: true,
        hover: function (row) { openEngineSubmenu(row, showComposer); },
        leave: scheduleSubmenuClose,
        run: function (row) { openEngineSubmenu(row, showComposer); }
      }
    ];
  };
  // "reopen" has to re-render, not merely rebuild: pass the showing action.
  var showComposer = function () { showMenu(mx, my, buildComposer()); };

  ev.preventDefault();
  ev.stopPropagation();
  showComposer();
}

function apply() {
  if (window.__dshContextMenuInstalled) return;
  // Leave hosts that already own a context menu completely untouched.
  if (hasNativeContextMenu()) return;
  window.__dshContextMenuInstalled = true;
  document.addEventListener("contextmenu", onContextMenu, true);
}

var inject = [];

function dispose() {
  document.removeEventListener("contextmenu", onContextMenu, true);
  closeMenu();
  window.__dshContextMenuInstalled = false;
}

module.exports = { apply: apply, inject: inject, dispose: dispose };
return module.exports; } });
