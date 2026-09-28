#!/bin/bash
# Install the fonts the Jarvis app uses (Chakra Petch, JetBrains Mono; both
# SIL Open Font License 1.1) for this user only, from Google's font repository.
# restore.sh --uninstall removes exactly the files listed in .installed-fonts.
T="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
B=https://raw.githubusercontent.com/google/fonts/main/ofl
D="$HOME/Library/Fonts"; mkdir -p "$D"
get() { curl -sSfL -o "$D/$2" "$B/$1" && echo "$2" >> "$T/.installed-fonts" && echo "installed $2"; }
for w in Light Regular Medium SemiBold; do get "chakrapetch/ChakraPetch-$w.ttf" "ChakraPetch-$w.ttf"; done
get "jetbrainsmono/JetBrainsMono%5Bwght%5D.ttf" "JetBrainsMono[wght].ttf"
sort -u -o "$T/.installed-fonts" "$T/.installed-fonts"
