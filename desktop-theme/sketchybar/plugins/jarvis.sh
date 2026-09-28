#!/bin/bash
# Cyan dot when the Jarvis bridge answers its health check, dim when it doesn't.
if curl -s -m 1 http://127.0.0.1:8787/health | grep -q '"ok":true'; then
  sketchybar --set "$NAME" icon.color=0xff00e5ff label="JARVIS" label.color=0xff00e5ff
else
  sketchybar --set "$NAME" icon.color=0x40ffffff label="JARVIS OFF" label.color=0x6600e5ff
fi
