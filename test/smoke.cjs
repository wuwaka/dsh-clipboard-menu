const fs = require("node:fs");
const path = require("node:path");
const { JSDOM, VirtualConsole } = require("jsdom");

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
  // jsdom reports listener exceptions to the virtual console instead of
  // rethrowing them, so collect them and let assertions see them.
  const errors = [];
  const vc = new VirtualConsole();
  vc.on("jsdomError", (e) => errors.push(String((e && e.message) || e)));
  vc.on("error", (m) => errors.push(String(m)));
  const dom = new JSDOM(html, { runScripts: "outside-only", pretendToBeVisual: true, url, virtualConsole: vc });
  const w = dom.window;
  const d = w.document;

  // --- shims jsdom lacks ---
  let clip = "";
  let opened = "";
  w.open = (u) => { opened = u; return null; };
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

  // Optional fixed geometry, so placement (including its flips) is testable:
  // jsdom reports every rect as zero-sized otherwise.
  if (opts && opts.rect) {
    const fixed = Object.assign({ top: 0, left: 0, right: opts.rect.width, bottom: opts.rect.height, x: 0, y: 0 }, opts.rect);
    w.Element.prototype.getBoundingClientRect = function () { return fixed; };
  }

  let mod;
  w.__ModuleLoader__ = { load: (def) => { mod = def.factory(() => { throw new Error("no require"); }); } };
  w.eval(code);
  return { w, d, mod, setClip: (t) => { clip = t; }, getClip: () => clip, getOpened: () => opened, errors };
}

function fire(el, type, init) {
  const ev = new el.ownerDocument.defaultView.MouseEvent(type, Object.assign({ bubbles: true, cancelable: true }, init || {}));
  el.dispatchEvent(ev);
  return ev;
}

function readItems(menu) {
  if (!menu) return null;
  return Array.from(menu.querySelectorAll("button.dcm-item")).map((b) => {
    const lb = b.querySelector(".dcm-label");
    const hn = b.querySelector(".dcm-hint");
    return {
      label: lb ? lb.textContent : b.textContent,
      hint: hn ? hn.textContent : "",
      disabled: b.disabled,
      el: b
    };
  });
}

function menuItems(d) {
  return readItems(d.querySelector("[data-dsh-clipboard-menu]:not(.dcm-submenu)"));
}

function submenuItems(d) {
  return readItems(d.querySelector("[data-dsh-clipboard-menu].dcm-submenu"));
}

