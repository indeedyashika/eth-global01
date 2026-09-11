FROM node:22-bookworm-slim AS platform-builder

WORKDIR /build/platform

# better-sqlite3 is a native Node module. Its Node 22 binary is not always
# available from npm, so node-gyp needs Python and a C/C++ toolchain to build it.
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 make g++ && \
    rm -rf /var/lib/apt/lists/*

# Install dependencies before copying application sources so Docker can reuse
# the expensive npm layer while only UI/application code changes.
COPY apps/platform/package.json apps/platform/package-lock.json ./
RUN npm install

COPY apps/platform/ ./
RUN npm run build && \
    cp -r public .next/standalone/ && \
    cp -r .next/static .next/standalone/.next/


FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim

# Which hermes-agent revision to install. Accepts any git ref the upstream
# repo publishes — a release tag (recommended for reproducibility) or a
# branch name (`main`) for bleeding edge.
#
# To bump: check https://github.com/NousResearch/hermes-agent/releases for the
# newest tag (format `vYYYY.M.D`, optionally with a `.PATCH` suffix, e.g.
# `v2026.5.29.2`) and update the default below. Use `main` only if you accept
# that every rebuild can pull arbitrary new upstream commits.
ARG HERMES_REF=v2026.7.1

# tini = tiny init that we run as PID 1. Without it, hermes's grandchild
# processes (MCP stdio servers, git, bun, browser daemons spawned by tools)
# reparent to PID 1 when their parents exit and pile up as zombies. After
# weeks of uptime that exhausts the kernel's PID table → "fork: cannot
# allocate memory" and the container dies. tini reaps zombies in the
# background and forwards SIGTERM/SIGINT to our entrypoint so Railway's
# stop signal still triggers our graceful shutdown. Standard container init
# (same as Docker's `--init` flag and Kubernetes' pause container).
#
# Node.js is required only at build time to compile the Hermes React dashboard.
# We strip the source + apt lists afterwards to keep the image lean.
RUN apt-get update && \
    apt-get install -y --no-install-recommends curl ca-certificates git tini && \
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && \
    apt-get install -y --no-install-recommends nodejs && \
    rm -rf /var/lib/apt/lists/*

# Install hermes-agent (provides the `hermes` CLI) and pre-build its React
# dashboard so `hermes dashboard` has nothing to build at runtime.
#
# [all] in v2026.6.5 no longer pulls in [dev]; messaging platforms, TTS, and
# other heavy backends are lazy-installed by hermes at first use. We pre-install
# the ones this template actually uses so first-message latency is instant.
# `vision` (Pillow) is a soft-dep that is NOT in [all] and is otherwise
# lazy-installed at first image use: without it hermes can't downscale an
# oversized image (>5 MB / >8000px), which then bakes into immutable history
# and bricks the session on Anthropic's non-retryable 400. We bake it in.
# When bumping HERMES_REF, re-check hermes-agent's pyproject.toml [all] and
# the extras below against the new release's pyproject.toml.
RUN git clone --depth 1 --branch ${HERMES_REF} https://github.com/NousResearch/hermes-agent.git /opt/hermes-agent && \
    cd /opt/hermes-agent && \
    uv pip install --system --no-cache -e ".[all,messaging,tts-premium,honcho,bedrock,anthropic,edge-tts,hindsight,vision]" && \
    cd /opt/hermes-agent/web && \
    npm install --silent && \
    npm run build && \
    cd /opt/hermes-agent/ui-tui && \
    npm install --silent --no-fund --no-audit --progress=false && \
    npm run build && \
    rm -rf /opt/hermes-agent/web /opt/hermes-agent/.git /root/.npm

# Why pre-build ui-tui (and why we don't delete it after):
# - The dashboard's embedded Chat tab spawns `node ui-tui/dist/entry.js`
#   on every WebSocket connect to /api/pty.
# - Without HERMES_TUI_DIR, hermes's _make_tui_argv falls through to the
#   npm install + build path (since git-editable installs don't have the
#   bundled tui_dist/ that PyPI wheels include), adding 30-60s to the
#   first chat-open and blocking the asyncio event loop.
# - Pre-building at image time surfaces build failures here rather than
#   at user request time, and makes first-chat-open instant.
# - We keep ui-tui/ entirely (node_modules + dist + src) so HERMES_TUI_DIR
#   can point at it (see below).

# Stamp the CODE-SCOPED install method next to the running package. hermes'
# detect_install_method() reads <install-tree>/.install_method FIRST (priority 1,
# authoritative) — before the home-scoped $HERMES_HOME/.install_method that
# start.sh writes (priority 2, honored only when is_container() is true). The
# install tree for our editable install is /opt/hermes-agent (parent of
# hermes_cli/, i.e. Path(config.py).parent.parent). Baking the stamp here makes
# the dashboard "Update Hermes" button refuse regardless of runtime container
# detection — exactly what upstream's own published image does (it bakes a
# docker stamp into /opt/hermes). Belt-and-suspenders with start.sh's home stamp:
# if a future hermes release changes or drops is_container()'s Railway marker
# (/run/.containerenv), the home stamp would stop being honored but this one
# still refuses. Re-verify the install-tree path if hermes stops installing
# editable from /opt/hermes-agent.
RUN printf 'docker\n' > /opt/hermes-agent/.install_method

COPY apps/agent/requirements.txt /app/requirements.txt
RUN uv pip install --system --no-cache -r /app/requirements.txt

# ── Subgraph MCP (TypeScript) — split into subgraph_read (src/read.ts, pure
# GraphQL/RPC queries, never imports node:child_process) and subgraph_write
# (src/write.ts, edits subgraph.yaml and shells out to graph-cli; needs
# GRAPH_DEPLOY_KEY) — both registered in server.py:write_config_yaml. Shipped
# and run AS-IS (no Python port): Hermes launches each as a stdio subprocess
# via tsx (see the mcp_servers.subgraph_read/subgraph_write commands there).
# Two checkouts are baked in:
#   /opt/subgraph-mcp — the MCP server itself (needs tsx + its runtime deps).
#   /opt/subgraph     — the subgraph project the deploy tools shell out to; its
#                       node_modules carries @graphprotocol/graph-cli, which
#                       add_token_source/set_token_sources invoke via
#                       `npm run codegen|build|deploy`.
# Node 22 is already installed above (for the dashboard build), so no new
# toolchain is needed. node_modules is .dockerignore'd from the build context,
# so a fresh `npm ci` per arch is required — never rely on host node_modules.
# Deps are installed BEFORE app sources are copied (below) so these heavy
# graph-cli layers stay cached across ordinary server.py/app edits; the manifest
# lives on the /data volume at runtime (see start.sh + SUBGRAPH_DIR), so
# /opt/subgraph stays a read-only template.
COPY apps/agent/mcps/subgraph/mcp-server/package.json apps/agent/mcps/subgraph/mcp-server/package-lock.json /opt/subgraph-mcp/
RUN cd /opt/subgraph-mcp && npm ci --no-audit --no-fund
COPY apps/agent/mcps/subgraph/mcp-server/ /opt/subgraph-mcp/
COPY apps/agent/mcps/subgraph/subgraph/package.json apps/agent/mcps/subgraph/subgraph/package-lock.json /opt/subgraph/
RUN cd /opt/subgraph && npm ci --no-audit --no-fund
COPY apps/agent/mcps/subgraph/subgraph/ /opt/subgraph/

RUN mkdir -p /data/.hermes /data/tokenization

COPY apps/agent/server.py /app/server.py
# hedera and evm are each split into a read-only and a write (state-mutating)
# MCP server sharing a common.py — see mcps/{hedera,evm}/{common,read_server,
# write_server}.py. Copy each whole directory (not single files) so the
# non-relative `from common import ...` in read_server.py/write_server.py
# resolves: running `python /app/mcps/hedera/read_server.py` auto-adds that
# script's own directory to sys.path, so common.py just needs to sit next to
# it — see server.py:write_config_yaml for how each is registered under its
# own mcp_servers key (hedera_read/hedera_write, evm_read/evm_write).
COPY apps/agent/mcps/hedera/ /app/mcps/hedera/
COPY apps/agent/mcps/evm/ /app/mcps/evm/
COPY apps/agent/mcps/worldid/server.py /app/worldid_mcp.py
COPY apps/agent/mcps/usps_chainlink/ /app/mcps/usps_chainlink/
COPY apps/agent/mcps/superfluid/ /app/mcps/superfluid/
COPY apps/agent/templates/ /app/templates/
COPY apps/agent/start.sh /app/start.sh
# Default agent identity (AGENTS.md, etc.) — start.sh seeds these onto the
# $HERMES_HOME volume only if the file isn't already there, same idiom as
# config.yaml below, so this survives redeploys with a fresh/reused volume
# without ever overwriting an operator's or the agent's own runtime edits.
COPY apps/agent/agent-identity/ /opt/hermes-agent-identity/
# Identity for the separate, locked-down `pr` (public-relations) profile — see
# server.py's PR_* constants / write_pr_config_yaml and start.sh's seeding of
# this into $HERMES_HOME/profiles/pr/workspace/AGENTS.md.
COPY apps/agent/agent-identity-pr/ /opt/hermes-agent-identity-pr/
COPY --from=platform-builder /build/platform/.next/standalone/ /app/tokenization/
RUN chmod +x /app/start.sh

ENV HOME=/data
ENV HERMES_HOME=/data/.hermes
ENV TOKENIZATION_APP_DIR=/app/tokenization
ENV TOKENIZATION_PORT=3000
ENV DATABASE_PATH=/data/tokenization/tokenization.db

# Points hermes at our pre-built TUI bundle. hermes's _make_tui_argv checks
# HERMES_TUI_DIR first: if dist/entry.js exists there, it skips the npm
# install/build entirely. This is the official packager path (Nix uses it too)
# and avoids the 30-60s npm bootstrap that git-editable installs would otherwise
# trigger on first /chat connection.
ENV HERMES_TUI_DIR=/opt/hermes-agent/ui-tui

# tini wraps start.sh so it runs as PID 1's child instead of as PID 1 itself.
# `-g` propagates signals to the whole process group so `docker stop` /
# Railway's SIGTERM cleanly terminates the entire tree, not just start.sh.
ENTRYPOINT ["/usr/bin/tini", "-g", "--"]
CMD ["/app/start.sh"]
