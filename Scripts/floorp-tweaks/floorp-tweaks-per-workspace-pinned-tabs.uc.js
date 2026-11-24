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
//                 v5.3.0: when the last unpinned tab of the active workspace
//                 closes, selection now stays inside the workspace.
//                 v5.3.1: the keep-alive now captures the workspace at
//                 TabClose time and defends it for a short window, so the
//                 select-sync can no longer chase Firefox's post-close
//                 pick into a foreign workspace before the correction runs.
//                 v5.4.0: pinned-tab drag reordering no longer fights the
//                 updater. The moveTabTo compaction is skipped while a drag
//                 is active (dragActive attribute in vertical layouts, drag
//                 events in horizontal ones) and for a short settle window
//                 afterwards, and it now only runs when front-contiguity is
//                 actually violated - in current DOM order, so the user's
//                 drag order sticks instead of being snapped back.
// @version        5.4.0
// @author         Conor - https://github.com/thefella/Floorp-Tweaks
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
 *    the current workspace's pins are kept at the front of the strip.
 *  - The updater is IDEMPOTENT and re-runs on every tab-list mutation
 *    (MutationObserver on #tabbrowser-arrowscrollbox). A wrong state after
 *    a race is corrected by the very next DOM change.
 *  - ORDERING (v5.4.0): classification (attribute work) NEVER reorders.
 *    Reordering happens only as a REPAIR, and only when an own pin sits
 *    behind a foreign pin in the strip (front-contiguity violated). The
 *    repair compacts own pins to the front IN CURRENT DOM ORDER, so it
 *    preserves - rather than discards - the user's drag arrangement.
 *  - DRAG SAFETY (v5.4.0): while a pinned-tab drag is active, the repair
 *    is suspended entirely so Floorp's own drag code owns the strip.
 *    Vertical layouts report the drag via the `dragActive` attribute on
 *    #pinned-tabs-container; horizontal layouts have no such attribute,
 *    so dragstart/dragend/drop/mouseup listeners fill the gap. After the
 *    drag ends, a 150 ms settle window lets the drop land before the next
 *    repair-capable pass, and the drop position is never snapped back
 *    because the repair only triggers on genuine contiguity violations.
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
 *  - CLOSE KEEP-ALIVE (v5.3.1): on TabClose of an unpinned tab in the
 *    active workspace, the workspace ID is CAPTURED IMMEDIATELY. Both the
 *    synchronous check and a zero-delay batch-correction then defend that
 *    captured workspace for KEEP_MS: if the selected tab is outside it,
 *    the most recently accessed remaining tab of the captured workspace is
 *    focused (last-used pinned tab when only pins remain), or a fresh tab
 *    is opened there if the workspace has no tabs left. Crucially, the
 *    select-sync SUSPENDS its workspace-following while the keep-alive is
 *    armed - otherwise it would switch Floorp to the foreign workspace
 *    Firefox briefly picked, before the correction could run.
 *
 * LOGGING: all console output is tagged "[Floorp-Tweaks][WSPins]". Messages
 * are printed only when DEBUG is true; flip it and watch the Browser
 * Console (Ctrl+Shift+J) to troubleshoot.
 *
 * REQUIRED CSS in userChrome.css:
 *
 *    tab[pwpt-workspace-hidden] { display: none !important; }
 */

(() => {
  if (!window.gBrowser || window.__pwptLoaded) return;
  window.__pwptLoaded = true;

  const LOG_TAG = "[Floorp-Tweaks][WSPins]";
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

  // ============== close keep-alive: stay in the workspace ==================
  // Firefox's post-close selection (TabClose -> removal -> new selection)
  // knows nothing about workspaces: closing the last unpinned tab of a
  // workspace can focus a neighbouring tab from ANOTHER workspace, and the
  // select-sync below would then follow it across. The keep-alive captures
  // the workspace at TabClose time and defends it for KEEP_MS.
  const KEEP_MS = 500; // batch closes settle within one tick; 500ms is a
                       // comfortable margin. Lower if a deliberate click on
                       // another workspace's tab right after a close feels
                       // blocked; raise it if the bug still slips through.

  const lastAccessedOf = (t) => t.lastAccessed ?? t._lastAccessed ?? 0;
  const wsOfTab = (t) =>
    t.getAttribute("floorpWorkspaceId") ?? wrapper.defaultWS();

  // Keep-alive state: the workspace that must retain the selection, and
  // when the defence window expires.
  let keepWS = null;
  let keepUntil = 0;

  const openFallbackTab = (ws) => {
    let tab;
    try {
      tab = g.addTrustedTab(null, { skipAnimation: true });
    } catch (e) {
      tab = g.addTab();
    }
    tab.setAttribute("floorpWorkspaceId", ws);
    g.selectedTab = tab;
    log("Opened fallback tab in workspace", ws);
  };

  // If the selection sits outside `ws` while tabs of `ws` remain, move it
  // to the most recently accessed remaining tab of `ws` (when only pinned
  // tabs remain, that is the last-used pin). Returns true if it acted.
  const enforceKeepWS = (ws, reason) => {
    if (!ws) return false;
    const stillInWs = g.tabs.filter(
      (t) => !t.closing && wsOfTab(t) === ws);
    if (stillInWs.length === 0) {
      // Workspace holds no tabs any more - let normal behaviour proceed
      // (also covers whole-window teardown).
      keepWS = null;
      return false;
    }
    const sel = g.selectedTab;
    if (!sel.closing && wsOfTab(sel) === ws) {
      keepWS = null; // selection is where it belongs; stand down
      return false;
    }
    const succ = stillInWs
      .slice()
      .sort((a, b) => lastAccessedOf(b) - lastAccessedOf(a))[0];
    g.selectedTab = succ;
    log("Kept selection in workspace", ws, `(${reason})`);
    return true;
  };

  let correctionTimer = null;
  const onTabClose = (event) => {
    const tab = event.target;
    if (!tab || tab.pinned) return;
    const ws = wsOfTab(tab);
    if (ws !== wrapper.currentWS()) return; // close in a background workspace

    // Capture NOW, before Firefox can move anything: every later check
    // defends this captured ID rather than re-reading the (possibly
    // already-poisoned) current workspace state.
    keepWS = ws;
    keepUntil = Date.now() + KEEP_MS;

    // Fast path for a single close: try to steer selection synchronously,
    // inside the TabClose dispatch. Firefox may still override afterwards,
    // which is exactly what the deferred correction below handles.
    if (!g._removingTabs || g._removingTabs.length <= 1) {
      try { enforceKeepWS(keepWS, "sync pass"); } catch (e) { logErr(e); }
    }
    // Deferred correction: runs after the removal storm (single or batch)
    // has settled, still defending the captured workspace.
    if (correctionTimer) clearTimeout(correctionTimer);
    correctionTimer = setTimeout(() => {
      correctionTimer = null;
      if (keepWS && Date.now() <= keepUntil) {
        try { enforceKeepWS(keepWS, "deferred pass"); } catch (e) { logErr(e); }
      }
    }, 0);
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

  // -------------------- drag state (v5.4.0) --------------------------------
  // Vertical-tabs layouts expose a `dragActive` attribute on
  // #pinned-tabs-container; horizontal layouts do not, so manual drag
  // listeners fill the gap. While a drag is busy, the updater classifies
  // but NEVER reorders; after it ends, a short settle window lets the
  // drop land before any repair-capable pass.
  const SETTLE_MS = 150;

  let manualDrag  = false; // set by dragstart on a tab element
  let settleUntil = 0;     // before this timestamp, reordering is suspended
  let settleTimer = null;

  const scheduleSettlePass = () => {
    settleUntil = Date.now() + SETTLE_MS;
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      settleTimer = null;
      updatePinnedTabs(false);
    }, SETTLE_MS + 10);
  };

  const isTabElement = (e) => {
    const t = e.target;
    if (!t || t.nodeType !== Node.ELEMENT_NODE) return false;
    return t.tagName === "tab" || !!t.closest?.("tab");
  };

  const endManualDrag = () => {
    if (!manualDrag) return;
    manualDrag = false;
    scheduleSettlePass();
  };

  // Forward declaration; defined below and used by the settle pass.
  let updatePinnedTabs;

  // Pure classification + conditional repair - safe to run as often as it
  // is called, and it never fights a drag in progress.
  updatePinnedTabs = (duringDrag = false) => {
    const ws  = wrapper.currentWS();
    const def = wrapper.defaultWS();
    let changed = false;

    // Pass 1: classification. Attributes only - this never reorders.
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
      } else {
        if (!tab.hasAttribute(hiddenAttr)) {
          tab.setAttribute(hiddenAttr, "");
          changed = true;
        }
        // During pinned-tab drags, hide for real so Floorp's drag code
        // does not fight the strip (Natsumi's workaround).
        if (duringDrag || manualDrag) {
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

    // Pass 2: repair front-contiguity, only when it is actually violated
    // and no drag is busy or settling. The compaction walks the strip in
    // CURRENT DOM order, so a drag-arranged order is preserved; if the
    // invariant already holds (the normal case after a drop inside the
    // own-pin block), nothing moves at all.
    const dragBusy = duringDrag || manualDrag || Date.now() < settleUntil;
    if (!dragBusy) {
      let foreignSeen = false;
      let needsRepair = false;
      for (const tab of g.tabs) {
        if (!tab.pinned) continue;
        const tws = tab.getAttribute("floorpWorkspaceId") ?? def;
        if (tws === ws) {
          if (foreignSeen) { needsRepair = true; break; }
        } else {
          foreignSeen = true;
        }
      }
      if (needsRepair) {
        let shown = 0;
        for (const tab of g.tabs) {
          if (!tab.pinned) continue;
          const tws = tab.getAttribute("floorpWorkspaceId") ?? def;
          if (tws === ws) {
            // Own pins to the front of the strip, in current order.
            try {
              g.moveTabTo(tab, { elementIndex: shown++ });
            } catch (e) { shown++; }
          }
        }
        changed = true;
        log("Repaired own-pin front contiguity in workspace", ws);
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

    // Manual drag detection: covers horizontal layouts (which have no
    // dragActive attribute) and any tab element in any layout. mouseup is
    // a belt-and-braces end signal in case dragend is swallowed.
    document.addEventListener("dragstart", (event) => {
      if (isTabElement(event)) manualDrag = true;
    }, true);
    document.addEventListener("dragend", endManualDrag, true);
    document.addEventListener("drop", endManualDrag, true);
    document.addEventListener("mouseup", endManualDrag, true);

    // Drag handling: observe dragActive on the pinned container (vertical
    // tabs layouts only; harmless if absent).
    const pinnedContainer = document.getElementById("pinned-tabs-container");
    if (pinnedContainer) {
      new MutationObserver(() => {
        const active = pinnedContainer.hasAttribute("dragActive");
        if (!active) scheduleSettlePass(); // arm BEFORE the next pass runs
        updatePinnedTabs(active);
      }).observe(pinnedContainer, { attributes: true, attributeFilter: ["dragActive"] });

      new MutationObserver(() => setStripVisibility())
        .observe(pinnedContainer, { childList: true });
    }

    // Selection changed: normally, if the selected tab's workspace
    // disagrees with Floorp's state, fix Floorp (Natsumi's onSelectEvent
    // behaviour). EXCEPTION: while the close keep-alive is armed, a
    // foreign-workspace selection is exactly the transient Firefox gives
    // us right after a close - chasing it would defeat the correction.
    // Re-steer selection to the captured workspace instead, and only
    // resume workspace-following once the selection is back inside it (or
    // the KEEP_MS window has expired).
    document.addEventListener("select", (event) => {
      if (event.target && event.target.id !== "tabbrowser-tabpanels") return;
      wrapper.defer(() => {
        const tabWs = g.selectedTab.getAttribute("floorpWorkspaceId");
        const cur   = wrapper.currentWS();

        if (keepWS && Date.now() <= keepUntil && tabWs && tabWs !== keepWS) {
          try { enforceKeepWS(keepWS, "select guard"); } catch (e) { logErr(e); }
          updatePinnedTabs(false);
          return; // do NOT sync Floorp to the foreign workspace
        }

        if (tabWs && tabWs !== cur) {
          log("Selected tab workspace", tabWs, "!= Floorp state", cur,
              "- syncing");
          wrapper.setWS(tabWs);
        }
        updatePinnedTabs(false);
      });
    }, true);

    // Close keep-alive: registered on the window so it catches TabClose
    // regardless of which element dispatches it.
    window.addEventListener("TabClose", onTabClose);

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
