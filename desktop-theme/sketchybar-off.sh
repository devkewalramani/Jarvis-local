#!/bin/bash
# Back to the normal macOS menu bar (run activate.sh to turn SketchyBar on again).
/opt/homebrew/bin/brew services stop sketchybar >/dev/null 2>&1; osascript -e 'tell application "System Events" to set autohide menu bar of dock preferences to false' && echo "SketchyBar off; normal menu bar back."
