/*
 * floorp-tweaks-settings.uc.js  (v3.8)
 * Author: Conor
 * License: MPL-2.0
 *
 * "Floorp-Tweaks" pane in about:preferences (fx-autoconfig .uc.js).
 *
 * v3.8 FIELDSET FIX (DOM-dump verified): a stock-pane dump showed
 * that stock fieldsets are HTML-namespaced Lit elements configured
 * ENTIRELY by attributes:
 *   <moz-fieldset xmlns="...xhtml" label="Containers"
 *                 headinglevel="4" hasheading="">
 * There is NO slotted h3 child - the component renders its own
 * heading (level chosen by "headinglevel") when "hasheading" is
 * set and "label" is populated. v3.6/v3.7 failed because our
 * fieldset was made with createXULElement: a XUL-namespaced Lit
 * element never upgrades, so label/heading/spacing never rendered.
 * Also from the dump: stock checkboxes sit inside a
 * <setting-control> wrapper, which provides the per-row spacing
 * and alignment. Applied:
 *   - fieldset now created in the HTML namespace with
 *     label/headinglevel/hasheading attributes; slotted h3 removed.
 *   - each checkbox wrapped in an HTML-namespaced <setting-control>.
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
  const SECTION_LABEL        = "Tweaks";   // fieldset heading text
  const SECTION_HEADING_LVL  = "3";        // stock fieldsets use 3 (or 4)
  const WAIT_MS              = 250;   // tick while waiting for natives
  const WAIT_TRIES           = 20;    // ~5 s total patience
  const DIRECT_LOAD_DELAY_MS = 400;   // let init_all settle, then route

  const HTML_NS = "http://www.w3.org/1999/xhtml";

  // Thin-stroke wrench (Feather-style). stroke uses currentColor so
  // the icon inherits colour from the element that displays it -
  // works in <img> (header) and inside the nav button (rail).
  const ICON =
    "data:image/svg+xml;charset=utf-8," + encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" ' +
      'fill="none" stroke="currentColor" stroke-width="1.5" ' +
      'stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 ' +
      '6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 ' +
      '1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 ' +
      '7.94-7.94l-3.76 3.76z"/></svg>');

  const PREFS = [
    { pref: "floorptweaks.sidebarPasswordIcon.disabled",
      label: "Hide Floorp Sidebar password icon",
      desc:  "Removes the password icon from the Floorp sidebar.",
      def:   true },
    { pref: "floorptweaks.audioIndicatorButton.disabled",
      label: "Disable clicking on mute tab icon",
      desc:  "Stops accidental muting when clicking a tab's audio indicator.",
      def:   true },
    { pref: "floorptweaks.obviousUnloadedTabs",
      label: "Make unloaded tabs more obvious",
      desc:  "Dims unloaded tabs so they stand out from active ones.",
      def:   true },
  ];

  // Attributes we must clear on cloned stock checkboxes so their
  // old binding doesn't interfere with ours.
  const STRIP_ATTRS = ["preference", "data-l10n-id", "data-l10n-attrs",
                       "hidden", "id"];

  // ------------------------------------------------------------ helpers ----
  function getVal(name, def) {
    const b = Services.prefs;
    return b.prefHasUserValue(name) ? b.getBoolPref(name) : def;
  }
  function setVal(name, val) {
    Services.prefs.setBoolPref(name, val);
  }
  function seedPrefs() {
    for (const item of PREFS) {
      if (!Services.prefs.prefHasUserValue(item.pref)) {
        Services.prefs.setBoolPref(item.pref, item.def);
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

  // --------------------------------------------------- pane content -------
  // One top-level container inside #mainPrefPane, marked with the
  // native data-category attribute. Firefox's own pane-switching
  // code shows it when our category is active and hides it otherwise;
  // we never touch its visibility ourselves.
  //
  // Structure (v3.8, per stock-pane dump):
  //   moz-card > article.moz-card > moz-fieldset(label, hasheading)
  //     > setting-control > moz-checkbox (label, description)
  // The fieldset renders its own heading from the label attribute;
  // no slotted h3 is used by the stock panes.
  function buildPaneContent(doc) {
    const pane = doc.createXULElement("vbox");
    pane.id = "paneFloorpTweaksContent";
    pane.setAttribute("data-category", PANE_VALUE);
    pane.setAttribute("hidden", "true");

    // Header row: icon beside the heading, like the stock panes.
    const header = doc.createXULElement("hbox");
    header.setAttribute("align", "center");
    header.style.cssText = "gap:10px; margin-bottom:4px;";

    const icon = doc.createElementNS(HTML_NS, "img");
    icon.setAttribute("src", ICON);
    icon.setAttribute("width", "20");
    icon.setAttribute("height", "20");
    // currentColor inside the SVG resolves to this img's color.
    icon.style.color =
      "var(--in-content-page-color, var(--text-color, currentColor))";
    header.appendChild(icon);

    const h2 = doc.createXULElement("h2");
    h2.textContent = PANE_NAME;
    header.appendChild(h2);

    pane.appendChild(header);

    const desc = doc.createXULElement("description");
    desc.textContent =
      "Tweaks from the Floorp-Tweaks suite. Changes take effect " +
      "wherever the feature listens for the pref (some need a reload).";
    desc.style.color = "var(--in-content-deemphasized-text, gray)";
    desc.style.marginBottom = "32px";
    desc.style.marginTop = "8px";
    pane.appendChild(desc);

    // Card wrapper, matching stock panes.
    const card = doc.createXULElement("moz-card");
    card.setAttribute("type", "default");
    card.setAttribute("spacing", "default");
    card.setAttribute("data-l10n-attrs", "heading");

    const article = doc.createElementNS(HTML_NS, "article");
    article.className = "moz-card";
    card.appendChild(article);

    // Fieldset: HTML-NAMESPACE Lit element, attribute-driven.
    // The component renders its own heading from "label" (level via
    // "headinglevel") when "hasheading" is set - no child heading.
    const fieldset = doc.createElementNS(HTML_NS, "moz-fieldset");
    fieldset.setAttribute("label", SECTION_LABEL);
    fieldset.setAttribute("headinglevel", SECTION_HEADING_LVL);
    fieldset.setAttribute("hasheading", "");

    for (const item of PREFS) {
      // Stock panes wrap each control row in <setting-control>,
      // which supplies the row spacing/alignment.
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
      fieldset.appendChild(sc);
    }

    article.appendChild(fieldset);
    pane.appendChild(card);
    return pane;
  }

  function refreshStamped(doc) {
    for (const cb of doc.querySelectorAll("[data-ft-pref]")) {
      const pref = cb.getAttribute("data-ft-pref");
      const item = PREFS.find(p => p.pref === pref);
      if (item) cb.checked = getVal(pref, item.def);
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

    // ---- live mirror: about:config edits update the checkboxes ----
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
