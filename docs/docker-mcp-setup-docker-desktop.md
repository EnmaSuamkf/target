# Docker MCP setup with Docker Desktop

Follow these steps when Docker Desktop is the Docker runtime on macOS.

## 1. Start Docker Desktop

Open Docker Desktop and wait until it says that Docker is running. Then run:

```bash
unset DOCKER_HOST
docker context ls
docker context use desktop-linux
docker info
```

If `desktop-linux` is not listed, use the Docker Desktop context shown by
`docker context ls`.

**Why:** Target must use the Docker Desktop engine. `docker info` must show
both a Client and a Server.

## 2. Build the Target image

From the Target repository:

```bash
cd <target-repo>
npm run target:install-and-build
```

**Why:** The image contains Git, `gh`, the Docker CLI, and the MCP tools.

## 3. Check the Docker Desktop socket

Run:

```bash
test -S "$HOME/.docker/run/docker.sock" && echo "using Docker Desktop socket"
```

If nothing is printed, start Docker Desktop and wait until Docker is running.
Do not continue until the socket exists.

Unlike Colima, this guide does not require setting
`DOCKER_SOCKET_GID`. Docker Desktop manages the socket permissions.

## 4. Add the Docker mounts

In Target, open **Settings → Docker bind mounts** and add:

```text
$HOME/.env
$HOME/.config/gcloud
$HOME/.docker/run/docker.sock
```

**Why:**

- `$HOME/.env` provides MCP/API configuration.
- `$HOME/.config/gcloud` provides Google Cloud/BigQuery credentials.
- `$HOME/.docker/run/docker.sock` lets the agent start Dockerized MCPs.

Do not add `/var/run/docker.sock` in this guide.

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

Run:

```bash
cd <target-repo>
npm start
```

## Security

Mounting `.env` exposes its secrets to the agent. Mounting the Docker Desktop
socket gives the container control over the Docker daemon. Use this setup only
with trusted workflows and agents.
