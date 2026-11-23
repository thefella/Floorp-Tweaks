// ==UserScript==
// @name           Panel Sidebar Auto-Reload (Floorp)
// @description    Periodically reloads Floorp panel-sidebar web panels,
//                 Vivaldi-style. Per-panel intervals are stored in the pref
//                 "floorptweaks.panelReload" as JSON, keyed BY PANEL UUID:
//                   { "<panel uuid>": minutes, ... }
//                 Config keys matching NO DEFINED panel are PRUNED - the
//                 known set comes from the floorp.panelSidebar.data
//                 registry, NOT from mounted browsers (panels mount
//                 lazily; a mounted-only set is empty at boot and
//                 pruning against it wiped the config on every restart).
//                 Deleting a web panel in Floorp still removes its
//                 auto-reload entry automatically. Editing the pref
//                 applies live (no restart). The script NEVER mutates
//                 floorp.panelSidebar.data itself.
//                 Panels reload even when hidden by default; opt into
//                 visible-only with { "minutes": N, "onlyWhenVisible": true }.
//                 Configured panels are MOUNTED AT STARTUP BY SIMULATING
//                 CLICKS on their sidebar icons, then the previously
//                 displayed panel is restored. Each configured panel's
//                 sidebar icon shows a DEPLETING COUNTDOWN bar (starts at
//                 100% after a reload, drains to 0% before the next).
//                 Intervals are set PER PANEL via an "Auto-Reload…"
//                 item in the native web-panel right-click context menu
//                 (#webpanel-context): presets 1/2/5/10/30/60/90 minutes
//                 + Disable. v2.3.0: the ladder is a STANDALONE popup of
//                 our own (attached to the document root), opened by the
//                 menu item's command - event-spy evidence showed Floorp
//                 rebuilds #webpanel-context from a document-level
//                 CAPTURE handler, which no suppression inside the popup
//                 can preempt, so a nested submenu can never survive.
//                 A standalone popup's events never traverse
//                 #webpanel-context at all. The menu's target panel is
//                 resolved from the CONTEXTMENU EVENT PATH (capture
//                 phase); radio checkmark uses attribute
//                 presence/removal (XUL quirk).
// @version        2.3.0
// @author         Conor
// @license        MPL-2.0
// @include        main
// ==/UserScript==

