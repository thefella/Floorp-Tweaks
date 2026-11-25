// ==UserScript==
// @name           Floorp-Tweaks Suite Loader
// @description    Single auto-loaded entry point for the Floorp-Tweaks
//                 suite. fx-autoconfig auto-loads ONLY top-level files
//                 in chrome/JS/ - files in subdirectories are not loaded
//                 but ARE served via the chrome registry, because the
//                 whole JS tree is registered as
//                 chrome://userscripts/content/. This loader enumerates
//                 EVERY .js file in the "floorp-tweaks" subfolder and
//                 loadSubScript()s each one into this window, in
//                 alphabetical order, with per-file error isolation.
//                 No manual file list: drop a file in the subfolder and
//                 it loads next restart; the installer copies new files
//                 without this script changing.
//                 The subfolder scripts keep their classic-script
//                 semantics unchanged: they run in this window's scope,
//                 so window/gBrowser/document/Services all resolve as
//                 before. Their fx-autoconfig headers become inert
//                 comments (the loader, not boot.sys.mjs, injects them).
//                 The loader itself needs the usual header (@include
//                 main) to be invoked once per browser window.
// @author         Conor
// @license        MPL-2.0
// @include        main
// @version        1.0.2
// ==/UserScript==

/*
 * NOTES
 *
 *  - SUBFOLDER: chrome/JS/floorp-tweaks/ (relative to the profile
 *    root, resolved via the "ProfD" directory service - the same
 *    anchor the profiles.ini paths use). v1.0.2: folder name changed
 *    from "floorptweaks" to "floorp-tweaks" to match the suite's
 *    naming style.
 *  - SCANNING: every file in the subfolder is enumerated; files
 *    ending .js are loaded, anything else is skipped with a log
 *    line. Dot-prefixed hidden files (editor/system droppings like
 *    .DS_Store) are always skipped.
 *  - ORDER: alphabetical by filename. Subfolder scripts should be
 *    written order-independent (they all already are: each is a
 *    guarded IIFE resolving everything at window-event time).
 *  - ERROR ISOLATION: each file loads inside its own try/catch - a
 *    broken script logs "[Floorp-Tweaks][Loader]" to the console and
 *    the remaining scripts still load. This matches (and slightly
 *    improves on) per-file behaviour via about:support, which this
 *    structure gives up: fx-autoconfig's script listing will only
 *    ever know this loader, so per-script metadata and individual
 *    enable/disable are not available for subfolder files.
 *  - CHROME REGISTRY: loadSubScript resolves via
 *    chrome://userscripts/content/floorp-tweaks/<file>. That URL
 *    space is provided by fx-autoconfig's own chrome.manifest
 *    (content userscripts ../JS/) - no manifest changes needed.
 *  - GUARDS: the loader itself carries no suite logic; if the
 *    subfolder is missing (fresh profile before an installer run),
 *    it logs and exits quietly.
 */

(() => {
  if (window.__ftSuiteLoader) return;
  window.__ftSuiteLoader = true;

  const TAG      = "[Floorp-Tweaks][Loader]";
  const DIR_NAME = "floorp-tweaks";
  const BASE_URL = "chrome://userscripts/content/" + DIR_NAME + "/";

  try {
    // <profile>/chrome/JS/floorp-tweaks/
    const sub = Services.dirsvc.get("ProfD", Ci.nsIFile).clone();
    sub.append("chrome");
    sub.append("JS");
    sub.append(DIR_NAME);

    if (!sub.exists() || !sub.isDirectory()) {
      console.log(TAG, `The subfolder "chrome/JS/${DIR_NAME}" was not found ` +
        "- nothing to load (fresh profile before the installer ran?).");
      return;
    }

    // Enumerate every file in the subfolder.
    const entries = [];
    for (const f of sub.directoryEntries) {
      if (!f.isFile()) continue;
      const name = f.leafName;
      if (name.startsWith(".")) continue;          // editor/system droppings
      if (!name.endsWith(".js")) {
        console.log(TAG, "Skipping non-.js file: ", name);
        continue;
      }
      entries.push(name);
    }
    entries.sort((a, b) => a.localeCompare(b));

    if (!entries.length) {
      console.log(TAG, `No .js files found in chrome/JS/${DIR_NAME}/`);
      return;
    }

    let ok = 0, failed = 0;
    for (const name of entries) {
      try {
        Services.scriptloader.loadSubScript(BASE_URL + name, window);
        ok++;
        console.log(TAG, "Loaded", name);
      } catch (e) {
        failed++;
        console.error(TAG, "FAILED to load ", name, e);
      }
    }
    console.log(TAG, `Loaded: ${ok} script(s).` +
      (failed ? `, ${failed} FAILED` : ""));
  } catch (e) {
    console.error(TAG, "Loader failed:", e);
  }
})();
