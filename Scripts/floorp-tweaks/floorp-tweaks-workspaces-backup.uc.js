// ==UserScript==
// @name           Workspaces Backup (Floorp)
// @description    MANUAL backup/restore of Floorp workspaces and pinned
//                 tabs, for disaster recovery and new-machine setup.
//                 BACKUP (console: __ftWorkspacesBackup(), later a
//                 settings-page button): absorbs the ENTIRE
//                 floorp.workspaces.v4.store blob (workspace UUIDs,
//                 names, icons, contexts, order, defaultID) plus every
//                 pinned tab (URL, workspace UUID) into
//                 "floorptweaks.workspaceBackup" as one JSON string.
//                 Tab titles are NOT stored (unused; keeps the backup
//                 small). RESTORE (console: __ftWorkspacesRestore()):
//                 copies the stored blob BACK into
//                 floorp.workspaces.v4.store (verbatim on an empty
//                 store, merged by UUID otherwise), then re-pins each
//                 backed-up tab into its workspace - immediately for
//                 workspaces Floorp's module already recognises,
//                 DEFERRED for those it does not until after a restart,
//                 when restore is run again.
//                 Dialog timestamps render in local readable form with
//                 SECONDS (e.g. 23 Nov 2026, 08:12:47); the stored
//                 timestamp remains ISO for machine parsing.
//                 Transport option: add
//                 services.sync.prefs.sync.floorptweaks.workspaceBackup
//                 to Firefox Sync on both machines and the backup travels
//                 automatically while restore stays a manual button press.
//                 Requires native Floorp workspace sync OFF and
//                 floorp.workspaces.v4.store OUT of user.js (single
//                 owner). No keyboard shortcuts, no observers.
// @version        3.0.3
// @author         Conor
// @license        MPL-2.0
// @include        main
// ==/UserScript==

/*
 * DESIGN (3.x - absorbed store)
 *
 *  - ONE ARTEFACT: floorptweaks.workspaceBackup contains the verbatim
 *    v4-store blob AND the pins. Restoring the store verbatim makes the
 *    restored machine's workspace UUIDs identical to the backup's, so
 *    pins key by UUID directly - no name matching, no icon problem.
 *  - OWNERSHIP: this script (manual button) is the only writer of
 *    floorp.workspaces.v4.store besides Floorp itself. Native Floorp
 *    workspace sync stays OFF; the store stays OUT of user.js.
 *  - RESTORE IS TWO-PASS BY DESIGN: writing the pref behind Floorp's
 *    back does not reliably refresh the module's in-memory state, so
 *    restore probes which UUIDs the live module recognises (reversible
 *    changeWorkspace calls), pins what it can, and reports deferred
 *    pins; after a restart, run restore again to complete them.
 *  - PIN URL EXTRACTION: tabs are NOT browsers - tab.currentURI does
 *    not exist. The URL comes from tab.linkedBrowser.currentURI, with a
 *    SessionStore-state fallback for unloaded/lazy tabs. Unreadable
 *    pins are counted and reported, never silently dropped.
 *  - NO TAB TITLES: titles were dropped in 3.0.2 - unused anywhere and
 *    a large share of the payload. Merge semantics unchanged.
 *  - READABLE DIALOG TIMESTAMPS: dialogs show the backup time via
 *    toLocaleString() WITH SECONDS; the stored ts remains ISO 8601.
 *
 * LOGGING: console output tagged "[Floorp-Tweaks]", DEBUG-gated. Results
 * are shown in dialogs regardless of DEBUG.
 */

