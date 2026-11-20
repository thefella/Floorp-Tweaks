/*
 * floorp-tweaks-settings.uc.js  (v2.8)
 * Author: Conor
 * License: MPL-2.0
 *
 * "Floorp-Tweaks" pane in about:preferences (fx-autoconfig .uc.js).
 *
 * v2.8 GUARD FIX (user-reported): the v2.7 guard briefly blocked
 * clicking other menu items. Cause: the repair loop raced the user -
 * between a click on another category and the native chain reaching
 * our patched gotoPref (which releases the guard), a guard tick saw
 * the pane hidden, judged it stomping, and clicked our button back.
 *   Fixes:
 *   - User intent is authoritative: a capture-phase document listener
 *     releases the guard the instant pointerdown lands on any nav
 *     button that is NOT ours. The guard thereafter only repairs
 *     stomps that occur with no user interaction in flight.
 *   - Belt-and-braces: a repair is skipped if the pointer is down or
 *     a click happened within the last 300 ms.
 *   - Guard window shortened to 1.2 s (the native stomp burst happens
 *     immediately after activation).
 * Retained from v2.7: guard detects stomping (pane hidden or hash
 * reverted) and repairs via cat.click(); replaceState hash writes;
 * deep linking via gotoPref patch accepting the anchor; prefs always
 * written + seeded.
 *
 * Tested against: Floorp (Firefox 159-era about:preferences,
 * moz-page-nav + hard-coded gotoPref registry).
 */

"use strict";