/*
 * HOW IT WORKS (verified against real Floorp markup)
 *
 *  - Panel browsers: each WEB panel that has been opened this session is
 *    mounted as <browser class="sidebar-panel-browser"> with id
 *    "sidebar-panel-<panel-uuid>" inside vbox#panel-sidebar-browser-box.
 *    The browser's content is a chrome wrapper page
 *    (browser.xhtml?floorpWebPanelId=<uuid>); reloading it remounts the
 *    panel's site, which is exactly the reload we want.
 *  - CONFIG (2.x): floorptweaks.panelReload holds one entry per
 *    configured panel, keyed by the panel's UUID from
 *    floorp.panelSidebar.data. Value: plain minutes number, or an object
 *    { minutes, onlyWhenVisible, preload }. UUID keys only - there is no
 *    migration and no URL-substring matching; the context menu writes
 *    UUID keys, so the menu is the intended configuration path.
 *    - PRUNING (fixed in 2.2.0): config keys matching no DEFINED panel
 *      UUID are deleted. The defined set is read from
 *      floorp.panelSidebar.data, NOT from mounted browsers: panels mount
 *      lazily on first display, so at boot the mounted set is empty and
 *      the old mounted-based prune deleted every key on the first
 *      rebuild after a restart, then persisted the emptied pref. With
 *      the registry as the source, pruning still fires only for
 *      genuinely deleted panels, and is SKIPPED entirely if the
 *      registry is unreadable or empty (fail-safe: never prune on
 *      incomplete knowledge).
 *  - CONTEXT MENU UI ("Auto-Reload…" + standalone ladder popup):
 *    - WHY STANDALONE (v2.3.0): an event spy at document capture level
 *      proved that #webpanel-context receives NO popup events during
 *      the vanish sequence - Floorp rebuilds the popup from a
 *      DOCUMENT-LEVEL CAPTURE handler (a popupshowing observed at
 *      main-window), which runs before any suppression inside the popup
 *      (element capture, bubble-phase boundaries) can act. Every nested
 *      submenu placed inside #webpanel-context is therefore doomed: the
 *      wipe is unreachable. Solution: the ladder lives in OUR OWN
 *      menupopup, attached to the document root. Its events never
 *      traverse #webpanel-context at all - the bug class is eliminated
 *      rather than fought.
 *    - FLOW: right-click resolves the target panel (event-path stash ->
 *      triggerNode -> displayed panel); the "Auto-Reload…" menuitem
 *      shows for web panels, hides for static ones. Clicking it hides
 *      Floorp's popup and opens our ladder popup at the original
 *      right-click position (screen coords stashed from the contextmenu
 *      event). Choosing an interval writes floorptweaks.panelReload;
 *      Disable deletes the entry (unset = no auto-reload).
 *    - RADIO CHECKMARKS: for type=radio XUL menuitems, setting
 *      checked="false" as an attribute is not reliably "unchecked" - the
 *      group can end up displaying the LAST member as checked. The sync
 *      SETS the checked attribute on the matching item and REMOVES it
 *      entirely from all others.
 *  - STARTUP MOUNT VIA SIMULATED CLICKS: configured panels without a
 *    mounted browser are click-mounted through Floorp's own code path,
 *    then the previously displayed panel is restored. FALLBACK: synthetic
 *    mount (tagged psar-synthetic, first-reveal reload nudge).
 *  - PROGRESS BAR OVERLAY (countdown): for every panel with an armed
 *    timer, a two-part bar is appended to the panel's tile:
 *      <div class="ft-progress" role="progressbar" aria-valuenow="86">
 *        <div class="reloading" style="width: 86%;"></div>
 *      </div>
 *    Starts at 100% after a reload, drains to 0% before the next.
 *  - BAR STYLING (Floorp theme variables):
 *      .ft-progress           background var(--background-color-list-item-hover)
 *                             width 55%, margin-inline auto, bottom 2px
 *      .ft-progress .reloading
 *                             background var(--border-color)
 *  - STABLE TIMERS: the MutationObserver-driven rebuild computes a
 *    signature of the desired timer set and returns early if it matches
 *    the running one; nextFire values are carried across genuine rebuilds.
 *  - RELOAD VISIBILITY: panels reload even when mounted but hidden (as
 *    long as Floorp has not unloaded them). Set
 *    { "minutes": N, "onlyWhenVisible": true } per entry to reload only
 *    while that panel is displayed.
 *
 * CONFIG EXAMPLE (about:config, new String pref) - UUID keys only:
 *   floorptweaks.panelReload  =  {
 *     "531760b6-0762-4096-bdca-cfaa6201cb0c": 5,
 *     "5c4cbc5f-2b93-43ed-bc95-d5bd5e7196c9": { "minutes": 60,
 *                                               "onlyWhenVisible": true }
 *   }
 *
 * STYLING HOOKS for userChrome.css (optional overrides):
 *   .ft-progress   - the track
 *   .ft-progress .reloading - the fill (width driven by the script)
 *
 * LOGGING: console output tagged "[Floorp-Tweaks]"; printed only when
 * DEBUG is true (disabled by default). Watch the Browser Console
 * (Ctrl+Shift+J).
 */

