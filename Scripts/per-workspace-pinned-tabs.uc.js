// ==UserScript==
// @name           Per-Workspace Pinned Tabs (Floorp)
// @description    Shows only the active Floorp workspace's pinned tabs.
//                 Standalone port of Natsumi Browser's
//                 natsumi.tabs.workspace-specific-pins algorithm: pin state
//                 is never mutated - foreign pins are hidden via an attribute
//                 and CSS, current pins are reordered to the front. An
//                 idempotent updater re-runs on every tab-list change, so
//                 races self-heal. The current workspace is read from
//                 Floorp's own workspaces module, which is located
//                 automatically (functional validation); the Natsumi-style
//                 version ladder serves only as the fast-path shortcut.
// @version        5.2.1
// @author         Conot
// @license        MPL-2.0
// @include        main
// ==/UserScript==

/*
 * DESIGN (ported from Natsumi Browser, natsumi/scripts/workspaces.uc.mjs,
 * MIT (c) Green @greeeen-dev - algorithm and version ladder derive from
 * that file, trimmed to Floorp-only support):
 *
 *  - PIN STATE IS NEVER MUTATED. All pinned tabs stay pinned. Foreign-
 *    workspace pins get `pwpt-workspace-hidden` and are hidden by CSS;
 *    the current workspace's pins are moved to the front of the strip.
 *  - The updater is IDEMPOTENT and re-runs on every tab-list mutation
 *    (MutationObserver on #tabbrowser-arrowscrollbox). A wrong state after
 *    a race is corrected by the very next DOM change.
 *  - MODULE DISCOVERY: Floorp's internal workspaces module lives at
 *    chrome://noraneko/content/assets/js/indexNN.js, where NN moves with
 *    each Floorp release. The version ladder below provides the expected
 *    path (fast path, normally correct). If that module fails to import
 *    or does not expose _.getCtx(), the script scans candidate indexNN.js
 *    bundles and adopts the first one that VALIDATES functionally (must
 *    export _ with a getCtx function). If nothing validates, the script
 *    degrades to reading the selected tab's floorpWorkspaceId attribute.
 *  - Persistence is free: nothing is ever pinned/unpinned, so Floorp's
 *    session store preserves every pin and its workspace assignment across
 *    restarts. No JSON file.
 *
 * LOGGING: all console output is tagged "[Floorp-Tweaks]". Messages are
 * printed only when DEBUG is true; flip it and watch the Browser Console
 * (Ctrl+Shift+J) to troubleshoot.
 *
 * REQUIRED CSS in userChrome.css:
 *
 *    tab[pwpt-workspace-hidden] { display: none !important; }
 */

