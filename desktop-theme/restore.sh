#!/bin/bash
# Restore the default macOS look. Add --uninstall to also remove the apps and fonts.
T="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"   # this folder, wherever it lives
export PATH=/opt/homebrew/bin:$PATH
UNINSTALL=0; [ "${1:-}" = "--uninstall" ] && UNINSTALL=1
say() { printf '%s\n' "$*"; }
unlink_if_ours() { [ -L "$1" ] && [[ "$(realpath "$1" 2>/dev/null)" == "$T"* ]] && rm "$1" && say "removed link $1"; }

# Menu bar and borders
command -v sketchybar >/dev/null && brew services stop sketchybar >/dev/null 2>&1 && say "sketchybar: stopped"
command -v borders >/dev/null && brew services stop borders >/dev/null 2>&1 && say "borders: stopped"
BEFORE=$(cat "$T/backup/menubar-autohide-before" 2>/dev/null || echo false)
osascript -e "tell application \"System Events\" to set autohide menu bar of dock preferences to $BEFORE" && say "menu bar auto hide: $BEFORE (as before)"
unlink_if_ours "$HOME/.config/sketchybar"; unlink_if_ours "$HOME/.config/borders"

# Übersicht HUD
W="$HOME/Library/Application Support/Übersicht/widgets"
osascript -e 'tell application id "tracesOf.Uebersicht" to quit' >/dev/null 2>&1; sleep 1
pkill -x "Übersicht" 2>/dev/null   # a quit request is ignored while a dialog is open
unlink_if_ours "$W/jarvis-hud"
[ -f "$T/backup/ubersicht/GettingStarted.jsx" ] && [ -d "$W" ] && cp -n "$T/backup/ubersicht/GettingStarted.jsx" "$W/" 2>/dev/null
osascript -e 'tell application "System Events" to delete (every login item whose name is "Übersicht")' >/dev/null 2>&1

# Plash wallpaper: quitting it brings back your normal macOS wallpaper
osascript -e 'tell application id "com.sindresorhus.Plash" to quit' >/dev/null 2>&1; sleep 1; pkill -x Plash 2>/dev/null; say "plash: quit"
osascript -e 'tell application "System Events" to delete (every login item whose name is "Plash")' >/dev/null 2>&1

if [ $UNINSTALL = 1 ]; then
  brew uninstall felixkratz/formulae/sketchybar felixkratz/formulae/borders 2>/dev/null && say "sketchybar, borders: uninstalled"
  brew untrust --formula felixkratz/formulae/sketchybar felixkratz/formulae/borders >/dev/null 2>&1
  brew uninstall --cask ubersicht 2>/dev/null && say "übersicht: uninstalled"
  [ -d /Applications/Plash.app ] && rm -rf /Applications/Plash.app && say "plash: removed (reinstall from the App Store any time)"
  while read -r f; do [ -n "$f" ] && rm -f "$HOME/Library/Fonts/$f" && say "font removed: $f"; done < "$T/.installed-fonts"
  unlink_if_ours "$HOME/jarvis-theme"   # the shortcut left behind when this folder moved into the repo
fi
say "Done. The theme files stay in $T."
