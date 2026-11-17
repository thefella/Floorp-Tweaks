#!/bin/bash
#
# install-floorp-userchrome-suite.sh
#
# Full installer for Floorp user-script customisation on macOS. Installs:
#
#   1. fx-autoconfig (MrOtherGuy/fx-autoconfig), BOTH halves:
#        program/  -> config.js & defaults/pref/config-prefs.js
#                    into Floorp.app/Contents/Resources/
#        profile/  -> chrome/JS, chrome/resources, chrome/utils
#                    into the chosen Floorp profile folder
#   2. Floorp-Tweaks (thefella/Floorp-Tweaks):
#        Scripts/*.uc.js -> <profile>/chrome/JS/
#        CSS/*.css       -> <profile>/chrome/CSS/
#        and appends @import lines for the CSS into userChrome.css
#        (idempotent - never duplicated).
#
# Profile selection:
#   - Pass a profile path or name as argument 2, or set PROFILE_PATH env var.
#   - Otherwise the profile ending in ".default-default" is used if present.
#   - Otherwise, if run from a terminal, an interactive menu is offered.
#
# Usage:
#   ./install-floorp-userchrome-suite.sh                          # defaults
#   ./install-floorp-userchrome-suite.sh /Applications/Floorp.app myprofile.default
#   PROFILE_PATH=/path/to/profile ./install-floorp-userchrome-suite.sh
#
# NOTE: Floorp updates REPLACE the app bundle - re-run this script after
# every Floorp update (the profile-side files survive updates).
#
set -euo pipefail

# ----------------------------------------------------------------- config --
APP_PATH="${1:-${APP_PATH:-/Applications/Floorp.app}}"
FX_RAW_REPO="MrOtherGuy/fx-autoconfig"
FX_BRANCH="master"
TWEAKS_REPO="thefella/Floorp-Tweaks"
TWEAKS_BRANCH="main"
DATA_DIR="$HOME/Library/Application Support/Floorp"
PROFILES_INI="$DATA_DIR/profiles.ini"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# ------------------------------------------------------------ app bundle ---
if [[ ! -d "$APP_PATH" && -d "${APP_PATH}.app" ]]; then APP_PATH="${APP_PATH}.app"; fi
if [[ ! -d "$APP_PATH" ]]; then
    echo "ERROR: Floorp app bundle not found at: $APP_PATH"
    exit 1
fi
RES_DIR="$APP_PATH/Contents/Resources"
if [[ ! -d "$RES_DIR" ]]; then
    echo "ERROR: '$RES_DIR' does not exist - is this really a Floorp bundle?"
    exit 1
fi
echo "App bundle : $APP_PATH"

