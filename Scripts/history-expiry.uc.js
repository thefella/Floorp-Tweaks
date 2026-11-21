// ==UserScript==
// @name         History Expiry (Floorp Tweaks edition)
// @description  Deletes browsing history older than the period chosen in Floorp Tweaks > History > Browsing history retention
// @include      main
// @charset      utf-8
// @author       Conor
// ==/UserScript==

"use strict";

/**
 * History Expiry
 * ==============
 * Prunes Places history of visits older than a retention period chosen from
 * the Floorp Tweaks pane ("History" card > "Browsing history retention").
 *
 * Runs on every browser start-up and hourly afterwards. Changing the dropdown
 * triggers an immediate prune; "Session Only" re-anchors its cutoff at "now".
 *
 * Uses PlacesUtils.history.removeVisitsByFilter() — the same supported API
 * Firefox's own expiration uses — so orphaned pages, annotations and frecency
 * bookkeeping are cleaned up properly, and bookmarked/pinned pages survive.
 *
 * The pref (floorptweaks.history.retention) is an INTEGER, written by the
 * dropdown in floorp-tweaks-settings.uc.js:
 *     > 0   keep history for that many days
 *     0     session only (prune everything from before this session)
 *     -1    forever (script idle, keep history indefinitely)
 *
 * Also self-seeds the pref (-1), so it works standalone.
 */

const { PlacesUtils } = ChromeUtils.importESModule(
  "resource://gre/modules/PlacesUtils.sys.mjs"
);

const HistoryExpiry = {
  /** Integer pref shared with the Floorp Tweaks pane */
  PREF: "floorptweaks.history.retention",

  DEFAULT: -1, // forever

  /** Hourly re-check */
  INTERVAL_MS: 60 * 60 * 1000,

  /** Anchor for "Session Only": when the current session began */
  sessionStartedAtUs: Date.now() * 1000,

  /* ------------------------------------------------------------------ */
  /* Pref access                                                        */
  /* ------------------------------------------------------------------ */

  /**
   * Returns the retention value in days, or one of the special codes:
   *   0     session only
   *   -1    forever (nothing to prune)
   *   >0    keep this many days
   * Falls back to DEFAULT (-1) if the pref is missing or malformed.
   */
  getRetentionDays() {
    try {
      if (!Services.prefs.prefHasUserValue(this.PREF)) {
        return this.DEFAULT;
      }
      const v = Services.prefs.getIntPref(this.PREF, this.DEFAULT);
      return Number.isInteger(v) ? v : this.DEFAULT;
    } catch (e) {
      // Wrong pref type (legacy string from v3.9/v3.10 settings) —
      // ignore and let the settings script's migration clean it up.
      console.warn("[History-Expiry] unreadable pref value; treating as forever:", e);
      return this.DEFAULT;
    }
  },

  /* ------------------------------------------------------------------ */
  /* Pruning                                                            */
  /* ------------------------------------------------------------------ */

  async prune() {
    const days = this.getRetentionDays();
    if (days < 0) return; // forever

    // Places stores timestamps in microseconds since the epoch.
    // removeVisitsByFilter wants { beginTime, endTime } in µs.
    const endTimeUs =
      days === 0
        ? this.sessionStartedAtUs
        : (Date.now() - days * 86_400_000) * 1000;

    try {
      const removed = await PlacesUtils.history.removeVisitsByFilter({
        beginTime: 0,
        endTime: endTimeUs,
      });
      console.info(
        `[History-Expiry] removed ${removed} visit(s) older than ` +
        (days === 0 ? "session start" : `${days} day(s)`)
      );
    } catch (e) {
      console.error("[History-Expiry] prune failed:", e);
    }
  },

  /* ------------------------------------------------------------------ */
  /* Lifecycle                                                          */
  /* ------------------------------------------------------------------ */

  init() {
    // Self-seed so the pref exists, even standalone
    if (!Services.prefs.prefHasUserValue(this.PREF)) {
      Services.prefs.setIntPref(this.PREF, this.DEFAULT);
    }

    this.prune();
    this._timer = setInterval(() => this.prune(), this.INTERVAL_MS);

    // React immediately when the dropdown changes in the Tweaks pane.
    // Switching to "session" (0) re-anchors the cutoff at *now*.
    this._observer = () => {
      this.sessionStartedAtUs = Date.now() * 1000; // re-anchor "Session Only"
      this.prune();
    };
    Services.prefs.addObserver(this.PREF, this._observer);
  },
};

HistoryExpiry.init();
