# TCP tool requests

A TCP tool is a curl template plus named inputs and secret tokens. The agent
supplies the inputs. The hub fills the template and performs the HTTP request.
Inputs are untrusted: a step can be steered by anything it reads, so a value is
data, never more curl.

## What is substituted

The hub parses the template first, while `$PLACEHOLDER` text is still in it,
then fills each part once:

- the URL
- each header value
- the body, when the template has one

A value is not written back into the curl text, and it is not scanned again.
An input of `$TOKEN_1` or `$GITHUB_TOKEN` is those characters, not the secret
stored under that name. Token placeholders are filled only from that tool's
`tokens` map. An input that reuses a token's name does not override it.

Placeholders are `$NAME` and `<$NAME>`. The name is the input's `placeholder`
without the leading `$`.

## How a value is encoded

- **URL.** An input is percent-encoded as one component (`encodeURIComponent`),
  whether it sits in the path, the query, or the fragment. A space, quote,
  slash, `?`, `#`, or `@` stays inside that component, so the value cannot add
  a path segment, a query parameter, or a second host. `.` is not encoded.
  A value of `.` or `..` would make the URL parser climb to another path on
  the same origin (for example `/api/workflows/..` becomes `/api/`), so the
  hub refuses it and sends nothing. A dotted id such as `wf.1` is fine.
  Token values in the URL are inserted as stored.
- **JSON body.** A body whose text starts with `{` or `[` is JSON. Inputs and
  tokens are escaped the way a JSON string escapes them (`"`, `\`, newlines),
  and the template keeps the quotes around the placeholder. Any other body,
  such as a form post, is inserted once with no extra escaping.
- **Headers.** Values are inserted as stored. A header value that contains CR
  or LF is refused.

## Origin check

The request is sent only when the resolved URL's origin (scheme, host, and
port) is the origin written in the template. Otherwise the hub sends nothing
and returns `error`:

| `error` | When |
| --- | --- |
| `origin_mismatch` | The resolved origin differs from the template. The message names both origins and does not include token values. |
| `invalid_url` | The template URL or the resolved URL is not an absolute `http` or `https` URL, or the resolved path leaves the path written in the template. |
| `invalid_header` | A header value contains CR or LF. |
| `invalid_template` | The curl template does not parse. |
| `missing_inputs` | A required input was not provided. |

A placeholder in the host can still name a different machine, because `.` is a
legal host character and is not percent-encoded. That request fails
`origin_mismatch` and is not sent. The same check blocks another port and a
cloud metadata address (`169.254.169.254` and the like): those are a different
origin unless the template itself names them. The bundled Target Management
templates keep a fixed `http://127.0.0.1` origin and only substitute path
segments and JSON fields, so they keep working.

The hub does not follow redirects. A `302` from the template origin is the
tool result; the hub does not request the `Location`, so a redirect cannot
move the call to another path, port, or host.

## Step credential

The agent calls `POST /api/tcps/execute` with the step's `callbackToken` in
the query string (`stepId` and `token`). That same token authenticates the
broker's `POST /api/steps/:id/started` and `POST /api/steps/:id/result`. It
is not the hub admin token.

Each `dispatchStep` — the step's own work, its judge pass, and a command
step's on-success or on-failure agent — replaces the token before it builds
those URLs. A token from an earlier run or an old prompt stops matching
immediately. The new value is what the broker and the agent receive for this
run. Nothing in the hub log or in an error message keeps it: `?token=` is
stripped before a line is written. Tool token values are registered the same
way, including the hub admin token stored as `TOKEN_1` on the bundled Target
Management pack. The daemon does not print that admin token; it stays in the
hub config file. `npm start` still shows it in that command's own terminal.

`/api/tcps/execute` accepts that credential only while the run is active:

| Status | Tool calls |
| --- | --- |
| `queued` | Allowed. The run is dispatched and may not have posted `started` yet. |
| `running` | Allowed in every phase: `exec`, `judge`, `on_success`, `on_failure`. |
| `pending` | Refused, including a retry wait. The attempt is over, or the next one has not been dispatched. |
| `waiting`, `done`, `failed` | Refused. An abort is a `failed` step. The error is `step_not_running` (403). |

The `started` and `result` callbacks are not limited to those statuses. A
late callback for the token of the run that is finishing still authenticates;
once the step has left `queued` and `running`, the hub ignores the body
instead of applying it. The following dispatch is what retires the token.

An operator call (session cookie or admin bearer, no step token) is unchanged
and may run any tool.