# ------------------------------------------------------ profile discovery --
pick_profile() {
    # Explicit argument / env var wins.
    if [[ -n "${2:-${PROFILE_PATH:-}}" ]]; then
        local given="${2:-$PROFILE_PATH}"
        if [[ -d "$given" ]]; then
            PROFILE_DIR="$given"
        elif [[ -d "$DATA_DIR/Profiles/$given" ]]; then
            PROFILE_DIR="$DATA_DIR/Profiles/$given"
        else
            echo "ERROR: profile not found: $given"
            exit 1
        fi
        return
    fi

    # Gather [Path=...] values from profiles.ini (relative paths are typical).
    local -a paths=()
    if [[ -f "$PROFILES_INI" ]]; then
        while IFS= read -r p; do
            [[ -n "$p" ]] && paths+=("$p")
        done < <(grep -E '^Path=' "$PROFILES_INI" | cut -d= -f2- | sed 's|^/||')
    fi

    # Prefer the .default-default profile.
    for p in "${paths[@]:-}"; do
        [[ "$p" == *.default-default ]] && PROFILE_DIR="$DATA_DIR/$p" && return
    done

    # Interactive menu if we have a TTY; otherwise fail loudly.
    if [[ -t 0 && ${#paths[@]} -gt 0 ]]; then
        echo
        echo "Multiple Floorp profiles found - pick one:"
        local i=1
        for p in "${paths[@]}"; do
            echo "  [$i] $p"
            ((i++))
        done
        printf "Choice [%d]: " "${#paths[@]}"
        local choice
        read -r choice || choice=""
        if [[ -z "$choice" ]]; then choice="${#paths[@]}"; fi
        if [[ "$choice" =~ ^[0-9]+$ ]] && (( choice >= 1 && choice <= ${#paths[@]} )); then
            PROFILE_DIR="$DATA_DIR/${paths[$((choice-1))]}"
            return
        fi
        echo "ERROR: invalid choice: $choice"
        exit 1
    fi

    echo "ERROR: could not determine a Floorp profile."
    echo "Pass one explicitly, e.g.:  $0 \"$APP_PATH\" <profile-name-or-path>"
    echo "Available candidates:"
    for p in "${paths[@]:-none}"; do echo "  $p"; done
    exit 1
}
PROFILE_DIR=""
pick_profile "$@"
CHROME_DIR="$PROFILE_DIR/chrome"

echo "Profile    : $PROFILE_DIR"
echo

# --------------------------------------------------------------- download --
fetch_tarball() {
    local repo="$1" branch="$2" dest="$3"
    local url="https://codeload.github.com/$repo/tar.gz/refs/heads/$branch"
    echo "Downloading $repo ($branch) ..."
    if ! curl -fsSL --retry 3 -o "$dest" "$url"; then
        echo "ERROR: download failed: $url"; exit 1
    fi
    if ! tar -tzf "$dest" >/dev/null 2>&1; then
        echo "ERROR: downloaded archive is corrupt: $url"; exit 1
    fi
}
fetch_tarball "$FX_RAW_REPO"     "$FX_BRANCH"     "$TMP/fx.tar.gz"
fetch_tarball "$TWEAKS_REPO"     "$TWEAKS_BRANCH" "$TMP/tweaks.tar.gz"
tar -xzf "$TMP/fx.tar.gz"     -C "$TMP"
tar -xzf "$TMP/tweaks.tar.gz" -C "$TMP"
FX_SRC="$TMP/${FX_RAW_REPO#*/}-$FX_BRANCH"
TW_SRC="$TMP/${TWEAKS_REPO#*/}-$TWEAKS_BRANCH"
for d in "$FX_SRC" "$TW_SRC"; do
    if [[ ! -d "$d" ]]; then echo "ERROR: extracted folder missing: $d"; exit 1; fi
done
echo

# ------------------------------------------------- 1. app-side (program) ---
echo "== Installing fx-autoconfig program files =="
mkdir -p "$RES_DIR/defaults/pref"
if [[ -f "$RES_DIR/config.js" ]]; then
    BK="$RES_DIR/config.js.bak.$(date +%Y%m%d-%H%M%S)"
    cp "$RES_DIR/config.js" "$BK"
    echo "  backed up existing config.js -> $(basename "$BK")"
fi
cp "$FX_SRC/program/config.js"                      "$RES_DIR/config.js"
cp "$FX_SRC/program/defaults/pref/config-prefs.js"  "$RES_DIR/defaults/pref/config-prefs.js"
echo "  $RES_DIR/config.js"
echo "  $RES_DIR/defaults/pref/config-prefs.js"
echo

# ----------------------------------------------- 2. profile-side (chrome) ---
echo "== Installing fx-autoconfig profile files (merged) =="
mkdir -p "$CHROME_DIR"
for sub in JS resources utils; do
    if [[ -d "$FX_SRC/profile/chrome/$sub" ]]; then
        mkdir -p "$CHROME_DIR/$sub"
        cp -R "$FX_SRC/profile/chrome/$sub/." "$CHROME_DIR/$sub/"
        echo "  chrome/$sub/  ($(find "$CHROME_DIR/$sub" -type f | wc -l | tr -d ' ') files)"
    fi
done

# --------------------------------------------------- 3. Floorp-Tweaks ------
echo "== Installing Floorp-Tweaks =="
mkdir -p "$CHROME_DIR/JS" "$CHROME_DIR/CSS"
shopt -s nullglob
scripts=("$TW_SRC"/Scripts/*.uc.js)
styles=("$TW_SRC"/CSS/*.css)
shopt -u nullglob
if [[ ${#scripts[@]} -eq 0 && ${#styles[@]} -eq 0 ]]; then
    echo "  WARNING: no Scripts or CSS files found in $TWEAKS_REPO - skipping"
else
    for f in "${scripts[@]:-}"; do
        [[ -z "$f" ]] && continue
        cp "$f" "$CHROME_DIR/JS/"
        echo "  chrome/JS/$(basename "$f")"
    done
    for f in "${styles[@]:-}"; do
        [[ -z "$f" ]] && continue
        cp "$f" "$CHROME_DIR/CSS/"
        echo "  chrome/CSS/$(basename "$f")"
        # Register in userChrome.css (idempotent).
        UC="$CHROME_DIR/userChrome.css"
        [[ -f "$UC" ]] || touch "$UC"
        IMPORT="@import url(\"./CSS/$(basename "$f")\");"
        if ! grep -qF "CSS/$(basename "$f")" "$UC"; then
            printf '\n/* Floorp-Tweaks */\n%s\n' "$IMPORT" >> "$UC"
            echo "    + imported in userChrome.css"
        else
            echo "    (already imported in userChrome.css)"
        fi
    done
fi
echo

# ------------------------------------------------------------ wrap-up ------
cat <<NEXT
Done. Remaining manual steps:

  1. In about:config, set:
       toolkit.legacyUserProfileCustomizations.stylesheets = true
       userChromeJS.persistent_domcontent_callback         = true
  2. Clear the startup cache: about:support -> "Clear startup cache..."
     and let Floorp restart.
  3. Verify in the Browser Console (Cmd+Shift+J) that fx-autoconfig's
     banner appears and your scripts' debug output shows up.

Remember: app-side files (config.js) are wiped by Floorp updates - re-run
this script after every Floorp update.
NEXT
