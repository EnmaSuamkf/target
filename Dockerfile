# The Target Project — default agent image for `sandbox: docker` workflows.
#
# A workflow created with `--sandbox docker` runs each of its steps as
#   docker run --rm --user <your uid>:<your gid> \
#     -v <workdir>:<workdir> -v ~/.claude:~/.claude -w <workdir> \
#     <image> claude --resume <session> -p "<step>"
# so this image only has to provide the `claude` binary and whatever toolchain
# the repos you point at it need. The broker stays on the host: nothing in
# here talks to the hub, and no port is published.
#
# THIS IMAGE IS REPLACEABLE. The image name is a per-workflow field
# (`--image <name>`, or the "Container image" box in the New-workflow modal),
# so a Python repo and a Node repo can use completely different ones. This is
# just the default that `target-agent:latest` resolves to.
#
#   docker build -t target-agent:latest .
#
# On a machine where your account is not uid/gid 1000, build with matching ids
# so the in-image home is owned by the user the container is run as:
#
#   docker build -t target-agent:latest \
#     --build-arg AGENT_UID="$(id -u)" --build-arg AGENT_GID="$(id -g)" .
#
# Two things this image must NOT grow: a mounted docker socket (that is root
# on the host, handed to a bypassPermissions agent), and a baked-in API key
# (credentials arrive at run time, via the mounted harness home or -e).

FROM node:24-bookworm-slim

# Pin this to a specific version if you want reproducible agent behaviour
# across rebuilds; `latest` keeps the CLI current instead.
ARG CLAUDE_CODE_VERSION=latest

# The uid/gid the image's own non-root user gets. The broker passes
# `--user <uid>:<gid>` at run time regardless — this only decides which id
# owns the paths baked into the image, so files the agent creates in the
# bind-mounted repo come back owned by you and not by root.
ARG AGENT_UID=1000
ARG AGENT_GID=1000

# git: the agent works in real checkouts. ripgrep: Claude Code's search tool.
# ca-certificates: the model API is the one network call a step makes.
# The rest is the small change that makes a shell inside the container usable.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		ca-certificates \
		curl \
		git \
		jq \
		less \
		procps \
		ripgrep \
	&& rm -rf /var/lib/apt/lists/*

RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
	&& npm cache clean --force

# The node base image already ships a uid/gid 1000 user, so create one only
# when the requested ids are actually free — otherwise reuse what's there.
RUN if ! getent group "${AGENT_GID}" >/dev/null; then groupadd -g "${AGENT_GID}" agent; fi \
	&& if ! getent passwd "${AGENT_UID}" >/dev/null; then \
		useradd -m -u "${AGENT_UID}" -g "${AGENT_GID}" -s /bin/bash agent; \
	fi

# Default to non-root. `docker run --user …` overrides this, and the broker
# always passes it — the USER line is what protects a hand-run `docker run`
# that forgets to.
USER ${AGENT_UID}:${AGENT_GID}

# Deliberately no WORKDIR and no ENV HOME: the broker sets `-w <workdir>` to
# the repo's real absolute path and `-e HOME=<host home>` to the home whose
# `.claude` it mounted. Both MUST match the host paths exactly — the hub finds
# a run's transcripts by slugifying the workdir string, so a container that
# relocates either one silently produces a workflow whose every step looks
# stalled after ten minutes.

ENTRYPOINT []
CMD ["claude", "--help"]
