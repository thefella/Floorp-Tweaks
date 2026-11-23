// ==UserScript==
// @name           History Expiry (Floorp Tweaks edition)
// @description    Deletes browsing history older than the period chosen in
//                 Floorp Tweaks > History > Browsing history retention.
//                 Prunes via PlacesUtils.history.removeVisitsByFilter() with
//                 a { beginDate, endDate } Date filter — v1.0.0 passed a
//                 { beginTime, endTime } microsecond filter, which the API
//                 rejects as empty, so no pruning ever occurred.
// @version        1.0.1
// @author         Conor
// @license        MPL-2.0
// @include        main
// @charset        utf-8
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
 *
 * v1.0.1: removeVisitsByFilter() validates its filter against the keys
 * beginDate/endDate/url/limit/transition only (verified in
 * toolkit/components/places/History.sys.mjs). The old {beginTime, endTime}
 * shape made every call throw "Expected a non-empty filter".
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
  sessionStartedAt: new Date(),

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

    // removeVisitsByFilter wants Date objects in beginDate/endDate.
    const endDate = days === 0 ? this.sessionStartedAt : new Date(Date.now() - days * 86_400_000);
    const beginDate = new Date(0);

    // Degenerate window (clock skew, or retention set before the epoch-
    // anchored begin): nothing can match, don't call the API.
    if (endDate <= beginDate) return;

    try {
      const removed = await PlacesUtils.history.removeVisitsByFilter({
        beginDate,
        endDate,
      });
      console.info(
        `[History-Expiry] removed ${removed ? "old" : "0"} visit(s) older than ` +
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
      this.sessionStartedAt = new Date(); // re-anchor "Session Only"
      this.prune();
    };
    Services.prefs.addObserver(this.PREF, this._observer);
  },
};

HistoryExpiry.init();