(() => {
  if (!window.gBrowser || window.__pwptLoaded) return;
  window.__pwptLoaded = true;

  const LOG_TAG = "[Floorp-Tweaks]";
  const DEBUG   = false;
  const log     = (...a) => { if (DEBUG) console.log(LOG_TAG, ...a); };
  const logErr  = (...a) => { if (DEBUG) console.error(LOG_TAG, ...a); };

  const g = window.gBrowser;

  // =============== Floorp workspaces module discovery ======================
  const MODULE_BASE = "chrome://noraneko/content/assets/js/";

  // Fast path: the Natsumi-derived ladder (Floorp-only; Firedragon paths
  // removed). Maps Floorp minor/patch versions to the module bundle that
  // carried the workspaces code at that release.
  const ladderPath = () => {
    const ver = AppConstants.MOZ_APP_VERSION_DISPLAY.split("@")[0];
    const minor = parseInt(ver.split(".")[1], 10);
    const patch = parseInt(ver.split(".")[2], 10);
    if (minor >= 20) return MODULE_BASE + "index35.js";
    if (minor >= 18) return MODULE_BASE + "index34.js";
    if (minor >= 17) return MODULE_BASE + "index33.js";
    if (minor >= 14) return MODULE_BASE + "index28.js";
    if (minor >= 12) return MODULE_BASE + "index27.js";
    if (minor > 9 || (minor === 9 && patch >= 2))
      return MODULE_BASE + "index26.js";
    if (minor === 9 && patch < 2) return MODULE_BASE + "index25.js";
    if (minor >= 8) return MODULE_BASE + "index25.js";
    if (minor >= 4) return MODULE_BASE + "index23.js";
    return MODULE_BASE + "index22.js";
  };

  // Functional validation: a candidate bundle counts as the workspaces
  // module only if it exposes the exact API surface we call.
  const isValidModule = (mod) =>
    !!mod && typeof mod._?.getCtx === "function";

  // Locate the workspaces module: ladder first (usually hits), then a
  // bounded scan over candidate bundle numbers, newest first.
  const SCAN_MAX = 60; // headroom above the current highest known (35)
  const SCAN_MIN = 22; // lowest known bundle

  const detectWorkspacesModule = async () => {
    const expected = (() => {
      try { return ladderPath(); } catch (e) { return null; }
    })();

    if (expected) {
      try {
        const mod = await import(expected);
        if (isValidModule(mod)) {
          log("Workspaces module via ladder:", expected);
          return { path: expected, mod };
        }
        log("Ladder module loaded but exposes no _.getCtx - scanning");
      } catch (e) {
        log("Ladder import failed:", e.message || e, "- scanning");
      }
    }

    for (let n = SCAN_MAX; n >= SCAN_MIN; n--) {
      const path = `${MODULE_BASE}index${n}.js`;
      if (path === expected) continue; // already tried
      try {
        const mod = await import(path);
        if (isValidModule(mod)) {
          log("Workspaces module auto-detected:", path);
          return { path, mod };
        }
      } catch (e) { /* bundle absent or not the workspaces one - next */ }
    }
    return null;
  };

  // ================== wrapper around Floorp's workspace API ================
  const wrapper = {
    module: null,
    ctx: null,
    properInit: false,
    fallback: false, // true if module import/getCtx failed
    queue: [],
    interval: null,

    async init() {
      const found = await detectWorkspacesModule().catch(() => null);
      if (found) {
        this.module = found.mod;
      } else {
        log("No workspaces module found - attribute fallback mode");
        this.fallback = true;
        this.setProperInit();
        return;
      }
      try {
        this.ctx = this.module._.getCtx();
      } catch (e) {
        logErr("Could not get workspaces context:", e);
      }
      if (this.ctx) {
        this.setProperInit();
      } else {
        this.fallback = true;
        this.setProperInit();
        // Lazy retry: the context may become available slightly later.
        this.interval = setInterval(() => {
          try {
            const c = this.module._.getCtx();
            if (c) {
              this.ctx = c;
              this.fallback = false;
              clearInterval(this.interval);
              this.interval = null;
              this.setProperInit();
              log("Workspaces context retrieved on retry");
            }
          } catch (e) { /* keep retrying */ }
        }, 100);
      }
    },

    setProperInit() {
      this.properInit = true;
      for (const fn of this.queue) { try { fn(); } catch (e) { logErr(e); } }
      this.queue = [];
    },

    defer(fn) { this.properInit ? fn() : this.queue.push(fn); },

    // Best-effort current workspace: real API if available, otherwise the
    // selected tab's stamp (fallback mode - less exact, but the idempotent
    // updater limits any error to one DOM tick).
    currentWS() {
      if (this.ctx) {
        try { return this.ctx.getSelectedWorkspaceID(); } catch (e) {}
      }
      return g.selectedTab.getAttribute("floorpWorkspaceId") || this.defaultWS();
    },

    defaultWS() {
      if (this.ctx) {
        try { return this.ctx.getDefaultWorkspaceID(); } catch (e) {}
      }
      try {
        const store = JSON.parse(
          Services.prefs.getStringPref("floorp.workspaces.v4.store", "{}"));
        return store.defaultID || "default";
      } catch (e) { return "default"; }
    },

    setWS(id) {
      if (this.ctx && id) {
        try { return this.ctx.tabManagerCtx.changeWorkspace(id); } catch (e) {}
      }
    },
  };

  // ======================= idempotent pins updater =========================
  const hiddenAttr = "pwpt-workspace-hidden";

  const setStripVisibility = () => {
    const container = document.getElementById("pinned-tabs-container");
    const splitter  = document.getElementById("vertical-pinned-tabs-splitter");
    if (!container && !splitter) return; // horizontal tab layout: nothing to do
    const anyVisible = g.tabs.some(
      (t) => t.pinned && !t.hasAttribute(hiddenAttr));
    if (container) container.toggleAttribute("hidden", !anyVisible);
    if (splitter)  splitter.toggleAttribute("hidden", !anyVisible);
  };

  // Pure classification - safe to run as often as it is called.
  const updatePinnedTabs = (dragActive = false) => {
    const ws  = wrapper.currentWS();
    const def = wrapper.defaultWS();
    let shown = 0;
    let changed = false;

    for (const tab of g.tabs) {
      if (!tab.pinned) continue;
      const tws = tab.getAttribute("floorpWorkspaceId") ?? def;
      if (tws === ws) {
        if (tab.hasAttribute(hiddenAttr)) {
          tab.removeAttribute(hiddenAttr);
          changed = true;
        }
        if (tab.hasAttribute("hidden")) {
          tab.removeAttribute("hidden");
          changed = true;
        }
        // Own pins to the front of the strip, in current order.
        try {
          g.moveTabTo(tab, { elementIndex: shown++ });
        } catch (e) { shown++; }
      } else {
        if (!tab.hasAttribute(hiddenAttr)) {
          tab.setAttribute(hiddenAttr, "");
          changed = true;
        }
        // During pinned-tab drags, hide for real so Floorp's drag code
        // does not fight the strip (Natsumi's workaround).
        if (dragActive) {
          if (!tab.hasAttribute("hidden")) {
            tab.setAttribute("hidden", "true");
            changed = true;
          }
        } else if (tab.hasAttribute("hidden")) {
          tab.removeAttribute("hidden");
          changed = true;
        }
      }
    }

    try { g.tabContainer._invalidateCachedVisibleTabs(); } catch (e) {}
    setStripVisibility();
    if (changed) log("Updated pinned tabs for workspace", ws);
  };

  // ================================ drivers ================================
  // Relentless driver: re-classify on every change in the tab list. The
  // updater is idempotent, so re-runs converge instead of looping.
  const startObservers = () => {
    const tabsList = document.getElementById("tabbrowser-arrowscrollbox");

    const tabsListObserver = new MutationObserver(() => updatePinnedTabs(false));
    if (tabsList) {
      tabsListObserver.observe(tabsList,
        { attributes: true, childList: true, subtree: true });
    } else {
      log("#tabbrowser-arrowscrollbox not found - observers not attached");
    }

    // Drag handling: observe dragActive on the pinned container (vertical
    // tabs layouts only; harmless if absent).
    const pinnedContainer = document.getElementById("pinned-tabs-container");
    if (pinnedContainer) {
      new MutationObserver(() => {
        updatePinnedTabs(pinnedContainer.hasAttribute("dragActive"));
      }).observe(pinnedContainer, { attributes: true, attributeFilter: ["dragActive"] });

      new MutationObserver(() => setStripVisibility())
        .observe(pinnedContainer, { childList: true });
    }

    // Selection changed: if the selected tab's workspace disagrees with
    // Floorp's state, fix Floorp (Natsumi's onSelectEvent behaviour).
    document.addEventListener("select", (event) => {
      if (event.target && event.target.id !== "tabbrowser-tabpanels") return;
      wrapper.defer(() => {
        const tabWs = g.selectedTab.getAttribute("floorpWorkspaceId");
        const cur   = wrapper.currentWS();
        if (tabWs && tabWs !== cur) {
          log("Selected tab workspace", tabWs, "!= Floorp state", cur,
              "- syncing");
          wrapper.setWS(tabWs);
        }
        updatePinnedTabs(false);
      });
    }, true);

    // Workspace registry changed (created/renamed/deleted workspaces).
    try {
      Services.prefs.addObserver("floorp.workspaces.v4.store", () => {
        updatePinnedTabs(false);
      });
    } catch (e) { /* prefs API unavailable */ }

    updatePinnedTabs(false);
  };

  // Boot: no adoption step, no store - just start filtering once the
  // workspace context is available.
  wrapper.init().then(() => {
    log("Started; properInit =", wrapper.properInit,
        "fallback =", wrapper.fallback);
    startObservers();
  }).catch((e) => {
    logErr("Init failed - starting in fallback mode anyway:", e);
    wrapper.fallback = true;
    wrapper.properInit = true;
    startObservers();
  });
})();