(() => {
  if (!window.gBrowser || window.__ftWsbLoaded) return;
  window.__ftWsbLoaded = true;

  const LOG_TAG = "[Floorp-Tweaks][WSBackup]";
  const DEBUG   = false;
  const log     = (...a) => { if (DEBUG) console.log(LOG_TAG, ...a); };
  const logErr  = (...a) => { if (DEBUG) console.error(LOG_TAG, ...a); };

  const g           = window.gBrowser;
  const STORE_PREF  = "floorp.workspaces.v4.store";
  const BACKUP_PREF = "floorptweaks.workspaceBackup";

  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  const prompt = Services.prompt;

  // ----------------------------- pref I/O --------------------------------
  const readJson = (pref, fallback) => {
    try {
      return JSON.parse(Services.prefs.getStringPref(pref, "")) ?? fallback;
    } catch (e) {
      logErr(`${pref} unreadable:`, e);
      return fallback;
    }
  };

  const writeJson = (pref, obj) => {
    Services.prefs.setStringPref(pref, JSON.stringify(obj));
  };

  // ------------------- readable timestamp formatting ---------------------
  // Dialogs: local time WITH SECONDS, e.g. "23 Nov 2026, 08:12:47".
  // Stored ts: ISO 8601.
  const fmtTs = (iso) => {
    try {
      const d = new Date(iso);
      if (isNaN(d)) return iso;
      return d.toLocaleString(undefined, {
        day: "numeric", month: "short", year: "numeric",
        hour: "2-digit", minute: "2-digit", second: "2-digit",
      });
    } catch (e) {
      return iso;
    }
  };

  // ---------------------- workspaces module context ----------------------
  // Same ladder + functional scan as the Per-Workspace Pinned Tabs
  // script - used for changeWorkspace/getSelectedWorkspaceID only.
  const MODULE_BASE = "chrome://noraneko/content/assets/js/";

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

  const isValidModule = (mod) =>
    !!mod && typeof mod._?.getCtx === "function";

  const SCAN_MAX = 60;
  const SCAN_MIN = 22;

  const detectWorkspacesCtx = async () => {
    const tryMod = async (path) => {
      const mod = await import(path);
      return isValidModule(mod) ? mod._.getCtx() : null;
    };
    try {
      const ctx = await tryMod(ladderPath());
      if (ctx) return ctx;
    } catch (e) { /* scan */ }
    for (let n = SCAN_MAX; n >= SCAN_MIN; n--) {
      try {
        const ctx = await tryMod(`${MODULE_BASE}index${n}.js`);
        if (ctx) return ctx;
      } catch (e) { /* next candidate */ }
    }
    return null;
  };

  // ---------------------- tab URL extraction -----------------------------
  // Tabs are NOT browsers: tab.currentURI does not exist. The site lives
  // on tab.linkedBrowser; for unloaded/lazy tabs, the SessionStore state
  // carries the URL. Returns null when genuinely unreadable.
  const tabUrl = (tab) => {
    try {
      const spec = tab.linkedBrowser?.currentURI?.spec;
      if (spec && !spec.startsWith("about:blank")) return spec;
    } catch (e) { /* fall through to session state */ }
    try {
      const state = JSON.parse(SessionStore.getTabState(tab));
      const entries = state?.entries || [];
      if (entries.length) return entries[entries.length - 1].url || null;
    } catch (e) { /* fall through */ }
    return null;
  };

  // =============================== BACKUP ================================
  const doBackup = async () => {
    try {
      const store = readJson(STORE_PREF, null);
      if (!store || !Array.isArray(store.data) || !store.data.length) {
        prompt.alert(window, "Workspaces Backup",
          "No workspace store found - nothing to snapshot.");
        return;
      }

      const defaultID = store.defaultID || null;
      const pins = [];
      let unreadable = 0;

      for (const tab of g.tabs) {
        if (!tab.pinned) continue;
        const url = tabUrl(tab);
        if (!url) {
          unreadable++;
          log("Pin with unreadable URL:", tab.label);
          continue;
        }
        // No title: unused by restore and a large share of the payload.
        pins.push({
          url,
          ws: (tab.getAttribute("floorpWorkspaceId") ||
               defaultID || "").toLowerCase(),
        });
      }

      const backup = {
        v: 3,
        ts: new Date().toISOString(),
        device: Services.prefs.getStringPref(
          "identity.fxaccounts.account.device.name", ""),
        store,
        pins,
      };
      writeJson(BACKUP_PREF, backup);

      prompt.alert(window, "Workspaces Backup",
        `Backup written to ${BACKUP_PREF}\n\n` +
        `Workspaces: ${store.data.length}\n` +
        `Pinned tabs: ${pins.length}` +
        (unreadable ? `\nUnreadable pins (SKIPPED): ${unreadable}` : ``) +
        `\nTimestamp: ${fmtTs(backup.ts)}\n\n` +
        `Transport option: add\n` +
        `services.sync.prefs.sync.${BACKUP_PREF} = true\n` +
        `to about:config on both machines and the backup travels with ` +
        `Firefox Sync - restore stays a manual button press.`);
      log("Backup written:", store.data.length, "workspaces,",
          pins.length, "pins,", unreadable, "unreadable");
    } catch (e) {
      logErr("Backup failed:", e);
      prompt.alert(window, "Workspaces Backup",
        `Backup failed: ${e.message || e}`);
    }
  };

  // =============================== RESTORE ===============================
  const doRestore = async () => {
    try {
      const backup = readJson(BACKUP_PREF, null);
      if (!backup?.store || !Array.isArray(backup.store.data)) {
        prompt.alert(window, "Workspaces Restore",
          `No backup found in ${BACKUP_PREF}.\n\nRun ` +
          `__ftWorkspacesBackup() on your configured machine first.`);
        return;
      }

      const current = readJson(STORE_PREF, null);
      const currentCount = current?.data?.length || 0;
      const replaceMode = currentCount === 0;

      const ok = prompt.confirm(window, "Workspaces Restore",
        `Restore from backup ${fmtTs(backup.ts)} ` +
        `(${backup.device || "?"})?\n\n` +
        `Workspaces in backup: ${backup.store.data.length}\n` +
        `Workspaces on this machine: ${currentCount}\n` +
        (replaceMode
          ? `This machine has none - the backup store will be written ` +
            `VERBATIM.\n`
          : `Missing workspaces will be MERGED in by UUID; existing ` +
            `local workspaces are kept.\n`) +
        `Pinned tabs in backup: ${backup.pins?.length || 0}\n` +
        `Already-pinned URLs will be skipped.\n\n` +
        `If Floorp does not recognise a restored workspace until it ` +
        `restarts, run restore AGAIN after restarting.\n\nProceed?`);
      if (!ok) { log("Restore cancelled"); return; }

      // -------- 1) write/merge the v4 store --------
      const merged = replaceMode
        ? backup.store
        : (() => {
            const locals = new Map(
              current.data.map(([id, meta]) => [id, meta]));
            for (const [id, meta] of backup.store.data) {
              if (!locals.has(id)) locals.set(id, meta);
            }
            const order = [
              ...(backup.store.order || []),
              ...[...locals.keys()].filter(
                (id) => !(backup.store.order || []).includes(id)),
            ];
            return {
              defaultID: backup.store.defaultID || current.defaultID,
              data: [...locals.entries()],
              order,
            };
          })();
      writeJson(STORE_PREF, merged);
      log("Store written:", merged.data.length, "workspaces;",
          replaceMode ? "verbatim" : "merged");

      // -------- 2) pin tabs for workspaces the module knows --------
      const ctx = await detectWorkspacesCtx();
      if (!ctx) {
        prompt.alert(window, "Workspaces Restore",
          "Store written, but Floorp's workspaces module could not be " +
          "loaded - RESTART Floorp and run restore again to pin the " +
          "tabs.");
        return;
      }

      const previousWs = (() => {
        try { return ctx.getSelectedWorkspaceID(); } catch (e) {
          return null;
        }
      })();

      // Which backup workspace UUIDs does the LIVE module recognise?
      const known = new Set();
      const deferred = new Set();
      for (const [id] of merged.data) {
        try {
          ctx.tabManagerCtx.changeWorkspace(id);
          known.add(String(id).toLowerCase());
          log("Workspace recognised live:", id);
        } catch (e) {
          deferred.add(String(id).toLowerCase());
          log("Workspace not live yet (deferred):", id);
        }
      }
      if (previousWs) {
        try { ctx.tabManagerCtx.changeWorkspace(previousWs); }
        catch (e) { /* non-fatal */ }
        await sleep(150);
      }

      const pins = backup.pins || [];
      const byWs = new Map();
      for (const pin of pins) {
        const ws = String(pin.ws || "").toLowerCase();
        if (!byWs.has(ws)) byWs.set(ws, []);
        byWs.get(ws).push(pin);
      }

      const pinnedUrls = new Set();
      for (const tab of g.tabs) {
        if (!tab.pinned) continue;
        const url = tabUrl(tab);
        if (url) pinnedUrls.add(url.toLowerCase());
      }

      let rePinned = 0, skipped = 0, failed = 0, deferredPins = 0;

      for (const [ws, list] of byWs) {
        if (deferred.has(ws) || !known.has(ws)) {
          deferredPins += list.length;
          continue;
        }

        try { ctx.tabManagerCtx.changeWorkspace(ws); }
        catch (e) { logErr("changeWorkspace failed for", ws, e); }
        await sleep(200);

        for (const pin of list) {
          const urlKey = String(pin.url).toLowerCase();
          if (pinnedUrls.has(urlKey)) { skipped++; continue; }
          try {
            const tab = g.addTab(pin.url, {
              pinned: true,
              inBackground: true,
              triggeringPrincipal: Services.scriptSecurityManager
                .createContentPrincipalFromOrigin(
                  Services.io.newURI(pin.url).spec),
            });
            // Belt and braces: explicit stamp in case addTab did not
            // follow the selected-workspace change.
            tab.setAttribute("floorpWorkspaceId", ws);
            pinnedUrls.add(urlKey);
            rePinned++;
          } catch (e) {
            logErr("Re-pin failed for", pin.url, e);
            failed++;
          }
        }
      }

      if (previousWs) {
        try { ctx.tabManagerCtx.changeWorkspace(previousWs); }
        catch (e) { /* non-fatal */ }
      }

      prompt.alert(window, "Workspaces Restore",
        `Restore pass complete.\n\n` +
        `Workspaces in store: ${merged.data.length}\n` +
        `Re-pinned: ${rePinned}\n` +
        `Skipped (already pinned): ${skipped}\n` +
        (deferredPins
          ? `DEFERRED (need a restart + second pass): ${deferredPins}\n` +
            `RESTART Floorp, then run restore again.\n`
          : ``) +
        (failed ? `FAILED: ${failed}\n` : ``));
      log("Restore pass finished:", rePinned, "re-pinned,", skipped,
          "skipped,", deferredPins, "deferred,", failed, "failed");
    } catch (e) {
      logErr("Restore failed:", e);
      prompt.alert(window, "Workspaces Restore",
        `Restore failed: ${e.message || e}`);
    }
  };

  // -------------------------- console commands ---------------------------
  // Settings-page buttons to replace these later, per plan.
  window.__ftWorkspacesBackup = doBackup;
  window.__ftWorkspacesRestore = doRestore;

  log("Workspaces Backup ready: __ftWorkspacesBackup() / " +
      "__ftWorkspacesRestore()");
})();