function fieldMenuItems(d) {
  return readItems(d.querySelector("[data-dsh-clipboard-menu].dcm-fieldmenu"));
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

  // ---------- case 7: the menu must survive content scrolling ----------
  {
    const { w, d, mod } = boot('<!doctype html><html lang="zh"><body><div id="scroller"><textarea id="t">abc</textarea></div></body></html>');
    mod.apply();
    const ta = d.getElementById("t");
    ta.focus();
    ta.setSelectionRange(1, 1);
    fire(ta, "contextmenu", { clientX: 30, clientY: 30 });
    check("scroll: menu open to begin with", !!menuItems(d));

    await new Promise((res) => setTimeout(res, 10));
    d.getElementById("scroller").dispatchEvent(new w.Event("scroll", { bubbles: true }));
    d.dispatchEvent(new w.Event("scroll", { bubbles: true }));
    await new Promise((res) => setTimeout(res, 10));
    check("scroll: menu survives a scroll", !!menuItems(d));

    d.dispatchEvent(new w.MouseEvent("mousedown", { bubbles: true }));
    await new Promise((res) => setTimeout(res, 10));
    check("scroll: menu still closes on an outside mousedown", !menuItems(d));
  }

  // ---------- case 8: the search entry ----------
  {
    const { d, mod, getOpened } = boot('<!doctype html><html lang="zh"><body><textarea id="t">hello</textarea></body></html>');
    mod.apply();
    const ta = d.getElementById("t");
    ta.focus();
    ta.setSelectionRange(0, 5);
    fire(ta, "contextmenu", { clientX: 10, clientY: 10 });
    const items = menuItems(d);
    const tags = items ? items.map((i) => i.label) : [];
    check("search: sits above the engine entry", tags.length === 6 && tags[4] === "\u641c\u7d22" && tags[5] === "\u641c\u7d22\u5f15\u64ce\u2026", tags.join("/"));
    check("search: hint names the current engine", !!items && items[4].hint === "\u767e\u5ea6", items ? "hint=" + items[4].hint : "");
    if (items) {
      items[4].el.click();
      await new Promise((res) => setTimeout(res, 10));
      check("search: chinese UI guesses baidu", /baidu\.com\/s\?wd=hello$/.test(getOpened()), "opened=" + JSON.stringify(getOpened()));
    }
  }

  // ---------- case 9: every entry carries an icon ----------
  {
    const { d, mod } = boot('<!doctype html><html lang="zh"><body><textarea id="t">abc</textarea></body></html>');
    mod.apply();
    const ta = d.getElementById("t");
    ta.focus();
    ta.setSelectionRange(0, 3);
    fire(ta, "contextmenu", { clientX: 10, clientY: 10 });
    const menu = d.querySelector("[data-dsh-clipboard-menu]");
    const icons = menu ? menu.querySelectorAll(".dcm-icon svg") : [];
    const labels = menu ? menu.querySelectorAll(".dcm-label") : [];
    check("icons: one svg per entry (separator excluded)", icons.length === 6, "icons=" + icons.length);
    check("icons: label text unaffected", labels.length === 6 && labels[0].textContent === "\u526a\u5207");
  }

  // ---------- case 10: the engine submenu opens on hover ----------
  {
    const { w, d, mod, getOpened, errors } = boot('<!doctype html><html lang="zh"><body><textarea id="t">hello</textarea></body></html>');
    mod.apply();
    const ta = d.getElementById("t");
    ta.focus();
    ta.setSelectionRange(0, 5);

    fire(ta, "contextmenu", { clientX: 10, clientY: 10 });
    menuItems(d)[5].el.dispatchEvent(new w.MouseEvent("mouseenter"));
    const engines = submenuItems(d);
    check("engine: hovering the row opens the submenu", !!engines && engines.length === 5, engines ? engines.map((i) => i.label).join("/") : "none");
    check("engine: current one is marked", !!engines && engines[0].hint === "\u5f53\u524d", engines ? "hint=" + engines[0].hint : "");
    check("engine: opening it does not close the main menu", !!menuItems(d));

    engines[2].el.click();
    await new Promise((res) => setTimeout(res, 10));
    check("engine: pick is persisted", w.localStorage.getItem("dsh-clipboard-menu.engine") === "google");
    check("engine: submenu closes on pick", !submenuItems(d));
    check("engine: reopening raised nothing", errors.length === 0, errors.join(" | "));
    const back = menuItems(d);
    check("engine: the main menu is still there", !!back && back.length === 6, back ? back.map((i) => i.label).join("/") : "none");
    check("engine: the hint now shows the pick", !!back && back[4].hint === "Google", back ? "hint=" + back[4].hint : "");

    ta.focus();
    ta.setSelectionRange(0, 5);
    fire(ta, "contextmenu", { clientX: 10, clientY: 10 });
    menuItems(d)[4].el.click();
    await new Promise((res) => setTimeout(res, 10));
    check("engine: remembered pick is used", /google\.com\/search\?q=hello$/.test(getOpened()), "opened=" + JSON.stringify(getOpened()));
  }

  // ---------- case 10b: a named custom search URL ----------
  {
    const { w, d, mod, getOpened, setClip } = boot('<!doctype html><html lang="zh"><body><textarea id="t">hello</textarea></body></html>');
    mod.apply();
    const ta = d.getElementById("t");
    ta.focus();
    ta.setSelectionRange(0, 5);

    const formInput = () => d.querySelector("[data-dsh-clipboard-menu].dcm-submenu .dcm-input");

    fire(ta, "contextmenu", { clientX: 10, clientY: 10 });
    const row = menuItems(d)[5];
    row.el.dispatchEvent(new w.MouseEvent("mouseenter"));
    submenuItems(d)[4].el.click();                       // the custom entry

    const form = d.querySelector("[data-dsh-clipboard-menu].dcm-submenu");
    const inputs = form ? form.querySelectorAll(".dcm-input") : [];
    check("custom: the form has a name and a url field", inputs.length === 2, "inputs=" + inputs.length);
    check("custom: the main menu survives so the anchor stays put", !!menuItems(d));

    // Right-clicking the URL field offers the same clipboard menu, on its own
    // layer, so the form survives and a URL can be pasted straight in.
    inputs[1].focus();
    inputs[1].setSelectionRange(0, 0);
    setClip("https://search.example.org/find?q={query}");
    fire(inputs[1], "contextmenu", { clientX: 12, clientY: 12 });
    const fieldMenu = fieldMenuItems(d);
    check("custom: right-clicking the field opens a clipboard menu", !!fieldMenu && fieldMenu.length === 4, fieldMenu ? fieldMenu.map((i) => i.label).join("/") : "none");
    check("custom: the form survives that right-click", !!formInput());
    const styleText = (d.getElementById("dsh-clipboard-menu-style") || {}).textContent || "";
    check("custom: the field menu stacks above the form", styleText.indexOf(".dcm-fieldmenu") >= 0 && styleText.indexOf("2147483002") >= 0);

    // The field menu must follow the cursor from one field to the next.
    fire(inputs[0], "contextmenu", { clientX: 100, clientY: 300 });
    const first = d.querySelector("[data-dsh-clipboard-menu].dcm-fieldmenu");
    const at1 = first ? first.style.left + "," + first.style.top : "none";
    fire(inputs[1], "contextmenu", { clientX: 140, clientY: 380 });
    const second = d.querySelector("[data-dsh-clipboard-menu].dcm-fieldmenu");
    const at2 = second ? second.style.left + "," + second.style.top : "none";
    check("custom: the field menu follows the cursor", at1 !== "none" && at2 !== "none" && at1 !== at2, at1 + " -> " + at2);

    // Moving the pointer off the form must not take the field menu with it.
    form.dispatchEvent(new w.MouseEvent("mouseleave"));
    await new Promise((res) => setTimeout(res, 240));
    check("custom: leaving the form keeps the field menu open", !!fieldMenuItems(d));
    check("custom: the form is still there too", !!formInput());

    fieldMenu[2].el.click();                       // 粘贴
    await new Promise((res) => setTimeout(res, 10));
    check("custom: paste fills the field", inputs[1].value === "https://search.example.org/find?q={query}", "value=" + JSON.stringify(inputs[1].value));
    check("custom: the field menu closes", !fieldMenuItems(d));
    check("custom: the form is still there after pasting", !!formInput());

    inputs[0].value = "My Search";

    const save = form.querySelector(".dcm-btn-primary");
    check("custom: there is a save button", !!save);
    check("custom: Save is the only button (paste lives in the right-click menu)", form.querySelectorAll(".dcm-btn").length === 1, "buttons=" + form.querySelectorAll(".dcm-btn").length);
    save.click();
    await new Promise((res) => setTimeout(res, 10));
    check("custom: the template is stored", w.localStorage.getItem("dsh-clipboard-menu.custom") === "https://search.example.org/find?q={query}");
    check("custom: the name is stored", w.localStorage.getItem("dsh-clipboard-menu.customName") === "My Search");
    check("custom: it becomes the chosen engine", w.localStorage.getItem("dsh-clipboard-menu.engine") === "custom");
    check("custom: the form closes and the menu returns", !formInput() && !!menuItems(d));

    menuItems(d)[5].el.dispatchEvent(new w.MouseEvent("mouseenter"));
    const again = submenuItems(d);
    check("custom: it is listed under its own name", !!again && again[4].label === "My Search", again ? again.map((i) => i.label).join("/") : "none");
    check("custom: it is marked as the current one", !!again && again[4].hint === "\u5f53\u524d");

    const back = menuItems(d);
    check("custom: the search hint shows the name", !!back && back[4].hint === "My Search", back ? "hint=" + back[4].hint : "");

    back[4].el.click();
    await new Promise((res) => setTimeout(res, 10));
    check("custom: {query} is substituted", getOpened() === "https://search.example.org/find?q=hello", "opened=" + JSON.stringify(getOpened()));
  }

  // ---------- case 10c: a left-click unwinds the layers above it ----------
  {
    const { w, d, mod } = boot('<!doctype html><html lang="zh"><body><textarea id="t">hello</textarea></body></html>');
    mod.apply();
    const ta = d.getElementById("t");
    ta.focus();
    ta.setSelectionRange(0, 5);
    const formFields = () => d.querySelectorAll("[data-dsh-clipboard-menu].dcm-submenu .dcm-input");
    const openForm = () => {
      fire(ta, "contextmenu", { clientX: 10, clientY: 10 });
      menuItems(d)[5].el.dispatchEvent(new w.MouseEvent("mouseenter"));
      submenuItems(d)[4].el.click();
      return formFields();
    };
    const mousedown = (el) => el.dispatchEvent(new w.MouseEvent("mousedown", { bubbles: true }));

    let fields = openForm();
    fire(fields[1], "contextmenu", { clientX: 12, clientY: 12 });
    check("dismiss: the field menu is up", !!fieldMenuItems(d));

    mousedown(fields[0]);
    await new Promise((res) => setTimeout(res, 10));
    check("dismiss: clicking the form closes only the field menu", !fieldMenuItems(d) && !!formFields().length && !!menuItems(d));

    fire(formFields()[1], "contextmenu", { clientX: 12, clientY: 12 });
    check("dismiss: right-clicking brings it back", !!fieldMenuItems(d));
    mousedown(menuItems(d)[0].el);
    await new Promise((res) => setTimeout(res, 10));
    check("dismiss: clicking the main menu closes the layers above it", !fieldMenuItems(d) && !submenuItems(d) && !!menuItems(d));

    fields = openForm();
    fire(fields[1], "contextmenu", { clientX: 12, clientY: 12 });
    check("dismiss: up once more", !!fieldMenuItems(d));
    mousedown(d.body);
    await new Promise((res) => setTimeout(res, 10));
    check("dismiss: an outside click closes every layer", !fieldMenuItems(d) && !submenuItems(d) && !menuItems(d));
  }

  // ---------- case 11: an english UI guesses google ----------
  {
    const { d, mod, getOpened } = boot('<!doctype html><html lang="en"><body><textarea id="t">hello</textarea></body></html>');
    mod.apply();
    const ta = d.getElementById("t");
    ta.focus();
    ta.setSelectionRange(0, 5);
    fire(ta, "contextmenu", { clientX: 10, clientY: 10 });
    menuItems(d)[4].el.click();
    await new Promise((res) => setTimeout(res, 10));
    check("engine: english UI guesses google", /google\.com\/search\?q=hello$/.test(getOpened()), "opened=" + JSON.stringify(getOpened()));
  }

  // ---------- case 13: placement flips instead of pinning to the edge ----------
  {
    const { w, d, mod } = boot('<!doctype html><html lang="zh"><body><textarea id="t">hello</textarea></body></html>', { rect: { width: 180, height: 150 } });
    mod.apply();
    const ta = d.getElementById("t");
    ta.focus();
    ta.setSelectionRange(0, 5);
    fire(ta, "contextmenu", { clientX: 10, clientY: 10 });
    menuItems(d)[5].el.dispatchEvent(new w.MouseEvent("mouseenter"));
    submenuItems(d)[4].el.click();
    const url = d.querySelectorAll("[data-dsh-clipboard-menu].dcm-submenu .dcm-input")[1];

    fire(url, "contextmenu", { clientX: 200, clientY: 100 });
    const normal = d.querySelector("[data-dsh-clipboard-menu].dcm-fieldmenu");
    check("flip: room at the cursor means no shift", normal.style.left === "200px" && normal.style.top === "100px", normal.style.left + "," + normal.style.top);

    fire(url, "contextmenu", { clientX: 200, clientY: 700 });
    const up = d.querySelector("[data-dsh-clipboard-menu].dcm-fieldmenu");
    check("flip: no room below flips it above", up.style.top === "550px", "top=" + up.style.top);

    fire(url, "contextmenu", { clientX: 1000, clientY: 200 });
    const back = d.querySelector("[data-dsh-clipboard-menu].dcm-fieldmenu");
    check("flip: no room right flips it left", back.style.left === "820px", "left=" + back.style.left);
  }

  console.log(results.join("\n"));
  const failed = results.filter((r) => r.startsWith("FAIL")).length;
  console.log("\n" + (results.length - failed) + "/" + results.length + " passed");
  process.exit(failed ? 1 : 0);
})();
