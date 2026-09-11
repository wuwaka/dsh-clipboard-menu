const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const CLIENT = path.join(__dirname, "..", "lib", "client.js");
const code = fs.readFileSync(CLIENT, "utf8");

// DSH Desktop stamps these Electron-owned markers onto the renderer URL; a
// plain browser tab has none of them.
const DESKTOP_QUERY =
  "?dsh-desktop-mode=extended&dsh-desktop-platform=win32&dsh-desktop-material=mica" +
  "&dsh-desktop-version=2.0.9&dsh-desktop-mica=1";

function boot(html, opts) {
  const desktop = !opts || opts.desktop !== false;
  const url = "http://127.0.0.1:43120/" + (desktop ? DESKTOP_QUERY : "");
  const dom = new JSDOM(html, { runScripts: "outside-only", pretendToBeVisual: true, url });
  const w = dom.window;
  const d = w.document;

  // --- shims jsdom lacks ---
  let clip = "";
  Object.defineProperty(w.navigator, "clipboard", {
    configurable: true,
    value: { readText: async () => clip, writeText: async (t) => { clip = t; } }
  });
  w.DataTransfer = class { constructor() { this.m = {}; } setData(k, v) { this.m[k] = v; } getData(k) { return this.m[k] || ""; } };
  w.ClipboardEvent = class extends w.Event {
    constructor(type, init) { super(type, init || {}); this.clipboardData = (init && init.clipboardData) || null; }
  };
  Object.defineProperty(w.HTMLElement.prototype, "isContentEditable", {
    configurable: true,
    get() {
      let n = this;
      while (n && n.nodeType === 1) {
        if (n.getAttribute && n.getAttribute("contenteditable") === "true") return true;
        n = n.parentElement;
      }
      return false;
    }
  });

  let mod;
  w.__ModuleLoader__ = { load: (def) => { mod = def.factory(() => { throw new Error("no require"); }); } };
  w.eval(code);
  return { w, d, mod, setClip: (t) => { clip = t; }, getClip: () => clip };
}

function fire(el, type, init) {
  const ev = new el.ownerDocument.defaultView.MouseEvent(type, Object.assign({ bubbles: true, cancelable: true }, init || {}));
  el.dispatchEvent(ev);
  return ev;
}

function menuItems(d) {
  const menu = d.querySelector("[data-dsh-clipboard-menu]");
  if (!menu) return null;
  return Array.from(menu.querySelectorAll("button.dcm-item")).map((b) => ({ label: b.textContent, disabled: b.disabled, el: b }));
}

const results = [];
function check(name, cond, extra) {
  results.push((cond ? "PASS  " : "FAIL  ") + name + (extra ? "   [" + extra + "]" : ""));
}

