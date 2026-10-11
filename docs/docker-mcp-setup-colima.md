# Docker MCP setup with Colima

Follow these steps when Colima is the Docker runtime on macOS.

## 1. Start Colima

Run this in a Mac Terminal:

```bash
colima start
unset DOCKER_HOST
docker context use colima
docker info
```

**Why:** Target must use the Colima Docker engine. `docker info` must show
both a Client and a Server.

## 2. Build the Target image

From the Target repository:

```bash
cd <target-repo>
npm run target:install-and-build
```

**Why:** The image contains Git, `gh`, the Docker CLI, and the MCP tools.

## 3. Check the Colima socket and get its group

First check that the socket exists inside Colima:

```bash
colima ssh -- test -S /var/run/docker.sock && echo "using Colima Docker socket"
```

If nothing is printed, do not continue. Check that Colima and Docker are
running:

```bash
colima start
docker context use colima
docker info
```

When the socket exists, run:

```bash
export DOCKER_SOCKET_GID="$(colima ssh -- stat -c '%g' /var/run/docker.sock)"
echo "$DOCKER_SOCKET_GID"
```

The value must not be empty. Keep this terminal open.

**Why:** The agent is not root. This group ID gives it permission to use the
Docker socket.

## 4. Add the Docker mounts

In Target, open **Settings → Docker bind mounts** and add:

```text
$HOME/.env
$HOME/.config/gcloud
/var/run/docker.sock
```

**Why:**

- `$HOME/.env` provides MCP/API configuration.
- `$HOME/.config/gcloud` provides Google Cloud/BigQuery credentials.
- `/var/run/docker.sock` lets the agent start Dockerized MCPs.

Do not add `$HOME/.docker/run/docker.sock` in this guide.

## 5. Sign in to GitHub if needed

Only do this if the agent must access GitHub:

```bash
gh auth status
```

If it reports that you are not logged in:

```bash
gh auth login --web
```

**Why:** Target uses this login for GitHub access. Do not copy the token into
`.env` or into a Git URL.

## 6. Start Target

In the same terminal where `DOCKER_SOCKET_GID` was exported:

```bash
cd <target-repo>
npm start
```

Do not close this terminal while using Target.

## Security

Mounting `.env` exposes its secrets to the agent. Mounting
`/var/run/docker.sock` gives the container control over Colima's Docker
daemon. Use this setup only with trusted workflows and agents.
