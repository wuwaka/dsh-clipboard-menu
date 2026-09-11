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

var ZH = { cut: "\u526a\u5207", copy: "\u590d\u5236", paste: "\u7c98\u8d34", selectAll: "\u5168\u9009",
           copyPlain: "\u590d\u5236\u4e3a\u7eaf\u6587\u672c", copyFailed: "\u590d\u5236\u5931\u8d25",
           empty: "\u526a\u8d34\u677f\u4e3a\u7a7a", noClipboard: "\u65e0\u6cd5\u8bfb\u53d6\u526a\u8d34\u677f\uff0c\u8bf7\u6309 Ctrl+V" };
var EN = { cut: "Cut", copy: "Copy", paste: "Paste", selectAll: "Select All",
           copyPlain: "Copy as plain text", copyFailed: "Copy failed",
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
  // Never focus body/html: focusing it would collapse a selection living in
  // read-only content (an AI reply, a document preview).
  if (el && el.nodeType === 1 && el !== document.body && el !== document.documentElement && typeof el.focus === "function") {
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
    "[" + MENU_ATTR + "] .dcm-item{display:block;width:100%;text-align:left;padding:6px 11px;" +
    "border:0;border-radius:6px;background:transparent;color:inherit;font:inherit;cursor:default}" +
    "[" + MENU_ATTR + "] .dcm-item:hover:not(:disabled){background:Highlight;color:HighlightText}" +
    "[" + MENU_ATTR + "] .dcm-item:disabled{opacity:.38}" +
    "[" + MENU_ATTR + "] .dcm-sep{height:1px;margin:5px 7px;background:rgba(128,128,128,.30)}";
  (document.head || document.documentElement).appendChild(st);
}

function closeMenu() {
  if (!menuEl) return;
  try { menuEl.remove(); } catch (e) {}
  menuEl = null;
  document.removeEventListener("mousedown", onDocMouseDown, true);
  document.removeEventListener("keydown", onDocKeyDown, true);
  window.removeEventListener("blur", closeMenu);
  window.removeEventListener("resize", closeMenu);
  document.removeEventListener("scroll", closeMenu, true);
}

function onDocMouseDown(ev) {
  if (menuEl && !menuEl.contains(ev.target)) closeMenu();
}

function onDocKeyDown(ev) {
  if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); closeMenu(); }
}

function showMenu(x, y, items) {
  closeMenu();
  ensureStyle();
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
    b.textContent = it.label;
    if (it.disabled) b.disabled = true;
    else b.addEventListener("click", function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      closeMenu();
      it.run();
    });
    el.appendChild(b);
  });
  document.body.appendChild(el);
  var r = el.getBoundingClientRect();
  var left = Math.max(8, Math.min(x, window.innerWidth - r.width - 8));
  var top = Math.max(8, Math.min(y, window.innerHeight - r.height - 8));
  el.style.left = left + "px";
  el.style.top = top + "px";
  menuEl = el;
  setTimeout(function () {
    if (!menuEl) return;
    document.addEventListener("mousedown", onDocMouseDown, true);
    document.addEventListener("keydown", onDocKeyDown, true);
    window.addEventListener("blur", closeMenu);
    window.addEventListener("resize", closeMenu);
    document.addEventListener("scroll", closeMenu, true);
  }, 0);
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
    var LO = labels();
    ev.preventDefault();
    ev.stopPropagation();
    showMenu(ev.clientX, ev.clientY, [
      { label: LO.copy, run: function () { runCopy(false); } },
      { label: LO.copyPlain, run: function () { runCopyPlain(selText); } }
    ]);
    return;
  }

  targetEl = t;
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
  var items = [
    { label: L.cut, disabled: !hasSel || readOnly, run: function () { runCopy(true); } },
    { label: L.copy, disabled: !hasSel, run: function () { runCopy(false); } },
    { label: L.paste, disabled: readOnly, run: function () { runPaste(); } },
    { sep: true },
    { label: L.selectAll, run: function () { runSelectAll(); } }
  ];

  ev.preventDefault();
  ev.stopPropagation();
  showMenu(ev.clientX, ev.clientY, items);
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
