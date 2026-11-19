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

## Local git directories

`target://git-clone` and `target://git-push` run `git` on the hub machine.
The directory they use depends on who is calling.

A running step (`queued` or `running`, step credential) may only clone into
or push from its own workflow workdir. That includes the optional `workdir`
input and the clone destination (`<workdir>/<repo>`). The hub resolves the
path with `realpath`, following symlinks, including a destination that does
not exist yet (the missing suffix is joined onto the real path of the longest
existing ancestor). An absolute path, a `..` segment, or a symlink that lands
outside that workdir is refused with `workdir_outside_workflow`. Git is not
started. Repository names `.` and `..` are refused with `invalid_inputs`.

An operator call may pass any directory the hub user can reach. The operator
already has this process's filesystem access, so there is no workflow
boundary on that call. `.` and `..` are still refused as repository names.

For a step, `.git` itself has to stay inside that workdir. A `.git` directory,
a `gitdir:` file, a symlink, the common git dir, the object store, or an
object alternate that realpaths outside is `git_dir_outside_workflow` and git
is not started. An operator may follow a `gitdir:` that points at a linked
worktree outside the directory they named.

## Local git execution

The hub runs `git` itself, on the host. A repository the agent can write is
not allowed to choose what that process executes or where credentials go.

System config is skipped (`GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_SYSTEM=/dev/null`)
and global config is an empty file created for the command, so `~/.gitconfig`
and the XDG git config are not read. Git variables inherited from the hub
process that would select another repository or a program are dropped
(`GIT_DIR`, `GIT_WORK_TREE`, `GIT_SSH_COMMAND`, `GIT_PROXY_COMMAND`,
`GIT_EXTERNAL_DIFF`, `GIT_ALTERNATE_OBJECT_DIRECTORIES`, and the other
`GIT_CONFIG_*` values).
`GIT_PAGER`, `GIT_ASKPASS`, and `GIT_EDITOR` are neutral programs. On top of that the hub sets
`GIT_CONFIG_KEY_*` / `GIT_CONFIG_VALUE_*`, which override a repository value
for a single-valued key: hooks come from an empty directory outside the
repo, fsmonitor is off, `core.sshCommand` is plain `ssh`, the credential
helper list is reset, only `https` is allowed, TLS verification stays on,
and an HTTP proxy is not taken from the repo.

`url.*.insteadOf` and `include.path` are lists. Adding another value does
not remove a repo entry, and the longest `insteadOf` match wins, so a
repository can still rewrite a URL after an override. Push therefore does
not read the repository config: the hub copies refs and points object
alternates at the repo, and runs git against that sanitized git dir. Clone
runs with a current directory that is not inside any repository, and the
URL it is given is the plain `https://github.com/<owner>/<repo>.git`.

The GitHub token is not put in that URL, in argv, or in any file in the
workdir. When the tool has a token it is sent as an `Authorization: Bearer`
header through `http.extraHeader` in the environment. After a clone,
`remote.origin.url` is the plain https URL. The token is registered with
the hub's secret redaction, and text returned to the agent (git's stdout,
stderr, and a spawn error) is passed through that redaction as well.
