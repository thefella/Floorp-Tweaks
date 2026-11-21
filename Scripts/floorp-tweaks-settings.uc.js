/*
 * floorp-tweaks-settings.uc.js  (v3.14.0)
 * Author: Conor
 * License: MPL-2.0
 *
 * "Floorp-Tweaks" pane in about:preferences (fx-autoconfig .uc.js).
 *
 * Known cosmetic notes:
 *   - Direct-loading about:preferences#floorp-tweaks can log one
 *     harmless native "unknown category" error before our
 *     registration lands; our deferred call routes correctly after.
 *   - Clicking our nav button may not rewrite the URL hash (native
 *     hash mapping only covers stock categories). Typing the hash
 *     by hand still deep-links.
 *
 * Tested against: Floorp (Firefox 159-era about:preferences,
 * moz-page-nav + gCategoryInits registry).
 */

"use strict";

(function () {
  console.log("[Floorp-Tweaks] settings script loaded");

  // ------------------------------------------------------------ config ----
  const PANE_VALUE           = "paneFloorpTweaks";
  const ANCHOR               = "floorp-tweaks";  // #anchor, stock-style
  const CAT_ID               = "category-floorpTweaks";
  const PANE_NAME            = "Floorp Tweaks";
  const WAIT_MS              = 250;   // tick while waiting for natives
  const WAIT_TRIES           = 20;    // ~5 s total patience
  const DIRECT_LOAD_DELAY_MS = 400;   // let init_all settle, then route

  const HTML_NS = "http://www.w3.org/1999/xhtml";

  // Thin-stroke wrench (Feather-style). stroke uses currentColor so
  // the icon inherits colour wherever it is displayed - in the page
  // header (rendered by moz-page-header's own iconTemplate) and in
  // the nav button (rail).
  const ICON =
    "data:image/svg+xml;charset=utf-8," + encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" ' +
      'fill="none" stroke="currentColor" stroke-width="1.5" ' +
      'stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 ' +
      '6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 ' +
      '1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 ' +
      '7.94-7.94l-3.76 3.76z"/></svg>');

  // One moz-card + moz-fieldset per group, rendered in this order.
  // Entries of PREFS are filed under their "section" key.
  const SECTIONS = [
    { id: "tweaks",  label: "Tweaks"  },
    { id: "history", label: "History" },
  ];

  // kind: undefined/"bool"  -> checkbox, stored via BoolPref
  // kind: "int"             -> dropdown,  stored via IntPref
  //
  // History retention values:  >0 = days, 0 = session only, -1 = forever.
  const PREFS = [
    { section: "tweaks",
      pref: "floorptweaks.sidebarPasswordIcon.disabled",
      label: "Hide Floorp Sidebar password icon",
      desc:  "Removes the password icon from the Floorp sidebar.",
      def:   true },
    { section: "tweaks",
      pref: "floorptweaks.audioIndicatorButton.disabled",
      label: "Disable clicking on mute tab icon",
      desc:  "Stops accidental muting when clicking a tab's audio indicator.",
      def:   true },
    { section: "tweaks",
      pref: "floorptweaks.obviousUnloadedTabs",
      label: "Make unloaded tabs more obvious",
      desc:  "Dims unloaded tabs so they stand out from active ones.",
      def:   true },
    { section: "history",
      kind: "int",
      pref: "floorptweaks.history.retention",
      label: "Browsing history duration",
      desc:  "Automatically delete browsing history older than the " +
             "selected period.",
      def:   -1,
      options: [
        { value: 0,   label: "Session Only" },
        { value: 1,   label: "One Day" },
        { value: 7,   label: "One Week" },
        { value: 30,  label: "One Month" },
        { value: 91,  label: "Three Months" },
        { value: 183, label: "Six Months" },
        { value: 365, label: "One Year" },
        { value: -1,  label: "Forever" },
      ] },
  ];

  // Attributes we must clear on cloned stock checkboxes so their
  // old binding doesn't interfere with ours.
  const STRIP_ATTRS = ["preference", "data-l10n-id", "data-l10n-attrs",
                       "hidden", "id"];

  // ------------------------------------------------------------ helpers ----
  // kind-aware pref access. bool-kind prefs use BoolPref; int-kind
  // prefs (dropdowns with numeric option values) use IntPref.
  function getVal(name, def, kind) {
    const b = Services.prefs;
    if (!b.prefHasUserValue(name)) return def;
    return kind === "int"
      ? b.getIntPref(name)
      : b.getBoolPref(name);
  }
  function setVal(name, val, kind) {
    if (kind === "int") Services.prefs.setIntPref(name, val);
    else Services.prefs.setBoolPref(name, val);
  }
  // Simple seed-if-absent. (The v3.11 string->integer migration was
  // removed in v3.14.0: single-user script, no legacy values exist.)
  function seedPrefs() {
    for (const item of PREFS) {
      if (!Services.prefs.prefHasUserValue(item.pref)) {
        setVal(item.pref, item.def, item.kind);
        console.log("[Floorp-Tweaks] seeded " + item.pref +
          " = " + item.def);
      }
    }
  }

  function isPrefsUrl(href) {
    try {
      const path = new URL(href).pathname.replace(/^\/+/, "");
      return path === "preferences";
    } catch (e) { return false; }
  }

  function deepQuery(root, predicate, depth) {
    if ((depth || 0) > 8) return null;
    const walker = (node) => {
      for (const el of node.querySelectorAll("*")) {
        if (predicate(el)) return el;
        if (el.shadowRoot) {
          const hit = walker(el.shadowRoot);
          if (hit) return hit;
        }
      }
      return null;
    };
    return walker(root);
  }

  // ------------------------------------------------- checkbox factory -----
  // Clone a stock checkbox element from any existing pane. Cloning
  // sidesteps the namespace question entirely: whatever namespace
  // Firefox defines this element in, the clone inherits it and is
  // guaranteed to upgrade and render identically. Accepts any
  // localName ending in "checkbox" so this survives widget renames.
  function makeStockCheckbox(doc) {
    let stock = deepQuery(doc, el =>
      typeof el.localName === "string" &&
      el.localName.endsWith("checkbox") &&
      !el.closest("#paneFloorpTweaksContent"));

    if (stock) {
      const clone = stock.cloneNode(true);
      // Drop stock children - our label/description ride on
      // attributes instead.
      while (clone.firstChild) clone.removeChild(clone.firstChild);
      for (const attr of [...clone.attributes]) {
        if (STRIP_ATTRS.includes(attr.name)) {
          clone.removeAttribute(attr.name);
        }
      }
      return clone;
    }

    // Fallback: HTML-namespace moz-checkbox (the moz-controls
    // family is defined as HTML custom elements).
    console.log("[Floorp-Tweaks] no stock checkbox found; falling " +
      "back to HTML-namespace moz-checkbox");
    return doc.createElementNS(HTML_NS, "moz-checkbox");
  }

  // -------------------------------------------------- select factory ------
  // Same clone-first strategy as makeStockCheckbox: prefer cloning a
  // stock select widget (whatever localName it has - e.g. moz-select)
  // so it upgrades in the right namespace; fall back to a plain HTML
  // <select>, which the in-content styles already cover. Options are
  // appended as ordinary <option> children in both cases.
  function makeSelect(doc) {
    let stock = deepQuery(doc, el =>
      typeof el.localName === "string" &&
      el.localName.endsWith("select") &&
      !el.closest("#paneFloorpTweaksContent"));

    if (stock) {
      const clone = stock.cloneNode(true);
      while (clone.firstChild) clone.removeChild(clone.firstChild);
      for (const attr of [...clone.attributes]) {
        if (STRIP_ATTRS.includes(attr.name)) {
          clone.removeAttribute(attr.name);
        }
      }
      console.log("[Floorp-Tweaks] cloned stock select widget: " +
        clone.localName);
      return clone;
    }

    console.log("[Floorp-Tweaks] no stock select found; falling " +
      "back to plain HTML <select>");
    return doc.createElementNS(HTML_NS, "select");
  }

  // ------------------------------------------------- control builders -----
  // Each returns a filled <setting-control> row for one PREFS item.
  function buildCheckboxRow(doc, item) {
    const sc = doc.createElementNS(HTML_NS, "setting-control");

    const cb = makeStockCheckbox(doc);
    cb.setAttribute("data-ft-pref", item.pref);
    cb.setAttribute("label", item.label);
    if (item.desc) {
      cb.setAttribute("description", item.desc);
    }
    cb.checked = getVal(item.pref, item.def);

    // Observe both events: modern moz-controls fire "change";
    // some versions/paths also fire "command". Duplicate delivery
    // is harmless (both handlers write the same current value).
    const onToggle = () => {
      setVal(item.pref, cb.checked);
      console.log("[Floorp-Tweaks] " + item.pref + " -> " + cb.checked);
    };
    cb.addEventListener("change", onToggle);
    cb.addEventListener("command", onToggle);

    sc.appendChild(cb);
    return sc;
  }

  function buildSelectRow(doc, item) {
    const sc = doc.createElementNS(HTML_NS, "setting-control");

    // Label/description stack beside the control, mirroring the
    // checkbox rows (which carry label/description as attrs).
    const wrap = doc.createElementNS(HTML_NS, "div");
    wrap.style.cssText =
      "display:flex; align-items:center; gap:16px; width:100%;";

    const text = doc.createElementNS(HTML_NS, "div");
    text.style.cssText = "flex:1;";

    const label = doc.createElementNS(HTML_NS, "div");
    label.textContent = item.label;
    label.style.cssText = "font-weight:500;";
    text.appendChild(label);

    if (item.desc) {
      const d = doc.createElementNS(HTML_NS, "div");
      d.textContent = item.desc;
      d.style.cssText =
        "color: var(--in-content-deemphasized-text, gray);" +
        "font-size: 0.9em; margin-top: 0.4em;";
      text.appendChild(d);
    }

    const sel = makeSelect(doc);
    sel.setAttribute("data-ft-pref", item.pref);
    for (const opt of item.options || []) {
      const o = doc.createElementNS(HTML_NS, "option");
      // Option values are strings in the DOM; the int pref value is
      // round-tripped through String()/parseInt() below.
      o.setAttribute("value", String(opt.value));
      o.textContent = opt.label;
      sel.appendChild(o);
    }
    sel.value = String(getVal(item.pref, item.def, "int"));

    sel.addEventListener("change", () => {
      const num = parseInt(sel.value, 10);
      if (Number.isNaN(num)) return;
      setVal(item.pref, num, "int");
      console.log("[Floorp-Tweaks] " + item.pref + " -> " + num);
    });

    wrap.appendChild(text);
    wrap.appendChild(sel);
    sc.appendChild(wrap);
    return sc;
  }

  function buildRow(doc, item) {
    // "select"-positive test: checkbox entries carry no kind at all,
    // so only an explicit "select"/"int" routes to the dropdown row.
    return (item.kind === "select" || item.kind === "int")
      ? buildSelectRow(doc, item)
      : buildCheckboxRow(doc, item);
  }

  // --------------------------------------------------- pane content -------
  // Top-level structure mirrors the stock panes exactly (v3.14.0):
  //
  //   html:setting-pane (id, data-category, hidden)
  //     html:section                          <- inner content wrapper
  //       moz-page-header heading=... iconsrc=...
  //         (NO children: the element renders its own div.heading,
  //          icon img and h2#heading internally - verified against
  //          moz-page-header.mjs.)
  //       moz-card > article.moz-card > moz-fieldset(label, hasheading)
  //         > setting-control > control rows   [one card per group]
  //
  // RESILIENCE (v3.14.0): each row and each card is built inside its
  // own try/catch. A bad PREFS entry (missing options, throwing
  // factory, bad kind) logs and is skipped; the rest of the pane -
  // and the page - survives. This guards the failure mode that
  // blanked the whole pane back in v3.11.
  //
  // Native pane-switching shows/hides the setting-pane via its
  // data-category attribute; we never touch visibility ourselves.
  // The fieldset renders its own heading from the label attribute.
  function buildPaneContent(doc) {
    const pane = doc.createElementNS(HTML_NS, "setting-pane");
    pane.id = "paneFloorpTweaksContent";
    pane.setAttribute("data-category", PANE_VALUE);
    pane.setAttribute("hidden", "true");

    const section = doc.createElementNS(HTML_NS, "section");

    // Pane header: stock element, attributes only - exactly like the
    // stock panes' own markup:
    //   <moz-page-header heading="..." iconsrc="...">
    // The element renders div.heading > img.icon + h2#heading itself.
    // Wrapped too: if the stock element ever rejects our usage, the
    // cards below should still render.
    try {
      const header = doc.createElementNS(HTML_NS, "moz-page-header");
      header.setAttribute("heading", PANE_NAME);
      header.setAttribute("iconsrc", ICON);
      section.appendChild(header);
    } catch (e) {
      console.warn("[Floorp-Tweaks] header build failed; continuing " +
        "without it:", e);
    }

    // One card + fieldset per group. A group with no PREFS entries
    // is skipped entirely; a group whose build throws is logged and
    // skipped without taking the pane down.
    for (const group of SECTIONS) {
      try {
        const items = PREFS.filter(p => p.section === group.id);
        if (!items.length) continue;

        const card = doc.createXULElement("moz-card");
        card.setAttribute("type", "default");
        card.setAttribute("spacing", "default");
        card.setAttribute("data-l10n-attrs", "heading");

        const article = doc.createElementNS(HTML_NS, "article");
        article.className = "moz-card";
        card.appendChild(article);

        // Fieldset: HTML-NAMESPACE Lit element, attribute-driven.
        // The component renders its own heading from "label" (level
        // via "headinglevel") when "hasheading" is set.
        const fieldset = doc.createElementNS(HTML_NS, "moz-fieldset");
        fieldset.setAttribute("label", group.label);
        fieldset.setAttribute("headinglevel", "3");
        fieldset.setAttribute("hasheading", "");

        for (const item of items) {
          try {
            fieldset.appendChild(buildRow(doc, item));
          } catch (e) {
            console.warn("[Floorp-Tweaks] row for " + item.pref +
              " failed; skipped:", e);
          }
        }

        article.appendChild(fieldset);
        section.appendChild(card);
      } catch (e) {
        console.warn("[Floorp-Tweaks] card \"" + group.label +
          "\" failed; skipped:", e);
      }
    }

    pane.appendChild(section);
    return pane;
  }

  function refreshStamped(doc) {
    for (const el of doc.querySelectorAll("[data-ft-pref]")) {
      const pref = el.getAttribute("data-ft-pref");
      const item = PREFS.find(p => p.pref === pref);
      if (!item) continue;
      if (item.kind === "int") {
        el.value = String(getVal(pref, item.def, "int"));
      } else {
        el.checked = getVal(pref, item.def);
      }
    }
  }

  // ----------------------------------------------- native registration ----
  // Make preferences.js's own router recognise our pane. The
  // _initted:true marker means no native init callback is expected;
  // showing/hiding is driven purely by data-category.
  function registerWithNatives(win) {
    const reg = win.gCategoryInits;
    if (!reg || typeof reg.set !== "function") return false;
    reg.set(PANE_VALUE, { _initted: true, init: () => {} });
    console.log("[Floorp-Tweaks] registered \"" + PANE_VALUE +
      "\" with gCategoryInits");
    return true;
  }

  // ------------------------------------------------------------- inject ---
  function inject(win, attempt) {
    const doc = win.document;

    seedPrefs();

    if (deepQuery(doc, el => el.id === CAT_ID)) {
      console.log("[Floorp-Tweaks] settings pane already present");
      return;
    }

    // Fail-safe: inject nothing until the native registry is
    // reachable. If preferences.js ever changes shape, we log
    // loudly instead of adding a dead button.
    if (!registerWithNatives(win)) {
      if ((attempt || 0) < WAIT_TRIES) {
        win.setTimeout(() => inject(win, (attempt || 0) + 1), WAIT_MS);
        return;
      }
      console.warn("[Floorp-Tweaks] gCategoryInits unreachable; " +
        "pane NOT injected (about:preferences architecture changed?)");
      return;
    }

    // Model for the sidebar nav button: a stock moz-page-nav-button
    // carrying a pane/view attribute.
    const model = deepQuery(doc, el =>
      el.localName === "moz-page-nav-button" &&
      /^pane/i.test(el.getAttribute("view") || "") &&
      !el.hidden &&
      el.getBoundingClientRect().height > 0);
    if (!model) {
      if ((attempt || 0) < WAIT_TRIES) {
        win.setTimeout(() => inject(win, (attempt || 0) + 1), WAIT_MS);
        return;
      }
      console.warn("[Floorp-Tweaks] no visible category buttons; aborting.");
      return;
    }
    console.log("[Floorp-Tweaks] cloning model: view=" +
      model.getAttribute("view"));

    const cat = model.cloneNode(true);
    cat.id = CAT_ID;
    cat.removeAttribute("hidden");
    cat.setAttribute("view", PANE_VALUE);
    cat.setAttribute("iconsrc", ICON);
    cat.setAttribute("tooltiptext", PANE_NAME + " settings");
    cat.removeAttribute("data-l10n-id");
    cat.querySelectorAll("[data-l10n-id]").forEach(n =>
      n.removeAttribute("data-l10n-id"));
    cat.textContent = PANE_NAME;
    model.after(cat);

    const main = doc.getElementById("mainPrefPane");
    if (!main) {
      console.warn("[Floorp-Tweaks] #mainPrefPane missing; aborting.");
      return;
    }
    main.appendChild(buildPaneContent(doc));

    // ---- deep link: delegate to the NATIVE router ---------------
    // Our hash anchor isn't in the native hash->category map, so we
    // translate it once and hand off. We only ever INITIATE native
    // transitions - never intercept, never override, never repair.
    win.addEventListener("hashchange", () => {
      if (win.closed) return;
      if (win.location.hash === "#" + ANCHOR) {
        try {
          win.gotoPref(PANE_VALUE);
        } catch (e) {
          console.warn("[Floorp-Tweaks] gotoPref(hash) failed: " + e);
        }
      }
      // Any other hash belongs to stock categories; native code
      // handles it, and native code hides/shows our content.
    });

    // Direct load of the anchor: init_all also reads the hash and,
    // not knowing our anchor, routes to the default pane. Let it
    // finish first, then route - last writer wins, deterministically.
    if (win.location.hash === "#" + ANCHOR) {
      win.setTimeout(() => {
        if (win.closed) return;
        if (win.location.hash !== "#" + ANCHOR) return;
        try {
          win.gotoPref(PANE_VALUE);
          console.log("[Floorp-Tweaks] deep link routed after init_all");
        } catch (e) {
          console.warn("[Floorp-Tweaks] deep-link gotoPref failed: " + e);
        }
      }, DIRECT_LOAD_DELAY_MS);
    }

    // ---- live mirror: about:config edits update the controls ----
    const observers = PREFS.map(item => {
      const fn = () => refreshStamped(doc);
      Services.prefs.addObserver(item.pref, fn);
      return [item.pref, fn];
    });
    win.addEventListener("unload", () => {
      for (const [name, fn] of observers) {
        try { Services.prefs.removeObserver(name, fn); } catch (e) {}
      }
    }, { once: true });

    console.log("[Floorp-Tweaks] settings pane injected OK " +
      "(native registration, no interception)");
  }

  // -------------------------------------------------------------- hook ----
  const TOPIC = "chrome-document-global-created";

  const observer = subject => {
    const win = subject;
    let href = "";
    try { href = win.location && win.location.href; }
    catch (e) { return; }
    console.debug("[Floorp-Tweaks] global created: " + href);

    if (href && isPrefsUrl(href)) {
      console.log("[Floorp-Tweaks] matched about:preferences (" +
        win.document.readyState + ")");
      if (win.document.readyState === "loading") {
        win.document.addEventListener(
          "DOMContentLoaded", () => inject(win), { once: true });
      } else {
        inject(win);
      }
      return;
    }
    if (win.document && win.document.readyState === "loading") {
      win.document.addEventListener(
        "DOMContentLoaded",
        () => {
          try {
            if (isPrefsUrl(win.location.href)) inject(win);
          } catch (e) {}
        },
        { once: true }
      );
    }
  };

  Services.obs.addObserver(observer, TOPIC);
})();
