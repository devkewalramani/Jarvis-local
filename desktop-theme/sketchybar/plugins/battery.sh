#!/bin/bash
B=$(pmset -g batt)
PCT=$(echo "$B" | grep -Eo '[0-9]+%' | head -1)
[ -z "$PCT" ] && { sketchybar --set "$NAME" drawing=off; exit 0; }
case "$B" in *"AC Power"*) MARK=" +" ;; *) MARK="" ;; esac
sketchybar --set "$NAME" drawing=on label="BAT ${PCT}${MARK}"
