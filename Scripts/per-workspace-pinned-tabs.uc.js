// ==UserScript==
// @name           Per-Workspace Pinned Tabs (Floorp)
// @description    Remembers which tabs are pinned in each Floorp workspace and
//                 re-applies the pin state on every workspace switch. Uses
//                 Floorp's real workspace IDs (the per-tab floorpWorkspaceId
//                 attribute) for exact identity, and persists pin sets across
//                 restarts via a JSON file in the profile.
// @version        3.1.0
// @author         Conot
// @license        MPL-2.0
// @include        main
// ==/UserScript==


/*
 * HOW TO INSTALL
 * --------------
 * 1. Open Floorp and type about:support in the address bar
 * 2. Find "Profile Folder" and click Open Folder
 * 3. Create a chrome folder inside it if one doesn't exist
 * 4. Save the script there (e.g. per-workspace-pins.uc.js — the .uc.js extension is what Floorp's userChrome loader picks up)
 * 5. Make sure userChrome scripts are enabled: about:config → toolkit.legacyUserProfileCustomizations.stylesheets → true, plus Floorp's own userScript setting if prompted
 * 6. Restart Floorp
*/


/*
 * HOW IT WORKS
 * ------------
 * Floorp stamps every tab with a `floorpWorkspaceId` attribute. This script
 * reads it - the same mechanism the Natsumi Browser suite uses for its
 * `natsumi.tabs.workspace-specific-pins` feature - but ships standalone:
 *
 *  - The active workspace is the workspace of the selected tab. A switch is
 *    detected via the tab panels' `select` event, with a TabShow/TabHide
 *    burst debounce as a secondary signal.
 *  - On a switch, the pinned tabs of the incoming workspace are made visible
 *    at the front of the strip; foreign-workspace pins are dealt with
 *    according to MODE (below).
 *  - Pin sets persist in <profile>/per-workspace-pinned-tabs.json keyed by
 *    stable workspace IDs, so restoration after a restart is exact. On boot
 *    only pins are ADDED, never removed.
 *
 * MODES
 * -----
 *  "rebind" (default): foreign pinned tabs are actually unpinned and the
 *      recorded tabs re-pinned. Fully standalone - no CSS needed. Cost:
 *      pin/unpin churn on every switch (slightly rewrites session history,
 *      affects Undo Close Tab of pinned tabs, resets pin order).
 *
 *  "css": nothing is ever pinned or unpinned. Foreign pins keep their pin
 *      state; this script toggles a `pwpt-workspace-hidden` attribute and
 *      the pins are hidden by CSS instead (Natsumi's approach). Requires
 *      pasting the companion rules into userChrome.css AND having
 *      userChrome.css enabled in Floorp:
 *
 *        @media (-moz-platform: any) {
 *          tab[pwpt-workspace-hidden] { display: none !important; }
 *        }
 *        /* keep the strip's padding tidy when a workspace has no pins *\/
 *        #pinned-tabs-container:has(> tab:not([pwpt-workspace-hidden])) {
 *          /* adjusts automatically; nothing to do *\/
 *        }
 *
 *      If you use "css" mode with horizontal tabs, the pinned area still
 *      reserves its width; hiding via display:none removes the tabs but the
 *      splitter width may linger - add to userChrome.css if you see it:
 *
 *        #vertical-pinned-tabs-splitter[hidden="true"] { display: none !important; }
 *
 *      (Note: in css mode you may need to remove the block comment markers
 *      above if you paste it literally - see the MODE block at the top.)
 *
 * TRADE-OFF SUMMARY
 *  - "css" preserves pin state perfectly across switches (no churn) but
 *    depends on your userChrome.css being loaded.
 *  - "rebind" is self-contained but cycles pins on each switch.
 *
 * TROUBLESHOOTING: set DEBUG to true and watch the Browser Console
 * (Ctrl+Shift+J). SETTLE_MS tunes the debounce for show/hide bursts.
 *
 * If anything misbehaves on your Floorp version, the likeliest culprit is the floorpWorkspaceId attribute name or the v4.store preference drifting in a future release; a console check will show it immediately, and both are single-line fixes.
 */

