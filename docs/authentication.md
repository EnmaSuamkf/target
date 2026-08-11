# Access & authentication

Target is a local app with exactly **one account per machine**. There is no
remote server, no e-mail, no identity provider — everything lives under
`~/.target/` (or `$TARGET_HOME`). This document is the operator-facing summary
of that subsystem; the full design rationale is in `usershandler.html`.

## First-run setup (signup)

The first time the hub's UI loads on a fresh install, the landing page offers
**Get started**: pick a password (≥ 10 characters) and, optionally, a display
name (display only — login is password-only, there is no username).

Setup then shows your **recovery token** exactly once, in the form
`XXXXX-XXXXX-XXXXX-XXXXX`. Copy it or download it and keep it somewhere safe
(password manager or printed): it is the **only** way to reset a forgotten
password. The server stores only its SHA-256, so it can never be shown again.

Once the account exists, setup is permanently closed: `POST /api/auth/setup`
answers `409 setup_already_completed` and the UI only ever offers sign-in.

## Login

One password field. Signing in sets a `target_session` cookie
(`HttpOnly; SameSite=Strict`, 30-day cap, 14-day idle expiry, sliding renewal)
and lands on the workflows screen, where all local workflows are visible —
there is no per-user data, so there is nothing to filter.

Brute-force protection: 5 consecutive wrong passwords lock the account for 5
minutes, doubling on each repeat lockout (capped at a day). While locked,
**every** attempt fails, even the correct password — a lockout that let it
through would confirm the guess.

## Forgot password

The **Forgot password** link on the sign-in screen asks for your recovery
token and a new password. On a match, in one step:

- the new password replaces the old one (fresh scrypt salt),
- the recovery token **rotates** — the screen shows the new token once, and
  the one you used is dead,
- every existing session is killed (other browsers must sign in again),
- the lockout counters reset, and you're signed in immediately.

The reset endpoint is open by design and throttled per IP: 5 failed attempts
hold it for 15 minutes, doubling on repeat.

## Lost password AND lost token

There is deliberately **no recovery path**. The documented procedure is a full
local reset:

```bash
# 1. stop the hub (Ctrl-C, or: lsof -ti :8893 | xargs kill)
# 2. optional backup:
cp -a ~/.target ~/.target-backup-$(date +%F)
# 3. wipe the state directory:
rm -rf ~/.target
# 4. restart — first-run setup appears again:
npm start
```

This destroys **everything**: workflows, steps, templates, attachments,
settings, the account and every step-result file. Back up first if any of it
matters.

## The legacy admin token

`~/.target/config.json`'s `adminToken` still works as a Bearer credential
alongside sessions (for scripts and automation), and the CLI keeps talking to
the database directly with no HTTP auth at all. `GET /api/auth/status` is the
only data-adjacent route that stays open; everything else under `/api` —
reads included — answers `401 login_required` without a session cookie or the
admin token. The awb step callbacks (`/api/steps/:id/started|result`) keep
their per-step tokens and are unaffected.

## Threat model (stated plainly)

This protects the app from casual browser-level access to
`http://127.0.0.1:8893`. It does **not** defend against someone with shell or
filesystem access to the machine: they can read `target.db`, wipe
`~/.target/`, or open terminals through the local API. If you expose the port
(SSH tunnel, reverse proxy), add TLS and the `Secure` cookie flag first.