(async () => {
  // ---------- case 1: textarea, no selection ----------
  {
    const { w, d, mod, setClip } = boot('<!doctype html><html lang="zh"><body><textarea id="t">hello</textarea></body></html>');
    check("module exports apply/inject", typeof mod.apply === "function" && Array.isArray(mod.inject));
    mod.apply();

    const ta = d.getElementById("t");
    ta.focus();
    ta.setSelectionRange(5, 5);
    fire(ta, "contextmenu", { clientX: 40, clientY: 40 });

    const items = menuItems(d);
    check("menu rendered on editable", !!items, items ? items.map((i) => i.label).join("/") : "none");
    if (items) {
      const pick = (label) => items.find((i) => i.label === label);
      check("cut disabled without selection", pick("\u526a\u5207").disabled === true);
      check("copy disabled without selection", pick("\u590d\u5236").disabled === true);
      check("paste enabled", pick("\u7c98\u8d34").disabled === false);

      let inputEvents = 0;
      ta.addEventListener("input", () => inputEvents++);
      setClip("XYZ");
      pick("\u7c98\u8d34").el.click();
      await new Promise((r) => setTimeout(r, 30));
      check("paste inserted at caret", ta.value === "helloXYZ", "value=" + JSON.stringify(ta.value));
      check("input event dispatched", inputEvents === 1, "n=" + inputEvents);
      check("menu closed after action", !d.querySelector("[data-dsh-clipboard-menu]"));
    }
  }

  // ---------- case 2: textarea with a selection -> cut enabled ----------
  {
    const { w, d, mod } = boot('<!doctype html><html lang="en"><body><textarea id="t">hello world</textarea></body></html>');
    mod.apply();
    const ta = d.getElementById("t");
    ta.focus();
    ta.setSelectionRange(0, 5);
    fire(ta, "contextmenu", { clientX: 10, clientY: 10 });
    const items = menuItems(d);
    check("en labels used", !!items && items.some((i) => i.label === "Paste"), items ? items.map((i) => i.label).join("/") : "");
    check("cut enabled with selection", !!items && items.find((i) => i.label === "Cut").disabled === false);
  }

  // ---------- case 3: Lexical-like contenteditable, synthetic paste ----------
  {
    const { w, d, mod, setClip } = boot('<!doctype html><html lang="zh"><body><div id="root" contenteditable="true"><p id="inner">abc</p></div></body></html>');
    mod.apply();
    const root = d.getElementById("root");
    const inner = d.getElementById("inner");
    let pasted = null;
    root.addEventListener("paste", (ev) => {
      ev.preventDefault();
      pasted = ev.clipboardData ? ev.clipboardData.getData("text/plain") : null;
    });
    inner.focus();
    fire(inner, "contextmenu", { clientX: 20, clientY: 20 });
    const items = menuItems(d);
    check("menu rendered for contenteditable", !!items);
    if (items) {
      setClip("PASTED-TEXT");
      items.find((i) => i.label === "\u7c98\u8d34").el.click();
      await new Promise((r) => setTimeout(r, 30));
      check("synthetic paste reached contenteditable listener", pasted === "PASTED-TEXT", "pasted=" + JSON.stringify(pasted));
    }
  }

  // ---------- case 4: read-only text (an AI reply) ----------
  {
    const { w, d, mod, setClip, getClip } = boot('<!doctype html><html lang="zh"><body><p id="p">plain</p></body></html>');
    mod.apply();
    const p = d.getElementById("p");

    const ev = fire(p, "contextmenu", { clientX: 5, clientY: 5 });
    check("read-only: no menu without a selection", !menuItems(d));
    check("read-only: unrelated right-click not intercepted", ev.defaultPrevented === false);

    const r = d.createRange();
    r.selectNodeContents(p);
    const sel = w.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
    const ev2 = fire(p, "contextmenu", { clientX: 6, clientY: 6 });
    const items2 = menuItems(d);
    check("read-only: selection opens a copy menu", !!items2 && ev2.defaultPrevented === true, items2 ? items2.map((i) => i.label).join("/") : "none");
    if (items2) {
      setClip("");
      items2.find((i) => i.label === "\u590d\u5236\u4e3a\u7eaf\u6587\u672c").el.click();
      await new Promise((res) => setTimeout(res, 30));
      check("read-only: copy as plain text wrote the selection", getClip() === "plain", "clip=" + JSON.stringify(getClip()));

      setClip("");
      const keepFocus = d.activeElement;
      items2.find((i) => i.label === "\u590d\u5236").el.click();
      await new Promise((res) => setTimeout(res, 30));
      check("read-only: plain Copy wrote the selection too", getClip() === "plain", "clip=" + JSON.stringify(getClip()));
      check("read-only: Copy did not steal focus", d.activeElement === keepFocus);
    }
  }

  // ---------- case 5: plain browser -> must stay out of the way entirely ----------
  {
    const { d, mod } = boot('<!doctype html><html lang="zh"><body><textarea id="t">abc</textarea></body></html>', { desktop: false });
    mod.apply();
    const ta = d.getElementById("t");
    ta.focus();
    ta.setSelectionRange(0, 3);
    const ev = fire(ta, "contextmenu", { clientX: 10, clientY: 10 });
    check("browser: custom menu NOT installed", !menuItems(d));
    check("browser: native menu left alone (no preventDefault)", ev.defaultPrevented === false);
  }

  // ---------- case 6: explicit force flag opts back in ----------
  {
    const { w, d, mod } = boot('<!doctype html><html lang="zh"><body><textarea id="t">abc</textarea></body></html>', { desktop: false });
    w.__DSH_CLIPBOARD_MENU_FORCE__ = true;
    mod.apply();
    const ta = d.getElementById("t");
    ta.focus();
    ta.setSelectionRange(0, 3);
    fire(ta, "contextmenu", { clientX: 10, clientY: 10 });
    check("force flag installs the menu in a browser", !!menuItems(d));
  }

  console.log(results.join("\n"));
  const failed = results.filter((r) => r.startsWith("FAIL")).length;
  console.log("\n" + (results.length - failed) + "/" + results.length + " passed");
  process.exit(failed ? 1 : 0);
})();