(() => {
  if (!window.gBrowser || window.__pwptLoaded) return;
  window.__pwptLoaded = true;

  // ---- configuration ----
  const MODE        = "rebind"; // "rebind" or "css" (see header for css rules)
  const SETTLE_MS     = 250;   // quiet period after a show/hide burst
  const POLL_MS       = 2000;  // safety-net reconcile frequency
  const SAVE_DELAY_MS = 1500;  // debounce for the JSON file
  const BOOT_DELAY_MS = 1200;  // wait after session restore before adopting
  const DEBUG         = false;
  // ----------------------

  const g   = window.gBrowser;
  const log = (...args) => { if (DEBUG) console.log("[PWPT]", ...args); };

  // ---------------------------------------------------- workspace identity --
  const WS_STORE_PREF = "floorp.workspaces.v4.store";

  const readWsStore = () => {
    try {
      return JSON.parse(Services.prefs.getStringPref(WS_STORE_PREF, "{}"));
    } catch (e) { return {}; }
  };

  const defaultWsId = () => {
    const store = readWsStore();
    return store.defaultID || "default";
  };

  const wsOf = (tab) =>
    (tab && tab.getAttribute("floorpWorkspaceId")) || defaultWsId();

  const currentWs = () => wsOf(g.selectedTab);

  const tabUrl = (t) => {
    try { return t.linkedBrowser.currentURI.spec; } catch (e) { return ""; }
  };

  const pinnedTabs = () => g.tabs.filter((t) => t.pinned);

  // Ordered, de-duplicated URLs of the pinned tabs belonging to `ws`.
  const pinnedUrlsFor = (ws) => {
    const urls = [];
    for (const t of pinnedTabs()) {
      if (wsOf(t) !== ws) continue;
      const u = tabUrl(t);
      if (u && !urls.includes(u)) urls.push(u);
    }
    return urls;
  };

  // ----------------------------------------------------------- persistence --
  // { version: 3, workspaces: { <workspaceId>: [ordered pinned URLs] } }
  const STORE_FILE = "per-workspace-pinned-tabs.json";
  const store = { version: 3, workspaces: {} };
  let storeLoaded = false;
  let storeDirty  = false;
  let saveTimer   = null;
  let filePath    = null;
  try { filePath = PathUtils.join(PathUtils.profileDir, STORE_FILE); }
  catch (e) { log("no profile dir access", e); }

  const loadStore = async () => {
    if (!filePath) { storeLoaded = true; return; }
    try {
      const data = await IOUtils.readJSON(filePath);
      if (data && data.workspaces && typeof data.workspaces === "object") {
        store.workspaces = data.workspaces;
        log("loaded pin store:", Object.keys(data.workspaces).length,
            "workspace(s)");
      }
    } catch (e) {
      log("no saved data yet, starting fresh");
    }
    storeLoaded = true;
  };

  const flushStore = async () => {
    if (!filePath || !storeDirty) return;
    storeDirty = false;
    try {
      await IOUtils.writeJSON(filePath, store);
      log("saved pin store to disk");
    } catch (e) { log("save failed", e); storeDirty = true; }
  };

  const scheduleSave = () => {
    if (!filePath) return;
    storeDirty = true;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { saveTimer = null; flushStore(); }, SAVE_DELAY_MS);
  };

  const savedPinsFor = (ws) => store.workspaces[ws] || [];

  // ----------------------------------------------------------------- state --
  const state = {
    current: null,    // workspace ID we believe is active
    applying: false,  // true while we drive the UI ourselves
    timer: null,      // burst debounce timer
    booted: false,    // set once the boot adopt has run
  };

  // Snapshot the live pins of `ws` into memory + disk.
  const recordPins = (ws) => {
    const urls = pinnedUrlsFor(ws);
    store.workspaces[ws] = urls;
    scheduleSave();
    log("recorded pins for workspace", ws, `(${urls.length} URL(s))`);
  };

  // Make the pinned strip reflect `ws`. Foreign pins: hidden or unpinned
  // depending on MODE; recorded pins are pinned and moved to the front.
  const showPinsFor = (ws) => {
    const wanted = new Set(savedPinsFor(ws));

    for (const t of pinnedTabs()) {
      if (wsOf(t) === ws) {
        t.removeAttribute("pwpt-workspace-hidden");
      } else if (MODE === "rebind") {
        g.unpinTab(t);
        if (!t.hidden) {
          try { g.hideTab(t); } catch (e) { /* older builds may lack it */ }
        }
      } else {
        t.setAttribute("pwpt-workspace-hidden", "");
      }
    }

    if (MODE === "rebind") {
      for (const t of g.tabs) {
        if (!t.pinned && !t.hidden && wsOf(t) === ws && wanted.has(tabUrl(t))) {
          g.pinTab(t);
        }
      }
    }

    // Own pins of this workspace first, in saved order.
    let index = 0;
    for (const url of savedPinsFor(ws)) {
      for (const t of pinnedTabs()) {
        if (wsOf(t) === ws && tabUrl(t) === url) {
          try {
            g.moveTabTo(t, { elementIndex: index++ });
          } catch (e) {
            try { g.moveTabTo(t, g.tabs[index]); index++; } catch (e2) {}
          }
          break;
        }
      }
    }

    try { g.tabContainer._invalidateCachedVisibleTabs(); } catch (e) {}

    // Hide the strip entirely if this workspace has no own pins (css mode).
    if (MODE === "css") {
      const container = document.getElementById("pinned-tabs-container");
      const splitter  = document.getElementById("vertical-pinned-tabs-splitter");
      const anyVisible = pinnedTabs().some((t) => !t.hasAttribute("pwpt-workspace-hidden"));
      if (container) container.toggleAttribute("hidden", !anyVisible);
      if (splitter) splitter.toggleAttribute("hidden", !anyVisible);
    }
  };

  // Disable the feature: release everything we hid (css mode).
  const releaseAll = () => {
    for (const t of pinnedTabs()) t.removeAttribute("pwpt-workspace-hidden");
    const container = document.getElementById("pinned-tabs-container");
    const splitter  = document.getElementById("vertical-pinned-tabs-splitter");
    if (container) container.removeAttribute("hidden");
    if (splitter) splitter.removeAttribute("hidden");
  };

  // Called when the active workspace may have changed.
  const onPossibleSwitch = () => {
    if (!state.booted || state.applying) return;

    const ws = currentWs();
    if (ws === state.current) return;

    state.applying = true;
    try {
      // 1. Snapshot the outgoing workspace's pins.
      if (state.current !== null) recordPins(state.current);

      // 2. First sighting of this workspace this session: seed the store
      //    entry (empty if unknown).
      if (!(ws in store.workspaces)) store.workspaces[ws] = [];

      // 3. Swap the visible pin set.
      showPinsFor(ws);
      state.current = ws;
      log("workspace switch ->", ws);
    } finally {
      state.applying = false;
    }
  };

  const schedule = () => {
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      state.timer = null;
      onPossibleSwitch();
    }, SETTLE_MS);
  };

  // ------------------------------------------------------------ boot adopt --
  // After session restore, re-apply the saved pins of the displayed
  // workspace. Conservative: only pins matching URLs, never unpins.
  const adoptSavedPins = () => {
    if (!storeLoaded) return;
    const ws = currentWs();
    state.applying = true;
    try {
      const wanted = new Set(savedPinsFor(ws));
      for (const t of g.tabs) {
        if (!t.pinned && !t.hidden && wsOf(t) === ws && wanted.has(tabUrl(t))) {
          g.pinTab(t);
        }
      }
      // Adopt the saved set as this workspace's pins of record.
      if (pinnedUrlsFor(ws).length || !savedPinsFor(ws).length) {
        recordPins(ws);
      }
      showPinsFor(ws);
      state.current = ws;
      state.booted = true;
      scheduleSave();
      log("boot adopt for workspace", ws,
          wanted.size ? `(${wanted.size} saved URL(s))` : "(none saved)");
    } finally {
      state.applying = false;
    }
  };

  Promise.all([
    loadStore(),
    new Promise((resolve) => {
      if (g.visibleTabs.length) { resolve(); return; }
      window.addEventListener("SSTabRestored", resolve, { once: true });
    }),
  ]).then(() => {
    setTimeout(adoptSavedPins, BOOT_DELAY_MS);
  });

  // -------------------------------------------------------------- wiring ----
  // Primary signal: the selected tab changed (mirrors Natsumi's onSelectEvent).
  document.addEventListener("select", (event) => {
    if (event.target && event.target.id !== "tabbrowser-tabpanels") return;
    if (state.timer) { clearTimeout(state.timer); state.timer = null; }
    onPossibleSwitch();
  }, true);

  // Secondary signal: show/hide bursts (covers toolbar-button switches).
  window.addEventListener("TabHide", schedule, true);
  window.addEventListener("TabShow", schedule, true);

  // Manual pin/unpin by the user is recorded on the fly.
  const onManualPinChange = () => {
    if (state.applying || state.current === null || !state.booted) return;
    recordPins(state.current);
  };
  window.addEventListener("TabPinned",   onManualPinChange, true);
  window.addEventListener("TabUnpinned", onManualPinChange, true);

  // Safety net: re-record in case a pin change bypassed the events.
  const poll = setInterval(() => {
    if (!state.applying && state.booted && state.current !== null) {
      recordPins(state.current);
    }
  }, POLL_MS);

  window.addEventListener("unload", () => {
    clearInterval(poll);
    if (state.timer) clearTimeout(state.timer);
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    if (state.booted && state.current !== null) recordPins(state.current);
    flushStore(); // fire-and-forget; best effort on shutdown
  }, { once: true });

  // Respect the feature being toggled off: release hidden pins.
  try {
    Services.prefs.addObserver("floorp.workspaces.v4.store", () => {
      if (!state.booted || state.applying) return;
      // Workspace set changed (created/deleted) - just re-assert state.
      if (!state.applying) showPinsFor(state.current);
    });
  } catch (e) { /* prefs API unavailable */ }
})();
