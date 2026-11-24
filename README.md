# Floorp Tweaks 🦊

**Quality-of-life userChrome tweaks for the [Floorp](https://floorp.ablaze.one) browser** — a Firefox fork.

Fixes for the things that bug me about Floorp: workspace-aware pinned tabs, cleaner chrome, container presets.

| | |
|---|---|
| **Platform** | macOS (manual steps work on any OS) |
| **Loader** | [MrOtherGuy/fx-autoconfig](https://github.com/MrOtherGuy/fx-autoconfig) |
| **Upstream** | Floorp is forked from [Mozilla Firefox](https://www.mozilla.org/firefox/) |

---

## Table of Contents

- [What's Included](#whats-included)
- [Repo Structure](#repo-structure)
- [Installation (macOS)](#installation-macos)
- [Manual Installation (any OS)](#manual-installation-any-os)
- [Post-Install Configuration](#post-install-configuration)
- [Verifying It Worked](#verifying-it-worked)
- [Updating & Reinstalling](#updating--reinstalling)
- [Uninstalling](#uninstalling)
- [Troubleshooting](#troubleshooting)
- [Acknowledgements](#acknowledgements)

---

## What's Included

| Area           | Description                                                                                                                                                                                                                                                                           |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Scripts**    | A single auto-loaded loader (`floorp-tweaks-loader.uc.js`) that discovers and loads every tweak in `Scripts/floorp-tweaks/` at startup — add or remove a `.uc.js` file and it's picked up automatically.                                                                              |
| **CSS**        | One entry-point stylesheet (`floorp-tweaks.css`) that imports everything in `CSS/floorp-tweaks/`, wired into `userChrome.css` automatically.                                                                                                                                          |
| **Containers** | `containers.json` — preset container/tab definitions for Floorp. (Optional: Not automatically install. Integrate into your own profile folder if you use the [Firefox Multi-Account Containers](https://addons.mozilla.org/en-GB/firefox/addon/multi-account-containers/) extension.) |

The installer handles the plumbing: it fetches and installs both halves of [fx-autoconfig](https://github.com/MrOtherGuy/fx-autoconfig) (the `config.js` bootstrapper into the app bundle, plus the `chrome/JS`, `chrome/resources` and `chrome/utils` runtime into your profile), then drops in the tweaks.

## Repo Structure

```
Floorp-Tweaks/
├── install-floorp-tweaks.sh        # One-shot installer (macOS)
├── Scripts/
│   ├── floorp-tweaks-loader.uc.js  # The only auto-loaded script
│   └── floorp-tweaks/              # Suite scripts, subloaded by the loader
├── CSS/
│   ├── floorp-tweaks.css           # Entry-point stylesheet (@import hub)
│   └── floorp-tweaks/              # Individual stylesheets
└── Containers/
    └── containers.json             # Container presets
```

## Installation (macOS)

### Quick start

Open Terminal and run:

```bash
curl -fsSL https://raw.githubusercontent.com/thefella/Floorp-Tweaks/main/install-floorp-tweaks.sh -o install-floorp-tweaks.sh
chmod +x install-floorp-tweaks.sh
./install-floorp-tweaks.sh
```

No cloning needed — you only download the installer itself. It fetches this repo's tweaks and [fx-autoconfig](https://github.com/MrOtherGuy/fx-autoconfig) as tarballs into a temp dir, installs everything, and cleans up after itself. It auto-detects `/Applications/Floorp.app` and your `.default-default` profile (offering an interactive menu if you have several).

### Options

```bash
# Specify an app path and/or profile
./install-floorp-tweaks.sh /Applications/Floorp.app myprofile.default

# Or via environment variable
PROFILE_PATH=/path/to/profile ./install-floorp-tweaks.sh
```

Profile names are resolved relative to `~/Library/Application Support/Floorp/Profiles/`, so a bare folder name works.

### Requirements

- macOS with [Floorp](https://floorp.ablaze.one) installed
- `curl` and `tar` (preinstalled on macOS)

### What the installer does

1. **Downloads** `fx-autoconfig` and this repo (tarballs, verified & extracted to a temp dir).
2. **App side** — installs `config.js` + `defaults/pref/config-prefs.js` into `Floorp.app/Contents/Resources/` (existing `config.js` is backed up with a timestamp).
3. **Profile side** — installs `chrome/JS`, `chrome/resources`, `chrome/utils` into your profile.
4. **Tweaks** — installs the loader to `chrome/JS/`, refreshes `chrome/JS/floorp-tweaks/` and `chrome/CSS/floorp-tweaks/` wholesale (stale copies of renamed/retired files are removed), and copies the entry stylesheet to `chrome/CSS/`.
5. **Wires up `userChrome.css`** — appends a single `@import` line (idempotent, never duplicated) and cleans up legacy per-file imports from older installer versions.

> **Note:** Floorp updates *replace* the app bundle, wiping the app-side `config.js`. **Re-run this script after every Floorp update** — the profile-side files survive updates untouched.

## Manual Installation (any OS)

Since Floorp is a Firefox fork, the same userChrome/fx-autoconfig machinery works everywhere Firefox does — just adapt the paths to your platform's profile folder.

1. Install [fx-autoconfig](https://github.com/MrOtherGuy/fx-autoconfig) following its README:
   - `program/config.js` → `<Floorp install>/` (and `defaults/pref/config-prefs.js`)
   - `profile/chrome/{JS,resources,utils}` → `<profile>/chrome/`
2. Copy `Scripts/floorp-tweaks-loader.uc.js` → `<profile>/chrome/JS/`
3. Copy `Scripts/floorp-tweaks/` → `<profile>/chrome/JS/floorp-tweaks/`
4. Copy `CSS/floorp-tweaks.css` → `<profile>/chrome/CSS/` and `CSS/floorp-tweaks/` → `<profile>/chrome/CSS/floorp-tweaks/`
5. Add to `<profile>/chrome/userChrome.css`:

   ```css
   /* Floorp-Tweaks */
   @import url("./CSS/floorp-tweaks.css");
   ```

> Do **not** place the suite `.uc.js` files directly in `chrome/JS/` — top-level scripts are auto-loaded by fx-autoconfig *and* subloaded by the loader, causing double registration.

## Post-Install Configuration

In `about:config`, set:

| Preference | Value |
|------------|-------|
| `toolkit.legacyUserProfileCustomizations.stylesheets` | `true` |
| `userChromeJS.persistent_domcontent_callback` | `true` |

Then clear the startup cache: `about:support` → **"Clear startup cache…"** and let Floorp restart.

## Verifying It Worked

Open the Browser Console (`Cmd+Shift+J` on macOS, `Ctrl+Shift+J` elsewhere) and check that:

- fx-autoconfig's banner appears
- `[Floorp-Tweaks][Loader]` logs a `loaded <name>` line per suite script, followed by a `suite loaded: N script(s)` summary

## Updating & Reinstalling

Just re-run the installer — it's fully idempotent:

```bash
./install-floorp-tweaks.sh
```

## Uninstalling

- Remove `config.js` and `defaults/pref/config-prefs.js` from `Floorp.app/Contents/Resources/`
- Delete the loader and `floorp-tweaks` folders from `<profile>/chrome/JS/` and `<profile>/chrome/CSS/`
- Remove the `/* Floorp-Tweaks */` import block from `<profile>/chrome/userChrome.css`

## Troubleshooting

| Symptom                              | Fix                                                                                                                         |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| Nothing loads after a Floorp update  | Re-run the installer — app-side `config.js` is wiped by updates.                                                            |
| Scripts load, CSS doesn't            | Check `userChrome.css` contains the `@import` and the pref `toolkit.legacyUserProfileCustomizations.stylesheets` is `true`. |
| Script registered twice              | Ensure no suite `.uc.js` files sit flat in `chrome/JS/` — the installer removes them on next run.                           |
| Multiple profiles, wrong one patched | Pass the profile explicitly: `./install-floorp-tweaks.sh /Applications/Floorp.app <profile>`.                               |

## Acknowledgements

- [MrOtherGuy/fx-autoconfig](https://github.com/MrOtherGuy/fx-autoconfig) — the userChrome loader this repo installs
- [Floorp](https://floorp.ablaze.one) — the browser itself
- [Mozilla Firefox](https://www.mozilla.org/firefox/) — Floorp's upstream, whose userChrome customisation support makes all of this possible