(() => {
  // Guard FIRST: in a non-browser chrome window there is no gBrowser and
  // nothing below may run.
  if (!window.gBrowser || window.__psarLoaded) return;
  window.__psarLoaded = true;

  const LOG_TAG = "[Floorp-Tweaks][PanelReload]";
  const DEBUG   = false;
  const log     = (...a) => { if (DEBUG) console.log(LOG_TAG, ...a); };
  const logErr  = (...a) => { if (DEBUG) console.error(LOG_TAG, ...a); };

  const g        = window.gBrowser;
  const PREF     = "floorptweaks.panelReload";
  const DATA_PREF = "floorp.panelSidebar.data"; // read-only for us
  const MIN_MS   = 30_000; // clamp: never reload faster than every 30 s
  const MOUNT_DELAY_MS = 4000; // let Floorp finish building the sidebar
  const BAR_UPDATE_MS = 500;   // progress bar refresh cadence
  const CTX_FRESH_MS = 5000;   // context event stash lifetime

  // Vivaldi-style fixed ladder (minutes). 0 = disable.
  const LADDER = [1, 2, 5, 10, 30, 60, 90];

  const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

  // ------------------------- config I/O ----------------------------------
  // UUID keys only (2.x). No migration, no URL-substring matching:
  // config is either written by the context menu (canonical) or hand-set
  // in about:config with full UUID keys.
  const readRawConfig = () => {
    try {
      return JSON.parse(Services.prefs.getStringPref(PREF, "{}")) || {};
    } catch (e) {
      logErr("Pref is not valid JSON - treating as empty:", e.message || e);
      return {};
    }
  };

  const writeRawConfig = (obj) => {
    Services.prefs.setStringPref(PREF, JSON.stringify(obj));
  };

  // UUIDs of all DEFINED web panels, from floorp.panelSidebar.data -
  // Floorp's own registry of defined panels (array entries with a UUID
  // "id"; it has historically appeared as a plain array and as an
  // object carrying a "data" array, so accept both shapes). Used as the
  // prune set: a panel that is merely NOT YET MOUNTED (lazy mounting,
  // before its first display) must never have its config key deleted.
  // An unreadable or empty registry returns an empty set; callers MUST
  // treat empty as "do not prune" (never prune on incomplete knowledge).
  const definedPanelUuids = () => {
    const out = new Set();
    try {
      const raw = Services.prefs.getStringPref(DATA_PREF, "");
      if (!raw) return out;
      const parsed = JSON.parse(raw);
      const entries = Array.isArray(parsed) ? parsed
        : Array.isArray(parsed?.data) ? parsed.data
        : Object.values(parsed || {});
      for (const entry of entries) {
        if (entry && typeof entry.id === "string") {
          out.add(entry.id.toLowerCase());
        }
      }
    } catch (e) {
      logErr("floorp.panelSidebar.data unreadable - pruning disabled:",
        e.message || e);
    }
    return out;
  };

  // Remove config keys matching no DEFINED panel UUID (orphans left by
  // deleted panels). Callers pass the DEFINED-panel set and skip the
  // call entirely when it is empty.
  const pruneOrphanKeys = (definedUuids) => {
    const raw = readRawConfig();
    let dirty = false;
    for (const key of Object.keys(raw)) {
      if (!definedUuids.has(key.toLowerCase())) {
        delete raw[key];
        dirty = true;
        log("Pruned orphaned config key", key);
      }
    }
    if (dirty) {
      lastTimerSig = null; // avoid re-arming from stale state
      writeRawConfig(raw);
    }
  };

  // Normalises a config object into Map<uuid, {ms, onlyWhenVisible, preload}>.
  const parseConfig = (obj) => {
    const map = new Map();
    for (const [key, val] of Object.entries(obj || {})) {
      if (!UUID_RE.test(key)) {
        logErr(`Ignoring non-UUID config key "${key}" (UUID keys only)`);
        continue;
      }
      let minutes, onlyWhenVisible = false, preload = true;
      if (typeof val === "number") {
        minutes = val;
      } else if (val && typeof val === "object") {
        minutes = Number(val.minutes);
        onlyWhenVisible = val.onlyWhenVisible === true;
        preload = val.preload !== false;
      } else {
        logErr(`Bad value for "${key}" - expected number or object`);
        continue;
      }
      if (!Number.isFinite(minutes) || minutes <= 0) {
        logErr(`Bad minutes for "${key}" - skipping`);
        continue;
      }
      map.set(key.toLowerCase(), {
        ms: Math.max(MIN_MS, minutes * 60_000),
        onlyWhenVisible,
        preload,
      });
    }
    return map;
  };

  const getConfig = () => parseConfig(readRawConfig());

  // -------------------- safe helpers (never throw) -----------------------
  const safeUri = (b) => {
    try {
      return (b.currentURI && b.currentURI.spec) || "";
    } catch (e) {
      return b.getAttribute("src") || "";
    }
  };

  // ----------------------- panel browser discovery -----------------------
  const isPanelBrowser = (b) => {
    try {
      if (!b.tagName || b.tagName !== "browser") return false;
      if (g.browsers.includes(b)) return false; // a real content tab
      return b.classList?.contains("sidebar-panel-browser") ||
             /^sidebar-panel-[0-9a-f]{8}-/i.test(b.id || "");
    } catch (e) {
      return false;
    }
  };

  const discoverPanels = () =>
    [...document.querySelectorAll("browser.sidebar-panel-browser")]
      .filter((b) => isPanelBrowser(b));

  // Panel UUID: from the browser id, else the floorpWebPanelId src param.
  const panelUuid = (b) => {
    let m = /^sidebar-panel-([0-9a-f-]{36})$/i.exec(b.id || "");
    if (!m) {
      m = /floorpWebPanelId=([0-9a-f-]{36})/i.exec(safeUri(b));
    }
    return m ? m[1].toLowerCase() : null;
  };

  const panelVisible = (b) => {
    try {
      if (b.hidden || b.hasAttribute("hidden")) return false;
      if (b.collapsed) return false;
      const r = b.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    } catch (e) {
      return false;
    }
  };

  // ------------------- click-based startup mounting ----------------------
  const panelEntryEl = (uuid) =>
    document.querySelector(
      `#panel-sidebar-select-box .web[data-panel-id="${uuid}"]`);

  const clickPanelEntry = (el) => {
    for (const type of ["mousedown", "mouseup", "click"]) {
      try {
        el.dispatchEvent(new MouseEvent(type,
          { bubbles: true, cancelable: true, view: window }));
      } catch (e) { /* keep going - el.click() below is the fallback */ }
    }
    try { el.click(); } catch (e) { logErr("click failed:", e); }
  };

  const currentlyDisplayedUuid = () => {
    for (const b of discoverPanels()) {
      if (panelVisible(b)) return panelUuid(b);
    }
    return null;
  };

  const waitForMounted = async (uuid, timeoutMs = 4000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (document.getElementById(`sidebar-panel-${uuid}`)) return true;
      await sleep(200);
    }
    return false;
  };

  // Fallback only: hand-built browser element.
  const pendingMounts = new Set();

  const mountBrowserFor = (uuid) => {
    const box = document.getElementById("panel-sidebar-browser-box");
    if (!box) return false;
    if (document.getElementById(`sidebar-panel-${uuid}`) ||
        pendingMounts.has(uuid)) return true;
    pendingMounts.add(uuid);

    try {
      const b = document.createXULElement("browser");
      b.id = `sidebar-panel-${uuid}`;
      b.classList.add("sidebar-panel-browser");

      const template = box.querySelector("browser.sidebar-panel-browser");
      if (template) {
        for (const attr of template.attributes) {
          if (!["id", "src", "hidden", "collapsed"].includes(attr.name)) {
            b.setAttribute(attr.name, attr.value);
          }
        }
      }
      b.setAttribute("src",
        `chrome://browser/content/browser.xhtml?floorpWebPanelId=${uuid}`);
      b.setAttribute("psar-synthetic", "true");
      b.setAttribute("hidden", "true");
      box.appendChild(b);
      log("Fallback synthetic mount for", uuid);
      return true;
    } catch (e) {
      logErr("Synthetic mount failed for", uuid, e);
      return false;
    } finally {
      setTimeout(() => pendingMounts.delete(uuid), 1000);
    }
  };

  // ------------------- first-reveal reload (synthetics) ------------------
  const revealedOnce = new WeakSet();

  const checkFirstReveal = () => {
    for (const b of discoverPanels()) {
      if (!b.hasAttribute("psar-synthetic") || revealedOnce.has(b)) continue;
      if (panelVisible(b) && b.isConnected) {
        revealedOnce.add(b);
        setTimeout(() => {
          try {
            if (b.isConnected && panelVisible(b)) {
              log("First reveal of synthetic panel - reloading", b.id);
              b.reload();
            }
          } catch (e) { logErr("First-reveal reload failed:", e); }
        }, 300);
      }
    }
  };

  // ------------------- progress bar overlay ------------------------------
  const progressState = new Map(); // uuid -> { ms, nextFire }
  const BAR_STYLE_ID = "psar-reload-progress-style";
  const TRACK_CLASS = "ft-progress";
  const FILL_CLASS  = "reloading";
  const TRACK_WIDTH = "55%";

  const ensureBarStyles = () => {
    if (document.getElementById(BAR_STYLE_ID)) return;
    const style = document.createElementNS(
      "http://www.w3.org/1999/xhtml", "style");
    style.id = BAR_STYLE_ID;
    style.textContent = `
      #panel-sidebar-select-box .panel-sidebar-button-wrapper {
        position: relative;
      }
      .${TRACK_CLASS} {
        position: absolute;
        inset-inline: 0;
        bottom: 2px;
        height: 3px;
        width: ${TRACK_WIDTH};
        margin-inline: auto;
        pointer-events: none;
        overflow: hidden;
        border-radius: 2px;
        background: var(--background-color-list-item-hover);
      }
      .${TRACK_CLASS} .${FILL_CLASS} {
        height: 100%;
        width: 100%;
        background: var(--border-color);
      }`;
    document.documentElement.appendChild(style);
  };

  // Attach a track+fill bar to a panel's selector tile (idempotent).
  const ensureBar = (uuid) => {
    const wrapper =
      panelEntryEl(uuid)?.closest(".panel-sidebar-button-wrapper") ||
      panelEntryEl(uuid);
    if (!wrapper) return null;
    let track = wrapper.querySelector(`:scope > .${TRACK_CLASS}`);
    if (!track) {
      track = document.createElementNS("http://www.w3.org/1999/xhtml", "div");
      track.classList.add(TRACK_CLASS);
      track.setAttribute("psar-bar", uuid);
      track.setAttribute("role", "progressbar");
      track.setAttribute("aria-valuemin", "0");
      track.setAttribute("aria-valuemax", "100");
      track.setAttribute("aria-label", "Time until next auto-reload");
      const fill = document.createElementNS(
        "http://www.w3.org/1999/xhtml", "div");
      fill.classList.add(FILL_CLASS);
      track.appendChild(fill);
      wrapper.appendChild(track);
    }
    return track;
  };

  // Remove bars for panels no longer configured.
  const pruneBars = (activeUuids) => {
    for (const track of document.querySelectorAll(`.${TRACK_CLASS}`)) {
      const uuid = track.getAttribute("psar-bar");
      if (!activeUuids.has(uuid)) track.remove();
    }
  };

  // DEPLETING fill: 100% right after a reload, 0% when the next is due.
  const updateBars = () => {
    const now = Date.now();
    for (const [uuid, st] of progressState) {
      const track = ensureBar(uuid);
      if (!track) continue;
      const remain = st.nextFire - now;
      const frac = st.ms > 0
        ? Math.min(1, Math.max(0, remain / st.ms))
        : 0;
      const pct = Math.round(frac * 100);
      track.querySelector(`:scope > .${FILL_CLASS}`)
        .style.width = `${pct}%`;
      track.setAttribute("aria-valuenow", String(pct));
      track.setAttribute("title",
        `Auto-reload: ${Math.max(0, Math.ceil(remain / 1000))} s remaining` +
        ` (every ${Math.round(st.ms / 60000)} min)`);
    }
  };

  setInterval(updateBars, BAR_UPDATE_MS);

  // ------------- context menu: "Auto-Reload…" + standalone popup ---------
  const CTX_POPUP_ID = "webpanel-context";
  const ITEM_ID = "ft-reload-item";       // menuitem inside Floorp's popup
  const ITEM_LABEL = "Auto-Reload…";
  const LADDER_POPUP_ID = "ft-reload-ladder"; // OUR popup, document root
  const RADIO_GROUP = "ft-reload-group";
  const MENU_STYLE_ID = "ft-reload-menu-style";

  // Target panel + click position, captured from the contextmenu event
  // (capture phase) with a timestamp so a stale stash cannot bleed.
  let ctxUuid = null;
  let ctxCapturedAt = 0;
  let ctxScreenX = 0;
  let ctxScreenY = 0;

  // Walk an event's composed path for a web-panel target.
  const uuidFromEventPath = (event) => {
    const path = (event.composedPath && event.composedPath()) || [];
    for (const node of path) {
      try {
        if (!node || !node.getAttribute) continue;
        if (node.matches?.("[data-panel-id]") ||
            node.getAttribute?.("data-panel-id")) {
          const u = node.getAttribute("data-panel-id")?.toLowerCase();
          if (u) return { uuid: u, via: "event-path-tile" };
        }
        if (isPanelBrowser(node)) {
          const u = panelUuid(node);
          if (u) return { uuid: u, via: "event-path-browser" };
        }
      } catch (e) { /* next node */ }
    }
    return null;
  };

  // Capture-phase listener: stash the target + position before the
  // popup opens.
  const onGlobalContextMenu = (event) => {
    try {
      const resolved = uuidFromEventPath(event);
      if (resolved) {
        ctxUuid = resolved.uuid;
        ctxCapturedAt = Date.now();
        ctxScreenX = event.screenX || 0;
        ctxScreenY = event.screenY || 0;
        log("Context event target:", ctxUuid, `(via ${resolved.via})`);
      } else {
        // No panel target in the path - invalidate any stash.
        ctxUuid = null;
        ctxCapturedAt = 0;
        log("Context event: no panel target in path");
      }
    } catch (e) { logErr("contextmenu capture failed:", e); }
  };
  window.addEventListener("contextmenu", onGlobalContextMenu, true);

  const entryMinutes = (uuid) => {
    const val = readRawConfig()[uuid];
    return typeof val === "number" ? val
      : val && typeof val === "object" ? Number(val.minutes) : NaN;
  };

  const setIntervalForUuid = (uuid, minutes) => {
    const raw = readRawConfig();
    if (minutes === 0) {
      // Disable: remove the entry entirely (unset = no auto-reload).
      delete raw[uuid];
      log("Disabled auto-reload for", uuid);
    } else {
      const prev = raw[uuid];
      if (prev && typeof prev === "object") {
        raw[uuid] = { ...prev, minutes };
      } else {
        raw[uuid] = minutes;
      }
      log("Set auto-reload for", uuid, "to", minutes, "min");
    }
    lastTimerSig = null; // config edits must always re-arm
    writeRawConfig(raw);
  };

  // The panel the currently open context menu is targeting, kept between
  // popupshowing and the ladder item command handlers.
  let ctxMenuTarget = null;

  // Sync the radio checkmark. IMPORTANT (XUL quirk): for type=radio
  // menuitems, checked="false" is not reliably "unchecked" - the group
  // can end up displaying the LAST member as checked. Set the attribute
  // only on the match; REMOVE it from everything else.
  const syncRadioChecked = (minutes) => {
    const ladder = document.getElementById(LADDER_POPUP_ID);
    if (!ladder) return;
    for (const item of ladder.querySelectorAll("menuitem[ft-minutes]")) {
      const itemMinutes = Number(item.getAttribute("ft-minutes"));
      if (itemMinutes === minutes) {
        item.setAttribute("checked", "true");
      } else {
        item.removeAttribute("checked");
      }
    }
  };

  // Build (or rebuild) the "Auto-Reload…" item inside Floorp's popup.
  const buildAndInsertMenuItem = () => {
    const popup = document.getElementById(CTX_POPUP_ID);
    if (!popup) return;
    document.getElementById(ITEM_ID)?.remove();

    const item = document.createXULElement("menuitem");
    item.id = ITEM_ID;
    item.setAttribute("label", ITEM_LABEL);
    item.addEventListener("command", () => {
      if (!ctxMenuTarget) return;
      // Close Floorp's popup, then open OUR ladder popup at the original
      // right-click position. Our popup is attached to the document
      // root, so none of its events traverse #webpanel-context.
      try {
        popup.hidePopup();
      } catch (e) { /* already closing */ }
      openLadderPopup();
    });

    // Place after Floorp's unload item, before its trailing separator.
    const first = popup.firstElementChild;
    if (first) {
      popup.insertBefore(item, first.nextElementSibling || null);
    } else {
      popup.appendChild(item);
    }
    log("Auto-Reload menu item (re-)injected into #webpanel-context");
  };

  // Build our standalone ladder popup once. Attached to the document
  // ROOT - deliberately NOT inside #webpanel-context (see v2.3.0 note).
  const buildLadderPopup = () => {
    let ladder = document.getElementById(LADDER_POPUP_ID);
    if (ladder) ladder.remove();

    ladder = document.createXULElement("menupopup");
    ladder.id = LADDER_POPUP_ID;

    for (const m of LADDER) {
      const mi = document.createXULElement("menuitem");
      mi.setAttribute("type", "radio");
      mi.setAttribute("name", RADIO_GROUP);
      mi.setAttribute("label", `${m} Minute${m > 1 ? "s" : ""}`);
      mi.setAttribute("ft-minutes", String(m));
      mi.addEventListener("command", () => {
        if (ctxMenuTarget) setIntervalForUuid(ctxMenuTarget, m);
      });
      ladder.appendChild(mi);
    }

    // Separator, then Disable (Vivaldi's layout).
    ladder.appendChild(document.createXULElement("menuseparator"));
    const off = document.createXULElement("menuitem");
    off.setAttribute("type", "radio");
    off.setAttribute("name", RADIO_GROUP);
    off.setAttribute("label", "Disable");
    off.setAttribute("ft-minutes", "0");
    off.addEventListener("command", () => {
      if (ctxMenuTarget) setIntervalForUuid(ctxMenuTarget, 0);
    });
    ladder.appendChild(off);

    document.documentElement.appendChild(ladder);
    log("Ladder popup created (standalone, at document root)");
  };

  // Open our ladder popup at the stashed right-click position.
  const openLadderPopup = () => {
    const ladder = document.getElementById(LADDER_POPUP_ID);
    if (!ladder || !ctxMenuTarget) return;
    syncRadioChecked(
      Number.isFinite(entryMinutes(ctxMenuTarget))
        ? entryMinutes(ctxMenuTarget) : 0);
    try {
      ladder.openPopupAtScreen(ctxScreenX, ctxScreenY, false);
    } catch (e) {
      logErr("openPopupAtScreen failed - centred fallback:", e);
      try { ladder.openPopupAtScreen(-1, -1, false); } catch (e2) {}
    }
  };

  const onCtxShowing = (event) => {
    const popup = document.getElementById(CTX_POPUP_ID);
    if (!popup || !event) return;

    // Only react to the PARENT popup opening - bubbled events from
    // Floorp's own children must not re-run targeting.
    if (event.target !== popup) return;

    // Self-healing: if something wiped our item, rebuild it before the
    // popup is displayed.
    if (!document.getElementById(ITEM_ID)) buildAndInsertMenuItem();
    if (!document.getElementById(LADDER_POPUP_ID)) buildLadderPopup();

    const item = document.getElementById(ITEM_ID);
    if (!item) return;

    // 1) Fresh event-path stash FIRST.
    let resolved = null;
    if (ctxUuid && (Date.now() - ctxCapturedAt) < CTX_FRESH_MS) {
      resolved = { uuid: ctxUuid, via: "stash" };
    }
    // 2) triggerNode chain as backup.
    if (!resolved) {
      try {
        const tn = popup.triggerNode;
        const tile = tn?.closest?.("[data-panel-id]");
        const tu = tile?.getAttribute("data-panel-id")?.toLowerCase();
        if (tu) resolved = { uuid: tu, via: "triggerNode-tile" };
        if (!resolved && tn) {
          const pb = tn.closest?.("browser.sidebar-panel-browser");
          const pu = pb ? panelUuid(pb) : null;
          if (pu) resolved = { uuid: pu, via: "triggerNode-browser" };
        }
      } catch (e) { /* fall through */ }
    }
    // 3) Currently displayed panel as last resort.
    if (!resolved) {
      const disp = currentlyDisplayedUuid();
      if (disp) resolved = { uuid: disp, via: "displayed" };
    }

    // Consume the stash: the next open must re-resolve.
    ctxUuid = null;
    ctxCapturedAt = 0;

    log("Context menu target:", resolved ?
      `${resolved.uuid} (via ${resolved.via})` : "(none - hiding item)");

    if (!resolved?.uuid) {
      // No web-panel target (e.g. a static panel) - hide our item.
      item.setAttribute("hidden", "true");
      ctxMenuTarget = null;
      return;
    }
    ctxMenuTarget = resolved.uuid;
    item.removeAttribute("hidden");
  };

  const ensureMenuStyles = () => {
    if (document.getElementById(MENU_STYLE_ID)) return;
    const style = document.createXULElement("style");
    style.id = MENU_STYLE_ID;
    style.textContent = `
      #${ITEM_ID}[hidden] { display: none; }`;
    document.documentElement.appendChild(style);
  };

  const ensureContextItems = () => {
    const popup = document.getElementById(CTX_POPUP_ID);
    if (!popup) return;
    if (!document.getElementById(ITEM_ID)) buildAndInsertMenuItem();
    if (!document.getElementById(LADDER_POPUP_ID)) buildLadderPopup();
    // Wire handlers once (idempotent via a flag attribute).
    if (!popup.hasAttribute("ft-reload-wired")) {
      popup.setAttribute("ft-reload-wired", "true");
      popup.addEventListener("popupshowing", onCtxShowing);
      log("Popup handlers wired for #webpanel-context");
    }
  };

  // Mount every configured panel that has no browser element yet, via
  // simulated clicks on the panel selector; restore prior display after.
  const mountConfiguredPanels = async () => {
    const cfg = getConfig();
    if (!cfg.size) return;

    const todo = [];
    for (const uuid of cfg.keys()) {
      if (!document.getElementById(`sidebar-panel-${uuid}`)) todo.push(uuid);
    }
    if (!todo.length) return;

    const original = currentlyDisplayedUuid();
    log("Startup mount via clicks for:", todo.join(", "),
        "| restoring", original || "(none)");

    for (const uuid of todo) {
      const el = panelEntryEl(uuid);
      if (!el) {
        logErr("No selector entry for panel", uuid, "- synthetic fallback");
        mountBrowserFor(uuid);
        continue;
      }
      clickPanelEntry(el);
      if (await waitForMounted(uuid)) {
        log("Natively mounted", uuid, "via simulated click");
      } else {
        logErr("Click did not mount", uuid, "- synthetic fallback");
        mountBrowserFor(uuid);
      }
      await sleep(300); // let Floorp settle between panel switches
    }

    if (original) {
      const origEl = panelEntryEl(original);
      if (origEl) {
        clickPanelEntry(origEl);
        log("Restored previously displayed panel", original);
      }
    }
  };

  // ------------------------------ engine ---------------------------------
  const timers = [];       // [{browser, intervalId, uuid, ms}]
  let lastTimerSig = null; // signature of the currently armed timer set

  const teardown = () => {
    for (const t of timers) clearInterval(t.intervalId);
    timers.length = 0;
  };

  const build = () => {
    try {
      const cfg = getConfig();
      const panels = discoverPanels();

      // Desired timer set, as a comparable signature.
      const desired = [];
      for (const b of panels) {
        const uuid = panelUuid(b);
        if (!uuid) continue;
        const entry = cfg.get(uuid);
        if (!entry) continue;
        desired.push({
          uuid,
          ms: entry.ms,
          onlyWhenVisible: entry.onlyWhenVisible,
          browser: b,
        });
      }
      const sig = desired
        .map((d) => `${d.uuid}:${d.ms}:${d.onlyWhenVisible}`)
        .sort()
        .join("|");

      // Prune config keys for panels that no longer EXIST (deleted web
      // panels leave orphans otherwise). FIXED in v2.2.0: the known set
      // comes from the DEFINED panel registry (floorp.panelSidebar.data),
      // NOT from mounted browsers. Panels mount lazily on first display,
      // so a mounted-only set is EMPTY at boot and pruning against it
      // deleted every config key on the first rebuild after a restart,
      // then persisted the emptied pref. Empty registry => skip pruning
      // entirely (never prune on incomplete knowledge).
      const defined = definedPanelUuids();
      if (defined.size) pruneOrphanKeys(defined);

      if (sig === lastTimerSig) {
        // Nothing relevant changed - DO NOT touch timers or nextFire.
        pruneBars(new Set(desired.map((d) => d.uuid)));
        updateBars();
        return;
      }
      lastTimerSig = sig;

      // Genuine change: carry over nextFire for unchanged panels.
      const oldState = new Map(progressState);
      teardown();
      progressState.clear();
      pruneBars(new Set(desired.map((d) => d.uuid)));
      ensureBarStyles();

      log("Discovered panel browsers:",
          panels.map((b) => {
            const u = panelUuid(b);
            return `${b.id}${b.hasAttribute("psar-synthetic")
              ? " [synthetic]" : ""} <- ${u || "(unknown)"}`;
          }));

      const now = Date.now();
      for (const d of desired) {
        const prev = oldState.get(d.uuid);
        const nextFire =
          prev && prev.ms === d.ms && prev.nextFire > now
            ? prev.nextFire
            : now + d.ms;
        progressState.set(d.uuid, { ms: d.ms, nextFire });

        const intervalId = setInterval(() => {
          try {
            if (d.browser.isConnected &&
                (!d.onlyWhenVisible || panelVisible(d.browser))) {
              log("Reloading", d.browser.id, "(panel", d.uuid + ")");
              d.browser.reload();
            } else {
              log("Skip reload (hidden/disconnected):", d.browser.id);
            }
            const st = progressState.get(d.uuid);
            if (st) st.nextFire = Date.now() + d.ms;
          } catch (e) { logErr("Reload failed:", e); }
        }, d.ms);
        timers.push({ browser: d.browser, intervalId, uuid: d.uuid, ms: d.ms });
        log(`Watching ${d.browser.id} every ${d.ms / 60000} min ` +
            `(visible-only: ${d.onlyWhenVisible})`);
      }
      updateBars();
      log(`Matched ${desired.length}/${panels.length} mounted panels to ` +
          `${cfg.size} config entries`);
    } catch (e) {
      logErr("build() failed:", e);
    }
  };

  // ---- keep timers aligned with panel lifecycle and config changes ------
  new MutationObserver(() => {
    clearTimeout(build._t);
    build._t = setTimeout(() => { build(); checkFirstReveal(); }, 500);
  }).observe(document.body, { childList: true, subtree: true });

  const mountBox = document.getElementById("panel-sidebar-browser-box");
  if (mountBox) {
    new MutationObserver(() => {
      clearTimeout(checkFirstReveal._t);
      checkFirstReveal._t = setTimeout(checkFirstReveal, 250);
    }).observe(mountBox, {
      childList: true, subtree: true, attributes: true,
      attributeFilter: ["hidden", "collapsed"],
    });
  }

  Services.prefs.addObserver(PREF, () => {
    log("Config pref changed - rebuilding timers");
    try {
      lastTimerSig = null; // config edits must always re-arm
      mountConfiguredPanels(); // newly added entries get mounted too
      build();
    } catch (e) { logErr("Rebuild after pref change failed:", e); }
  });

  window.addEventListener("unload", teardown);

  // Boot: let Floorp finish building the sidebar, then inject the context
  // menu, click-mount the configured panels and arm their timers.
  setTimeout(() => {
    try {
      ensureContextItems();
      ensureMenuStyles();
      mountConfiguredPanels();
      build();
    } catch (e) { logErr("Startup mount/build failed:", e); }
  }, MOUNT_DELAY_MS);
})();
