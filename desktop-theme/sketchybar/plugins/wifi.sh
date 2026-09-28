#!/bin/bash
# The network name needs Location Services on recent macOS; fall back to on/off.
DEV=$(networksetup -listallhardwareports | awk '/Wi-Fi/{getline; print $2}')
SSID=$(ipconfig getsummary "$DEV" 2>/dev/null | awk -F' SSID : ' '/ SSID : /{print $2}')
if [ -n "$SSID" ] && [ "$SSID" != "<redacted>" ]; then LABEL="WIFI $SSID"
elif ipconfig getifaddr "$DEV" >/dev/null 2>&1; then LABEL="WIFI ON"
else LABEL="WIFI OFF"; fi
sketchybar --set "$NAME" label="$(echo "$LABEL" | tr '[:lower:]' '[:upper:]')"
