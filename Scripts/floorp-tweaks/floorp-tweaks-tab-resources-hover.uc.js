// ==UserScript==
// @name           Tab Resource Preview (Floorp)
// @description    Shows per-tab memory and CPU% in the tab hover preview
//                 panel (#tab-preview-panel). Samples ChromeUtils.
//                 requestProcInfo() — the API behind about:processes — and
//                 maps web processes to tabs via windows[].outerWindowID
//                 with a tabFinder map (from mozilla-central
//                 aboutProcesses.js, MPL-2.0). The info line is inserted
//                 INSIDE the native card's text container
//                 (.tab-preview-text-container), after Floorp's own
//                 PID/activeness rows, so it sits at the bottom of the
//                 hover card and inherits the card's native padding, font
//                 and theme. Unloaded/hibernated tabs show "Hibernated"
//                 (detected via the tab's pending attribute); a tab with
//                 no sample yet shows "Not loaded". A MutationObserver
//                 re-inserts the line whenever Floorp rebuilds the card,
//                 guarded by state comparison so injection can never loop.
//                 Startup is deferred to
//                 browser-delayed-startup-finished. Figures are per
//                 process: tabs sharing a content process show the same
//                 values. CPU% appears from the second sample.
// @version        1.4.1
// @author         Conor
// @license        MPL-2.0
// @include        main
// ==/UserScript==

"use strict";

