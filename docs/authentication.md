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

When the hub listens beyond loopback — docker-friendly `0.0.0.0`, or any
`host` that is not `127.0.0.1`, `localhost`, or `::1` — setup is accepted only
from a loopback client. Any other address gets `403 setup_loopback_only`, and
the setup screen shows that message. Create the account in a browser on the
host (`http://127.0.0.1` and the hub's port). Sign-in from other machines
works after that. A hub bound to loopback is unchanged, because nothing off
the machine can open the socket.

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

The reset endpoint is open by design and throttled so guessing stays limited
without one shared address locking everyone else out:

- **Per recovery token.** 5 failures lock that token for 15 minutes, doubling
  on repeat (capped at 6 hours).
- **Per client address.** 5 failures hold that address for 30 seconds and the
  hold does not double. After it expires, a different token from the same
  address (another person behind the same proxy or docker bridge) can try
  again. A different address is never held by this bucket.
- **Global.** 20 failures from any addresses impose a 10-second hold on
  everyone, then that counter resets.

A locked attempt is `429` with `retryAfterSec`.

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
the database directly with no HTTP auth at all. The hub log does not print it, and `npm start` does not print it either —
the Ready block names `~/.target/config.json` (or `$TARGET_HOME/config.json`). `GET /api/auth/status` is the
only data-adjacent route that stays open; everything else under `/api` —
reads included — answers `401 login_required` without a session cookie or the
admin token. The awb step callbacks (`/api/steps/:id/started|result`) keep
their per-step tokens and are unaffected by this gate. That token rotates on
every dispatch and only authorises `POST /api/tcps/execute` while the step is
`queued` or `running` (see `docs/tcp-tools.md`).

## Threat model (stated plainly)

A request is answered only when its `Host` is a name this hub expects on the
port the connection arrived on (the configured `port` in production — nothing
is hard-coded to 8893). Those names are loopback (`localhost`, `127.0.0.1`,
`::1`), the configured `host` and `sandboxHost`, `host.docker.internal`, the
docker bridge address (including the documented `172.17.0.1` default), and,
when the hub is bound to every interface (`0.0.0.0` or `::`), this machine's
own addresses. Anything else is `403 {"error":"forbidden_host"}` before
routing. That stops a page from reaching the API, including open routes such
as `POST /api/auth/setup`, by rebinding its DNS name to 127.0.0.1. When the
hub listens beyond loopback, that same setup route also refuses any client
that is not loopback (`403 setup_loopback_only`). `GET
/health` stays open for those same names, so readiness checks keep working.

`POST`, `PUT`, `PATCH`, and `DELETE` from a browser must come from the hub's
own origin: a present `Origin` that isn't one of those names on this port, or
`Sec-Fetch-Site: cross-site`, is `403 {"error":"cross_origin"}`. Ports do not
make a different site, so a page on `http://127.0.0.1:3000` is refused even
though the session cookie is `SameSite=Strict`. Routes that read a JSON body
require `Content-Type: application/json` (`415 {"error":"unsupported_media_type"}`
otherwise), so a cross-origin `text/plain` body is not parsed. Clients that
send no `Origin` — the CLI, the MCP server, awb's broker callbacks, curl, and
sandboxed agents — keep working. The Vite dev server (`hub/ui/vite.config.ts`,
port 5173) proxies `/api` and rewrites `Origin` to the hub origin; the browser
page itself is never a second allowed origin. The Electron shell
(`desktop/shared/main.mjs`) loads that same hub URL in the window, so its
`Host` and `Origin` are the hub's, not a second site.

Names are compared after lowercasing, stripping one trailing DNS dot, and
removing a zone id and the brackets around an IPv6 literal. So `LOCALHOST`
and `localhost.` are the loopback name, and `[::1]` on this port is too. The
same check still refuses:

- a missing `Host`, including an HTTP/1.0 request that omits it, and a
  `Host` with no port (that means port 80) when the connection is on another
  port;
- a name with userinfo (`evil@127.0.0.1`) or a percent-encoded lookalike of
  an allowed address;
- one trailing dot used to hide another label (`localhost.evil.example.`);
- unbracketed IPv6, the expanded form of `::1`, and `::ffff:127.0.0.1` —
  those are not rewritten into the loopback entries;
- `Origin: null` and an `Origin` that only matches because of userinfo
  (`http://evil@127.0.0.1:port`) on any state-changing method.

`GET /`, `/favicon.ico`, and `/assets/…` go through that `Host` check before
a file is opened. A `..` segment is collapsed by the URL parser and the file
still has to sit inside `hub/ui/dist`. There is no WebSocket route: an
`Upgrade` request has no listener, and a bad `Host` on it is not a successful
response.

This protects the app from casual browser-level access to
`http://127.0.0.1:8893`. It does **not** defend against someone with shell or
filesystem access to the machine: they can read `target.db`, wipe
`~/.target/`, or open terminals through the local API. It also does not
authenticate a non-browser client that simply omits `Origin` — that client
still needs a session or the admin token, except on the routes that are open
on purpose (`GET /health`, first-run setup from loopback, and password reset,
which stays throttled). `GET` is not origin-checked: the hub sends no CORS
header and the session cookie is `SameSite=Strict`, so a foreign page cannot
read the body or attach the cookie. The login page and its assets are
reachable without a session, from an allowed `Host`, so the UI can load.
There is no TLS. Binding beyond loopback (docker-friendly `0.0.0.0`) is
opt-in; setup from any other machine is refused, but once an account exists
sign-in from the LAN is possible. If you expose the port (SSH tunnel, reverse
proxy), add TLS and the `Secure` cookie flag first.