(function () {
  console.log("[Floorp-Tweaks] settings script loaded");

  // ------------------------------------------------------------ config ----
  const PANE_VALUE    = "paneFloorpTweaks";
  const ANCHOR        = "floorp-tweaks";         // #anchor, stock-style
  const CAT_ID        = "category-floorpTweaks";
  const PANE_NAME     = "Floorp Tweaks";
  const GUARD_MS      = 1200;   // enforcement window after activation
  const GUARD_TICK_MS = 120;    // poll interval within the window
  const GUARD_REPAIRS = 5;      // max click-repairs per window
  const USER_GRACE_MS = 300;    // skip repairs shortly after a click

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

  // --------------------------------------------------- pane content -------
  function buildPaneContent(doc) {
    const pane = doc.createXULElement("vbox");
    pane.id = "paneFloorpTweaksContent";

    // Header row: icon beside the heading, like the stock panes.
    const header = doc.createXULElement("hbox");
    header.setAttribute("align", "center");
    header.style.cssText = "gap:10px; margin-bottom:4px;";

    const icon = doc.createElementNS(
      "http://www.w3.org/1999/xhtml", "img");
    icon.setAttribute("src", ICON);
    icon.setAttribute("width", "20");
    icon.setAttribute("height", "20");
    // currentColor inside the SVG resolves to this img's color.
    icon.style.color =
      "var(--in-content-page-color, var(--text-color, currentColor))";
    header.appendChild(icon);

    const h2 = doc.createXULElement("h2");
    h2.id = "heading";
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

    for (const item of PREFS) {
      const row = doc.createXULElement("hbox");
      row.setAttribute("align", "center");
      row.style.cssText =
        "padding:10px 12px; margin-bottom:4px; border-radius:4px; " +
        "gap:12px;";
      row.addEventListener("mouseenter", () => {
        row.style.backgroundColor =
          "var(--in-content-item-hover, rgba(0,0,0,.06))";
      });
      row.addEventListener("mouseleave", () => {
        row.style.backgroundColor = "transparent";
      });

      const textCol = doc.createXULElement("vbox");
      textCol.setAttribute("flex", "1");

      const label = doc.createXULElement("label");
      label.textContent = item.label;
      label.style.fontWeight = "500";
      textCol.appendChild(label);

      const sub = doc.createXULElement("description");
      sub.textContent = item.desc;
      sub.style.color = "var(--in-content-deemphasized-text, gray)";
      textCol.appendChild(sub);

      row.appendChild(textCol);

      const cb = doc.createXULElement("checkbox");
      cb.setAttribute("data-ft-pref", item.pref);
      cb.checked = getVal(item.pref, item.def);
      cb.addEventListener("command", () => {
        setVal(item.pref, cb.checked);
        console.log("[Floorp-Tweaks] " + item.pref + " -> " + cb.checked);
      });
      row.appendChild(cb);

      pane.appendChild(row);
    }
    return pane;
  }

  function refreshStamped(doc) {
    for (const cb of doc.querySelectorAll("checkbox[data-ft-pref]")) {
      const pref = cb.getAttribute("data-ft-pref");
      const item = PREFS.find(p => p.pref === pref);
      cb.checked = getVal(pref, item ? item.def : false);
    }
  }

  // --------------------------------------------------- gotoPref patch -----
  function patchGotoPref(win) {
    if (typeof win.gotoPref !== "function") {
      console.warn("[Floorp-Tweaks] gotoPref not found on prefs window; " +
        "pane will rely on click fallback.");
      return null;
    }
    const original = win.gotoPref;
    const patched = function (category, ...rest) {
      if (win.closed) {
        return original.apply(this, [category, ...rest]);
      }
      // Accept both our view name and the stock-style anchor.
      if (category === PANE_VALUE || category === ANCHOR) {
        activateGuard(win);
        showOurPane(win, { fromHash: false });
        return undefined;
      }
      deactivateGuard(win);              // a real pane took over
      return original.apply(this, [category, ...rest]);
    };
    try {
      win.gotoPref = patched;
      console.log("[Floorp-Tweaks] gotoPref patched successfully");
      return original;
    } catch (e) {
      console.warn("[Floorp-Tweaks] could not patch gotoPref: " + e);
      return null;
    }
  }

  function catRef(win) {
    return win.document.getElementById(CAT_ID);
  }

  // ------------------------------------------- guard against stomping ----
  // After we show our pane, init_all may still run gotoPref(default),
  // whose ORIGINAL implementation shows the default pane and rewrites
  // the hash. The guard watches for that and repairs by re-clicking
  // our category button. User intent always wins: pointerdown on any
  // other nav button releases the guard immediately (see installUser
  // IntentListener below), and repairs are skipped while the user is
  // interacting.
  function activateGuard(win) {
    if (win.closed) return;
    const cat = catRef(win);
    if (!cat) return;
    win.__ft_until   = Date.now() + GUARD_MS;
    win.__ft_repairs = 0;
    if (win.__ft_guard) return;        // already running

    win.__ft_guard = win.setInterval(() => {
      if (win.closed) {
        win.clearInterval(win.__ft_guard);
        win.__ft_guard = null;
        return;
      }
      if (Date.now() > win.__ft_until) {
        win.clearInterval(win.__ft_guard);
        win.__ft_guard = null;
        return;
      }
      const pane = win.document
        .getElementById("paneFloorpTweaksContent");
      const stumped = !pane || pane.hidden ||
        win.location.hash !== "#" + ANCHOR;
      if (!stumped) return;

      // Never fight the user: skip repair while the pointer is down
      // or a click happened moments ago.
      const sinceUser = Date.now() - (win.__ft_lastUser || 0);
      if (sinceUser < USER_GRACE_MS) {
        console.log("[Floorp-Tweaks] guard: stomp seen but user " +
          "interaction in flight - not repairing");
        return;
      }

      if (win.__ft_repairs++ < GUARD_REPAIRS) {
        console.log("[Floorp-Tweaks] guard: stomping detected " +
          "(pane " + (pane && !pane.hidden ? "visible" : "hidden") +
          ", hash " + win.location.hash + ") - repairing");
        setHash(win, ANCHOR);
        cat.click();                   // re-drive native chain
      } else {
        console.warn("[Floorp-Tweaks] guard: repair limit reached; " +
          "stopping");
        win.clearInterval(win.__ft_guard);
        win.__ft_guard = null;
      }
    }, GUARD_TICK_MS);
  }

  function deactivateGuard(win) {
    if (win && win.__ft_guard) {
      win.clearInterval(win.__ft_guard);
      win.__ft_guard = null;
      console.log("[Floorp-Tweaks] guard: released (another pane shown)");
    }
  }

  // User intent listener: pressing on any category button that is not
  // ours releases the guard before the native flow even runs, so the
  // repair loop can never override a deliberate selection.
  function installUserIntentListener(win) {
    if (win.__ft_intent) return;
    win.__ft_intent = true;
    win.document.addEventListener("pointerdown", ev => {
      if (win.closed) return;
      const btn = ev.composedPath().find(
        n => n.localName === "moz-page-nav-button");
      if (!btn) return;
      win.__ft_lastUser = Date.now();
      if (btn.id !== CAT_ID) {
        deactivateGuard(win);
      }
    }, true);
    win.document.addEventListener("click", () => {
      if (!win.closed) win.__ft_lastUser = Date.now();
    }, true);
  }

  // replaceState: changes the URL without firing hashchange, so our
  // own write cannot bounce through the hashchange handlers.
  function setHash(win, anchor) {
    try {
      win.history.replaceState(win.document.title || "", "",
        "#" + anchor);
    } catch (e) {
      console.warn("[Floorp-Tweaks] hash write failed: " + e);
    }
  }

  function showOurPane(win, opts) {
    if (win.closed) return;
    const doc = win.document;
    const main = doc.getElementById("mainPrefPane");
    if (!main) {
      console.warn("[Floorp-Tweaks] show: #mainPrefPane missing");
      return;
    }
    let pane = doc.getElementById("paneFloorpTweaksContent");
    if (!pane) {
      pane = buildPaneContent(doc);
      main.appendChild(pane);
    }
    for (const child of [...main.children]) {
      if (child !== pane) child.hidden = true;
    }
    pane.hidden = false;
    refreshStamped(doc);
    console.log("[Floorp-Tweaks] show: pane visible " +
      (opts && opts.fromHash ? "(via hashchange)" : "(via click/init)"));

    if (!(opts && opts.fromHash) && win.location.hash !== "#" + ANCHOR) {
      setHash(win, ANCHOR);
    }
  }

  function hideOurPane(win) {
    if (win.closed) return;
    const pane = win.document.getElementById("paneFloorpTweaksContent");
    if (pane) pane.hidden = true;
  }

  // ------------------------------------------------------------- inject ---
  function inject(win, attempt) {
    const doc = win.document;

    seedPrefs();

    if (deepQuery(doc, el => el.id === CAT_ID)) {
      console.log("[Floorp-Tweaks] settings pane already present");
      patchGotoPref(win);
      return;
    }

    const model = deepQuery(doc, el =>
      el.localName === "moz-page-nav-button" &&
      /^pane/i.test(el.getAttribute("view") || "") &&
      !el.hidden &&
      el.getBoundingClientRect().height > 0);
    if (!model) {
      if ((attempt || 0) < 10) {
        win.setTimeout(() => inject(win, (attempt || 0) + 1), 250);
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

    const patched = patchGotoPref(win);
    installUserIntentListener(win);

    if (!patched) {
      doc.addEventListener("click", ev => {
        const hitCat  = ev.composedPath().some(n => n === cat);
        const hitNav  = ev.composedPath().some(
          n => n !== cat && n.localName === "moz-page-nav-button");
        if (hitCat) {
          activateGuard(win);
          showOurPane(win, { fromHash: false });
        } else if (hitNav) {
          deactivateGuard(win);
          hideOurPane(win);
        }
      }, true);
    }

    // ---- hash routing: back/forward, direct loads, hash edits ----
    win.addEventListener("hashchange", () => {
      if (win.closed) return;
      const hash = win.location.hash.replace(/^#/, "");
      if (hash === ANCHOR) {
        activateGuard(win);
        showOurPane(win, { fromHash: true });
      }
      // Other hashes are handled by preferences.js's own hash handler;
      // its gotoPref call passes through our wrapper, which hides our
      // pane and releases the guard.
    });

    // Direct load of the anchor.
    if (win.location.hash === "#" + ANCHOR) {
      activateGuard(win);
      showOurPane(win, { fromHash: true });
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

    console.log("[Floorp-Tweaks] settings pane injected OK");
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
