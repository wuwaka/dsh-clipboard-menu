const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const CLIENT = path.join(__dirname, "..", "lib", "client.js");
const code = fs.readFileSync(CLIENT, "utf8");

function boot(html) {
  const dom = new JSDOM(html, { runScripts: "outside-only", pretendToBeVisual: true, url: "http://127.0.0.1:43120/" });
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

  // ---------- case 4: non-editable, no selection -> must NOT intercept ----------
  {
    const { w, d, mod } = boot('<!doctype html><html lang="zh"><body><p id="p">plain</p></body></html>');
    mod.apply();
    const p = d.getElementById("p");
    const ev = fire(p, "contextmenu", { clientX: 5, clientY: 5 });
    check("no menu on plain text without selection", !menuItems(d));
    check("did not preventDefault", ev.defaultPrevented === false);

    const r = d.createRange();
    r.selectNodeContents(p);
    const sel = w.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
    const ev2 = fire(p, "contextmenu", { clientX: 6, clientY: 6 });
    check("non-editable selection is NOT intercepted", !menuItems(d) && ev2.defaultPrevented === false);
  }

  console.log(results.join("\n"));
  const failed = results.filter((r) => r.startsWith("FAIL")).length;
  console.log("\n" + (results.length - failed) + "/" + results.length + " passed");
  process.exit(failed ? 1 : 0);
})();
