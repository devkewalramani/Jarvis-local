# CLAUDE.md

Jarvis, local edition: a fork of adewaskar/jarvis. See README.md for what it is
and how it runs. This repository is **public**.

## Publishing

* **Commit every change.** After any change, commit it with a clear message
  that says what changed and why.
* **Never commit** `.env`, logs, audio clips, model files, or build output.
  The pre-commit hook (`.githooks/pre-commit`) blocks these, along with
  secrets and the personal values in `.githooks/blocklist.local`. Never bypass
  it with `--no-verify`.
* **Before pushing,** show the owner the commits about to be pushed (`git log
  --format='%h %an <%ae> %s' origin/main..HEAD`) and a scan result (gitleaks
  over the full history), then **wait for an explicit OK**.
* **Never force push.**

The hook is enabled per clone with `git config core.hooksPath .githooks`, and
needs gitleaks on the PATH or in `~/.local/bin`.
