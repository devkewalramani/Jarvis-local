#!/bin/bash
# Turn on the Jarvis desktop look. Safe to run again; skips anything not installed.
T="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"   # this folder, wherever it lives
export PATH=/opt/homebrew/bin:$PATH
say() { printf '%s\n' "$*"; }

# JankyBorders: cyan glow on the active window
if command -v borders >/dev/null; then
  mkdir -p "$HOME/.config"; ln -sfn "$T/borders" "$HOME/.config/borders"
  brew services restart borders >/dev/null && say "borders: on"
else say "borders: not installed (needs the Command Line Tools update)"; fi

# SketchyBar, with the native menu bar set to auto hide
if command -v sketchybar >/dev/null; then
  mkdir -p "$HOME/.config"; ln -sfn "$T/sketchybar" "$HOME/.config/sketchybar"
  osascript -e 'tell application "System Events" to set autohide menu bar of dock preferences to true'
  brew services restart sketchybar >/dev/null && say "sketchybar: on (native menu bar auto hides)"
else say "sketchybar: not installed (needs the Command Line Tools update)"; fi

# Übersicht HUD
W="$HOME/Library/Application Support/Übersicht/widgets"
if [ -d "/Applications/Übersicht.app" ]; then
  mkdir -p "$W"; ln -sfn "$T/ubersicht/jarvis-hud" "$W/jarvis-hud"
  open -g -a "Übersicht"; say "übersicht: on"
fi

# Plash wallpaper (App Store app)
if [ -d "/Applications/Plash.app" ]; then
  open -g -a Plash; say "plash: open (add file://$T/wallpaper/index.html once, see README)"
else say "plash: not installed (Mac App Store)"; fi
