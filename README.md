# J.A.R.V.I.S. (local edition)

Based on [adewaskar/jarvis](https://github.com/adewaskar/jarvis) by Aditya
Dewaskar, used under the MIT License. All the original work (the holographic
interface, the reactor, the voice loop, the Claude Code bridge and its tool
gate) is his. This edition changes where the voice runs, what the brain costs,
and what the assistant is allowed to touch. For everything not described here,
see the [original README](https://github.com/adewaskar/jarvis#readme).

To pull future updates from the original project:

```bash
git fetch upstream
git merge upstream/main
```

---

## What's different

**Free local voice.** No ElevenLabs and no cloud speech. A small Python service
(`voice/server.py`) runs on your Mac:

* speech to text with `faster-whisper`
* speaking with **Kokoro**, with **Piper** as a fallback
* the wake word with **openWakeWord** and its "hey jarvis" model

In wake mode a clip that doesn't contain the wake word is dropped before
Whisper ever runs. If the service is down, the page falls back to the browser's
own voice.

**Cost routing.** Every request goes to one of two brains, and every answer is
logged to `logs/brain.log` with the brain and model that produced it.

* **Local:** simple lookups ("what's on my calendar tomorrow", "any new mail
  from Sam", "summarize my unread mail") go to a local model through Ollama.
  Free and private.
* **Claude:** drafting, anything about meetings, calls, notes or follow ups,
  and anything needing judgment or tone goes to Claude on your **Claude
  subscription**.
* **Never an API key.** The bridge refuses to start if it can see
  `ANTHROPIC_API_KEY` (or an auth token or base URL override), and the launcher
  removes them for Jarvis only, so other tools in your shell keep using them.
* **Easy to change.** The rules live in `bridge/routing.json`, a list of
  patterns per brain, and are read again on every request.

**A separate Ollama just for Jarvis.** It runs on port **11435** with its models
in `./ollama-models` inside this checkout, and gets its own home folder
(`./ollama-home`), so it never touches your main Ollama on 11434 or its models.
`npm start` starts it and stops it.

**Thunderbird and Granola, with a restricted allowlist.** Jarvis reads mail,
calendar and meeting notes through the
[Thunderbird MCP](https://github.com/TKasperczyk/thunderbird-mcp) extension and
[Granola's official MCP server](https://www.granola.ai/blog/granola-mcp).

* Only named tools are allowed:
  * Thunderbird: list accounts and folders, search and read messages, list
    calendars and events, save a draft, and open a reply for review.
  * Granola: list meetings, read notes, read a transcript, and search.
* Everything else is denied, including tools the servers add later.
* The local model gets the read tools only.
* Account connectors from claude.ai (your Gmail, Drive and so on) are kept
  out of Jarvis entirely.

**Draft only, never send.**

* Jarvis can save a new draft, or open a threaded reply in Thunderbird's
  compose window for you to review. It cannot send, forward, delete, move or
  change filters.
* Ask it to send and the bridge itself answers: "I can't send email, but I
  can save a draft for you to review."
* Replies go to the sender only unless you say "reply all".
* A request that names a person or subject gets a reply to the newest matching
  email. One that doesn't makes Jarvis ask which email you mean.

**Meeting follow ups.** "Draft a follow up to Sam from this afternoon's
meeting":

* Jarvis finds the meeting in Granola, and asks if more than one matches.
* It reads the notes first, and fetches the transcript only if the notes lack
  decisions or action items.
* It addresses the attendees other than you, replying in their existing thread
  if there is one, otherwise writing a new draft from the account that matches
  their domain (set in `.env`).

**A matching desktop theme.** `desktop-theme/` makes the rest of macOS look
like the HUD: a dim grid and particle wallpaper, desktop widgets for time, meetings,
unread mail, weather and system load, a cyan glow on the focused window, and a
menu bar with a Jarvis status dot. It is optional, uses about 4.5% of one CPU
core, and `desktop-theme/restore.sh` puts the default look back. See
[its README](desktop-theme/README.md).

**A macOS desktop app.** `desktop/` wraps the interface in a frameless Electron
window:

* **Backdrop:** a native frosted glass backdrop, with Clear and Dark
  alternatives chosen from a menu bar icon.
* **Clicks:** in Clear, clicks pass through empty areas.
* **Controls:** drag by the reactor, Cmd+Shift+J to show or hide, and always
  on top from the menu.
* **Security:** it loads nothing but `localhost`, grants only the microphone,
  and starts and stops all of Jarvis's services itself.

## Hardware

Tested on one machine: a **MacBook Pro with an M4 Max and 36 GB of memory**, on
macOS. The local model (`qwen3:30b-a3b-instruct-2507`, about 19 GB) answers a
calendar lookup in about seven seconds there. With less memory, choose a
smaller model with `JARVIS_LOCAL_MODEL`. The voice models add about 1 GB of
disk and run on the CPU. The desktop app is built for Apple Silicon only.

## Setup

You need macOS on Apple Silicon, Node.js 20 or newer, Python 3.11 or newer,
[Ollama](https://ollama.com), Claude Code installed and logged in with a Claude
subscription, Thunderbird with the Thunderbird MCP extension, and Granola.

1. **Install and check.**

   ```bash
   npm install
   npm run setup
   cp .env.example .env      # then edit .env
   ```

2. **Local voice.** Follow `voice/README.md` to create `voice/.venv` and
   download the Whisper, Kokoro, Piper and wake word models.

3. **The Jarvis Ollama and its model.** Start the instance once by hand to pull
   the model; after that `npm start` runs it.

   ```bash
   mkdir -p ollama-home
   HOME=$PWD/ollama-home OLLAMA_HOST=127.0.0.1:11435 \
     OLLAMA_MODELS=$PWD/ollama-models ollama serve &
   OLLAMA_HOST=127.0.0.1:11435 ollama pull qwen3:30b-a3b-instruct-2507-q4_K_M
   ```

   Keep this checkout on your internal drive. macOS asks for permission before
   background processes read an external volume, and an Ollama whose models
   sit on one will hang when started from the desktop app.

4. **Mail, calendar and meeting notes.** Add both servers at user scope. Run the
   Granola login in a normal terminal window; it opens a browser to sign in and
   cannot finish without an interactive terminal.

   ```bash
   claude mcp add --scope user thunderbird -- node /path/to/thunderbird-mcp/mcp-bridge.cjs
   claude mcp add --transport http --scope user granola https://mcp.granola.ai/mcp
   claude mcp login granola
   claude mcp list
   ```

   In the Thunderbird MCP extension's settings, leave **Block skipReview** on
   (it is on by default). That is what makes an opened reply wait for you.

5. **Run it.**

   ```bash
   npm start
   ```

   Open http://localhost:5173 in Chrome, click INITIALISE, and say "Hey Jarvis".

6. **The desktop app (optional).**

   ```bash
   cd desktop
   npm install
   npm run icon
   npm run build             # installs /Applications/Jarvis.app
   ```

   Allow the microphone when macOS asks. To open it at login: System Settings,
   General, Login Items, then add Jarvis.

## Three tests

Say these out loud, or send them to the running bridge without a microphone:

```bash
node scripts/ask.mjs "What's on my calendar tomorrow?"
node scripts/ask.mjs "Draft a reply to my most recent email"
node scripts/ask.mjs "Send an email to myself"
```

The first should be answered by the local model. The second goes to Claude,
which asks which email you mean, or drafts a reply if you name one. The third is
refused by the bridge. Check which brain answered each:

```bash
npm run brains
```

## Known limitations

* **Your own speakers can't wake it.** The microphone uses echo cancellation,
  so audio played by the Mac itself (including test clips) never reaches the
  wake word. Test with your voice.
* **Replies open a window rather than a draft.** Thunderbird MCP's `saveDraft`
  cannot thread a reply, so replies in an existing thread open Thunderbird's
  compose window instead of saving silently. New emails are saved as drafts.
* **The local model needs help with dates.** It gets date ranges and times
  converted for it by the bridge. Thunderbird reports times in UTC, and the
  model reads them aloud wrongly otherwise.
* **Claude still counts against your plan.** Claude answers draw on your
  subscription's usage limits, even though nothing is billed per token.
* **Some connectors and features are off by design.** Account connectors from
  claude.ai are unavailable to Jarvis. The desktop app denies the camera, so
  the vision and hand tracking features only work in the browser.
* **The desktop app is signed only ad hoc.** It is built locally for Apple
  Silicon and not notarised, so it runs only on the machine that built it.
* **It has been tested on one machine,** with one set of mail accounts.

## Credits and licences

* **Jarvis:** [adewaskar/jarvis](https://github.com/adewaskar/jarvis) by Aditya
  Dewaskar, MIT. See `LICENSE` for the original copyright notice; this edition
  is released under the same licence.
* **Fonts**, stored in `public/fonts/` so the page loads nothing remote:
  * [Chakra Petch](https://github.com/m4rc1e/Chakra-Petch), copyright 2018 The
    Chakra Petch Project Authors, SIL Open Font License 1.1
    (`public/fonts/ChakraPetch-OFL.txt`).
  * [JetBrains Mono](https://github.com/JetBrains/JetBrainsMono), copyright 2020
    The JetBrains Mono Project Authors, SIL Open Font License 1.1
    (`public/fonts/JetBrainsMono-OFL.txt`).
* **Voice:** `faster-whisper`, Kokoro (`kokoro-onnx`), Piper and openWakeWord
  are installed by `voice/README.md` and are not part of this repository.