(() => {
  if (window.__floorpTweaksTabResourcePreviewLoaded) return;
  window.__floorpTweaksTabResourcePreviewLoaded = true;

  const LOGTAG = "[Floorp-Tweaks][tab-resource-preview] ";

  // ---------------- tweakables ----------------
  const SAMPLE_INTERVAL_MS = 5000; // polling cadence for process info
  const OMIT_WHEN_NO_DATA = false; // true = show nothing instead of a label
  // ---------------------------------------------

  /* ---------------------------------------------------------------
   * tabFinder — copied from mozilla-central aboutProcesses.js
   * --------------------------------------------------------------- */
  const tabFinder = {
    update() {
      this._map = new Map();
      for (let win of Services.wm.getEnumerator("navigator:browser")) {
        const tabbrowser = win.gBrowser;
        if (!tabbrowser) continue;
        for (let browser of tabbrowser.browsers) {
          const id = browser.outerWindowID;
          if (id != null) this._map.set(id, browser);
        }
        if (tabbrowser.preloadedBrowser) {
          const browser = tabbrowser.preloadedBrowser;
          if (browser.outerWindowID) {
            this._map.set(browser.outerWindowID, browser);
          }
        }
      }
    },

    get(id) {
      const browser = this._map.get(id);
      if (!browser) return null;
      const tabbrowser = browser.getTabBrowser();
      if (!tabbrowser) return null;
      return { tabbrowser, tab: tabbrowser.getTabForBrowser(browser) };
    },
  };

  // ---------------- sampling ----------------
  let prevSnapshot = null;
  const tabResources = new Map(); // <tab element> -> { mem, cpu, pid, origin }
  let dataVersion = 0;

  function takeSnapshot() {
    const date = ChromeUtils.now();
    return ChromeUtils.requestProcInfo().then((main) => {
      const processes = new Map([[main.pid, main]]);
      for (const child of main.children) {
        child.date = date;
        processes.set(child.pid, child);
      }
      return { processes, date };
    });
  }

  function formatBytes(n) {
    //if (n >= 1024 ** 3) return Math.round(n / 1024 ** 3) + " GB";
    if (n >= 1024 ** 3) return Math.round((n / 1024 ** 3 * 100)) / 100 + " GB";
    if (n >= 1024 ** 2) return Math.round(n / 1024 ** 2) + " MB";
    if (n >= 1024) return Math.round(n / 1024) + " KB";
    return n + " B";
  }

  const WEB_TYPES = new Set([
    "web",
    "webIsolated",
    "webServiceWorker",
    "withCoopCoep",
  ]);

  async function updateTabResources() {
    try {
      const snap = await takeSnapshot();

      if (prevSnapshot) {
        tabFinder.update();
        tabResources.clear();

        for (const cur of snap.processes.values()) {
          if (!WEB_TYPES.has(cur.type)) continue;

          const prev = prevSnapshot.processes.get(cur.pid);
          const deltaT_ns = prev ? (cur.date - prev.date) * 1e6 : 0;
          const cpuPct =
            prev && deltaT_ns > 0
              ? ((cur.cpuTime - prev.cpuTime) / deltaT_ns) * 100
              : null;

          const info = {
            mem: cur.memory,
            cpu: cpuPct,
            pid: cur.pid,
            origin: cur.origin || "",
          };

          for (const win of cur.windows || []) {
            const found = tabFinder.get(win.outerWindowId);
            if (found && found.tab) {
              tabResources.set(found.tab, info);
            }
          }
        }
        dataVersion++;
      }

      prevSnapshot = snap;
    } catch (err) {
      console.error(LOGTAG + "sampling failed:", err);
    }
  }

  // ---------------- start (deferred) ----------------
  function start() {
    updateTabResources();
    window.setInterval(updateTabResources, SAMPLE_INTERVAL_MS);
    console.info(LOGTAG + "running.");
  }

  if (window.gBrowserInit && window.gBrowserInit.delayedStartupFinished) {
    start();
  } else {
    const obs = {
      observe(subject, topic) {
        if (topic === "browser-delayed-startup-finished" && subject === window) {
          Services.obs.removeObserver(obs, topic);
          start();
        }
      },
    };
    Services.obs.addObserver(obs, "browser-delayed-startup-finished");
  }

  // ---------------- hover tracking ----------------
  let hoveredTab = null;
  let lastInjectedVersion = -1;
  let lastInjectedTab = null;

  const tabstrip = gBrowser.tabContainer;
  tabstrip.addEventListener("mouseover", (e) => {
    const tab = e.target.closest?.("tab.tabbrowser-tab");
    if (tab !== hoveredTab) {
      hoveredTab = tab;
      lastInjectedVersion = -1;
      refreshPanel();
    }
  });
  tabstrip.addEventListener("mouseleave", () => {
    hoveredTab = null;
  });

  // ---------------- preview panel injection ----------------
  const panel = document.getElementById("tab-preview-panel");
  if (!panel) {
    console.warn(LOGTAG + "#tab-preview-panel not found in this build.");
    return;
  }

  let infoEl = null;

  function isPanelVisible() {
    return !panel.hidden && !panel.hasAttribute("collapsed");
  }

  // Confirmed Floorp panel structure (v1.2.0 DOM dump):
  //
  //   panel#tab-preview-panel (flex)
  //   ├─ html:div.tab-preview-content-interactive   <- NOT the card body
  //   └─ html:div.tab-preview-content-main          <- the real card
  //       ├─ .tab-preview-thumbnail-container
  //       └─ .tab-preview-text-container            <- block flow; our line
  //                                                    goes after the
  //                                                    PID/activeness row.
  function textContainer() {
    const main = panel.querySelector(".tab-preview-content-main");
    if (!main) return null;
    return main.querySelector(".tab-preview-text-container") || main;
  }

  function refreshPanel() {
    if (!isPanelVisible()) return;

    const container = textContainer();
    if (!container) return;

    const oursGone = !infoEl || !container.contains(infoEl);
    const newData = dataVersion !== lastInjectedVersion;
    const newTab = hoveredTab !== lastInjectedTab;

    if (oursGone || newTab || newData) {
      injectIntoPanel(container);
    }
  }

  function injectIntoPanel(container) {
    lastInjectedVersion = dataVersion;
    lastInjectedTab = hoveredTab;

    if (infoEl && infoEl.isConnected) infoEl.remove();

    const info = hoveredTab ? tabResources.get(hoveredTab) : null;

    // No data: distinguish the two known causes. A pending tab is
    // unloaded/hibernated by Floorp; anything else means we have not
    // sampled that tab's process yet (fresh hover, or a non-web page).
    if (!info && OMIT_WHEN_NO_DATA) return;

    infoEl = document.createElement("div");
    infoEl.className = "tab-preview-resource-info";
    Object.assign(infoEl.style, {
      opacity: "0.5",
      whiteSpace: "nowrap",
      marginTop: "0.3em",
      "text-align": "right",
      "font-style": "italic",
    });

    if (!info) {
      const pending = hoveredTab?.getAttribute?.("pending") === "true";
      infoEl.textContent = pending ? "Unloaded" : "Not loaded";
    } else {
      const cpu =
        info.cpu == null ? "Sampling..." : info.cpu.toFixed(1) + "%";
      //infoEl.textContent = formatBytes(info.mem) + " · " + cpu;
      infoEl.textContent = "RAM: " + formatBytes(info.mem) + " • CPU: " + cpu;
      infoEl.tooltipText =
        `Process ${info.pid} (${info.origin})\n` +
        `Figures are per content process — shared tabs show the same values.`;
    }

    container.appendChild(infoEl);
  }

  // Subtree observation: Floorp rebuilds the card's inner content on
  // each hover, which wipes our line — the guard in refreshPanel() means
  // each wipe leads to at most one re-insertion, never a loop.
  const observer = new MutationObserver(() => {
    if (isPanelVisible()) refreshPanel();
  });
  observer.observe(panel, { childList: true, subtree: true });

  console.info(
    LOGTAG + "script loaded, waiting for delayed startup."
  );
})();
