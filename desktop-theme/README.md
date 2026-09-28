# Jarvis desktop theme

Makes the macOS desktop match the Jarvis app's HUD: cyan `#00e5ff` on
`#01060c`, thin glowing lines, and the same fonts as the app (Chakra Petch,
with JetBrains Mono for numbers). Everything is optional, low power, and
undone by one command.

| Piece | What you get | Tool | Files |
|---|---|---|---|
| Wallpaper | A faint grid and sparse drifting particles; the Jarvis window is the focal point | [Plash](https://sindresorhus.com/plash) | `wallpaper/` |
| Desktop HUD | Time and date, today's next three meetings, unread mail per account, weather, CPU and memory | [Übersicht](https://tracesof.net/uebersicht/) | `ubersicht/jarvis-hud/` |
| Window glow | Soft cyan glow on the focused window only | [JankyBorders](https://github.com/FelixKratz/JankyBorders) | `borders/` |
| Menu bar | Jarvis status dot, front app, Wi Fi, battery, time | [SketchyBar](https://github.com/FelixKratz/SketchyBar) | `sketchybar/` |

## How it stays light

* **Wallpaper.** It draws 12 frames a second, not 60. The grid and vignette are
  drawn once, and only about 40 particles move. It stops while
  hidden or with "reduce motion" on, and Plash's "Deactivate while on battery"
  stops it entirely on battery.
* **HUD.** It refreshes every 30 seconds, and the weather is cached for 15
  minutes.
* **Measured on an M4 Max:** the whole theme uses about 4.5% of one CPU core.

## Mail and calendar, read only

The HUD reads mail and calendar through the same Thunderbird MCP server Jarvis
uses (the `thunderbird` entry in `~/.claude.json`). Its script,
`ubersicht/jarvis-hud/lib/thunderbird.mjs`, calls only `listAccounts`,
`listFolders` and `listEvents`, and refuses anything else before it is sent.
Accounts show under the names you gave them in Thunderbird.

## Setup

Everything below assumes Apple Silicon and Homebrew.

1. **Command Line Tools.** JankyBorders and SketchyBar are compiled on install,
   so the tools must match your macOS. Update them from Software Update if
   Homebrew says they are outdated.

2. **Install the tools.** Plash is only on the Mac App Store; install it from
   there. Then:

   ```bash
   brew install --cask ubersicht
   brew tap FelixKratz/formulae
   brew trust --formula felixkratz/formulae/borders
   brew trust --formula felixkratz/formulae/sketchybar
   brew install felixkratz/formulae/borders felixkratz/formulae/sketchybar
   ```

   Recent Homebrew refuses formulas from third party taps until you trust them.
   These commands trust only these two formulas, not the whole tap.

3. **Fonts.**

   ```bash
   desktop-theme/install-fonts.sh
   ```

4. **Your weather location.**

   ```bash
   cp desktop-theme/ubersicht/jarvis-hud/config.example.json \
      desktop-theme/ubersicht/jarvis-hud/config.json
   ```

   Then edit the place name, latitude and longitude. `config.json` is gitignored.

5. **Turn it on.**

   ```bash
   desktop-theme/activate.sh
   ```

   This links the configs into `~/.config` and Übersicht's widget folder,
   starts JankyBorders and SketchyBar as login services, and sets the macOS
   menu bar to hide automatically. Move the mouse to the top edge and the Apple
   and app menus slide down over SketchyBar.

6. **Plash, once.** Open Plash from the menu bar icon, choose Add Website, and
   enter `file:///path/to/jarvis-home/desktop-theme/wallpaper/index.html`.
   Allow access to the folder when asked. In Plash's settings, turn on
   **Deactivate while on battery** and **Launch at login**, and leave browsing
   mode off.

7. **Übersicht, once.** On first launch it asks whether to check for updates.
   Answer it; no widgets appear until you do.

## Commands

```bash
desktop-theme/activate.sh              # turn everything on (skips what isn't installed)
desktop-theme/sketchybar-off.sh        # the normal macOS menu bar, back
desktop-theme/restore.sh               # the default macOS look
desktop-theme/restore.sh --uninstall   # ...and remove the apps, trust and fonts
```

`restore.sh` does the following:

* stops JankyBorders and SketchyBar;
* puts the menu bar setting back to what it was before `activate.sh` changed it;
* removes only the links this theme created;
* quits Plash and Übersicht and removes their login items.

Your normal wallpaper comes back as soon as Plash quits.

## macOS settings to change by hand

* **Appearance:** Dark.
* **Accent colour:** Blue (closest to the cyan), or Graphite for the most
  minimal look.
* **Icon and widget style:** Tinted, with a cyan tint.
* **Desktop and Dock:** automatically hide the Dock, and turn off "Show items:
  On Desktop" so files don't cover the HUD.

## Adjusting

* **HUD position:** `top`, `right` and `width` at the top of
  `ubersicht/jarvis-hud/index.jsx`. Keep it clear of the Jarvis app window.
* **Wallpaper:** grid spacing, particle count and brightness are in `CONFIG`
  at the top of `wallpaper/index.html`.
* **Menu bar:** items and colours are in `sketchybar/sketchybarrc`; each item's
  script is in `sketchybar/plugins/`. The Jarvis dot checks the bridge at
  `http://127.0.0.1:8787/health` every ten seconds.
* **Window glow:** colour and width are in `borders/bordersrc`.

## Known issues

* **Übersicht and its first dialog.** Übersicht ignores a normal quit request
  while its first launch dialog is open. `restore.sh` force quits it if needed.
* **Wi Fi name.** Recent macOS hides the network name from command line tools
  without Location Services, so the bar may show "WIFI ON" rather than the
  name.
* **Moving the folder.** Plash remembers the wallpaper by its file path and a
  folder permission, so if you move this folder, add the wallpaper again.

## Credits

The tools are by their authors: Plash by Sindre Sorhus, Übersicht by Felix
Hageloh, and JankyBorders and SketchyBar by Felix Kratz. Chakra Petch and
JetBrains Mono are under the SIL Open Font License 1.1 (see `public/fonts/`
in this repository). Weather comes from [Open-Meteo](https://open-meteo.com).
