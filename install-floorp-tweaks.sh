#!/bin/bash
#
# install-floorp-tweaks.sh
#
# Full installer for Floorp user-script customisation on macOS. Installs:
#
#   1. fx-autoconfig (MrOtherGuy/fx-autoconfig), BOTH halves:
#        program/  -> config.js & defaults/pref/config-prefs.js
#                    into Floorp.app/Contents/Resources/
#        profile/  -> chrome/JS, chrome/resources, chrome/utils
#                    into the chosen Floorp profile folder
#   2. Floorp-Tweaks (thefella/Floorp-Tweaks):
#        Scripts/*.uc.js            -> <profile>/chrome/JS/
#        CSS/floorp-tweaks.css      -> <profile>/chrome/CSS/
#        CSS/floorp-tweaks/*.css    -> <profile>/chrome/CSS/floorp-tweaks/
#        and appends ONE @import line for floorp-tweaks.css into
#        userChrome.css (idempotent - never duplicated). floorp-tweaks.css
#        itself imports everything in the floorp-tweaks/ folder.
#        Any legacy per-file @import lines from earlier versions of this
#        installer are removed from userChrome.css.
#
# Profile selection:
#   - Pass a profile path or name as argument 2, or set PROFILE_PATH env var.
#   - Otherwise the profile ending in ".default-default" is used if present.
#   - Otherwise, if run from a terminal, an interactive menu is offered.
#
# Usage:
#   ./install-floorp-tweaks.sh                          # defaults
#   ./install-floorp-tweaks.sh /Applications/Floorp.app myprofile.default
#   PROFILE_PATH=/path/to/profile ./install-floorp-tweaks.sh
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
TWEAKS_CSS="floorp-tweaks.css"          # single entry-point stylesheet
TWEAKS_CSS_DIR="floorp-tweaks"          # folder it imports from
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

# 3a. Scripts -> chrome/JS/
shopt -s nullglob
scripts=("$TW_SRC"/Scripts/*.uc.js)
shopt -u nullglob
for f in "${scripts[@]:-}"; do
    [[ -z "$f" ]] && continue
    cp "$f" "$CHROME_DIR/JS/"
    echo "  chrome/JS/$(basename "$f")"
done

# 3b. Single entry-point stylesheet + imported folder -> chrome/CSS/
TW_CSS_SRC="$TW_SRC/CSS/$TWEAKS_CSS"
TW_CSSDIR_SRC="$TW_SRC/CSS/$TWEAKS_CSS_DIR"
if [[ ! -f "$TW_CSS_SRC" ]]; then
    echo "  ERROR: $TWEAKS_REPO@$TWEAKS_BRANCH does not contain CSS/$TWEAKS_CSS."
    echo "         Was the repo restructured, or is the change not pushed yet?"
    exit 1
fi
if [[ ! -d "$TW_CSSDIR_SRC" ]]; then
    echo "  ERROR: CSS/$TWEAKS_CSS_DIR/ folder not found in $TWEAKS_REPO@$TWEAKS_BRANCH."
    exit 1
fi
cp "$TW_CSS_SRC" "$CHROME_DIR/CSS/"
echo "  chrome/CSS/$TWEAKS_CSS"
# Refresh the imported folder wholesale (remove stale copies of retired files).
rm -rf "$CHROME_DIR/CSS/$TWEAKS_CSS_DIR"
mkdir -p "$CHROME_DIR/CSS/$TWEAKS_CSS_DIR"
cp -R "$TW_CSSDIR_SRC/." "$CHROME_DIR/CSS/$TWEAKS_CSS_DIR/"
echo "  chrome/CSS/$TWEAKS_CSS_DIR/  ($(find "$CHROME_DIR/CSS/$TWEAKS_CSS_DIR" -type f | wc -l | tr -d ' ') files)"

# 3c. Register the single @import in userChrome.css (idempotent),
#     and strip legacy per-file imports from older installer versions.
UC="$CHROME_DIR/userChrome.css"
[[ -f "$UC" ]] || touch "$UC"
if grep -qE '^/\* Floorp-Tweaks \*/$|@import url\("\./CSS/floorp-tweaks-[^"]+\.css"\);' "$UC"; then
    TMP_UC="$(mktemp)"
    grep -vE '^/\* Floorp-Tweaks \*/$|@import url\("\./CSS/floorp-tweaks-[^"]+\.css"\);' \
        "$UC" > "$TMP_UC" || true
    mv "$TMP_UC" "$UC"
    echo "  removed legacy per-file imports from userChrome.css"
fi
IMPORT="@import url(\"./CSS/$TWEAKS_CSS\");"
if ! grep -qF "CSS/$TWEAKS_CSS" "$UC"; then
    printf '\n/* Floorp-Tweaks */\n%s\n' "$IMPORT" >> "$UC"
    echo "    + imported $TWEAKS_CSS in userChrome.css"
else
    echo "    (already imported in userChrome.css)"
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
