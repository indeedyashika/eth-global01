#!/bin/bash
set -e

# Mirror dashboard-ref-only's startup: create every directory hermes expects
# and seed a default config.yaml if the volume is empty. Without these,
# `hermes dashboard` endpoints that hit logs/, sessions/, cron/, etc. can fail
# with opaque errors even though no auth is actually involved.
# NOTE (hermes >= v2026.7.1): several dirs were consolidated and are now
# resolved via get_hermes_dir("<new>", "<old>"), which returns the NEW path
# unless the OLD one already has *content*. Seeding an empty legacy stub no
# longer "claims" it — hermes ignores empty stubs and writes to the new path
# (upstream #27602). So we seed the NEW paths: pairing -> platforms/pairing,
# image_cache -> cache/images, audio_cache -> cache/audio. A populated legacy
# dir from a pre-v2026.7.1 deploy still wins on both sides, so no migration is
# needed. server.py:_resolve_pairing_dir() mirrors this same rule for the
# admin panel's Users tab — keep the two in sync on future bumps.
mkdir -p /data/.hermes/cron /data/.hermes/sessions /data/.hermes/logs \
         /data/.hermes/memories /data/.hermes/skills /data/.hermes/platforms/pairing \
         /data/.hermes/hooks /data/.hermes/cache/images /data/.hermes/cache/audio \
         /data/.hermes/workspace /data/.hermes/skins /data/.hermes/plans \
         /data/.hermes/home /data/tokenization

# Stamp the install method as "docker" so hermes treats this as an immutable
# container image, not a pip checkout. hermes's detect_install_method() reads
# $HERMES_HOME/.install_method FIRST (before any .git / pip fallback). Without
# this stamp the template falls through to "pip" — because the Dockerfile strips
# /opt/hermes-agent/.git — and the dashboard's "Update Hermes" button then runs
# a real `hermes update` (PyPI pip-upgrade) INSIDE the running container. That
# upgrade is ephemeral (reverts on the next redeploy) and can desync the Python
# package from the image's pre-built web_dist/ui-tui bundles. Stamping "docker"
# makes that button correctly refuse with "pull a fresh image / redeploy", which
# matches the real upgrade path here (bump HERMES_REF in Railway + redeploy).
# Written unconditionally each boot so it stays correct and self-heals.
printf 'docker\n' > /data/.hermes/.install_method

if [ ! -f /data/.hermes/config.yaml ] && [ -f /opt/hermes-agent/cli-config.yaml.example ]; then
  cp /opt/hermes-agent/cli-config.yaml.example /data/.hermes/config.yaml
fi

[ ! -f /data/.hermes/.env ] && touch /data/.hermes/.env

# Seed the agent's identity/context files from the repo-committed defaults.
# CLAUDE.md is our deployment-managed interview policy and is refreshed on
# every image update. Other files remain operator-editable and are seeded only
# when absent.
#
# Routing matters: Hermes loads these two file classes from DIFFERENT places.
#   - Project-context files (AGENTS.md, .hermes.md, CLAUDE.md, .cursorrules)
#     are discovered from the SESSION WORKING DIRECTORY (terminal.cwd, which
#     server.py now points at /data/.hermes/workspace) and injected into the
#     system prompt at session start. Seeding them into HERMES_HOME does
#     nothing — that path is never scanned for them.
#   - SOUL.md and other identity files are loaded from HERMES_HOME directly.
# So we seed project-context files into the workspace dir and everything else
# into HERMES_HOME root. Keep terminal.cwd (server.py AGENT_WORKDIR) in sync
# with the workspace path used here.
if [ -d /opt/hermes-agent-identity ]; then
  for f in /opt/hermes-agent-identity/*; do
    name="$(basename "$f")"
    case "$name" in
      AGENTS.md|.hermes.md|CLAUDE.md|.cursorrules)
        dest="/data/.hermes/workspace/$name" ;;
      *)
        dest="/data/.hermes/$name" ;;
    esac
    if [ "$name" = "CLAUDE.md" ] || [ "$name" = "AGENTS.md" ]; then
      cp "$f" "$dest"
    elif [ ! -f "$dest" ]; then
      cp "$f" "$dest"
    fi
  done
fi

# Same idiom, for the separate locked-down `pr` (public-relations) Hermes
# profile — its own home under $HERMES_HOME/profiles/pr/ (config.yaml is
# written by server.py's write_pr_config_yaml on every gateway start; here we
# only seed its dirs and project-context identity file). AGENTS.md is
# refreshed every boot (deployment-managed persona, same as CLAUDE.md above)
# since it's the one thing keeping this profile scoped to "answer questions,
# never act" — never leave a stale/tampered copy in place across a redeploy.
mkdir -p /data/.hermes/profiles/pr/workspace /data/.hermes/profiles/pr/sessions \
         /data/.hermes/profiles/pr/logs /data/.hermes/profiles/pr/memories
if [ -f /opt/hermes-agent-identity-pr/AGENTS.md ]; then
  cp /opt/hermes-agent-identity-pr/AGENTS.md /data/.hermes/profiles/pr/workspace/AGENTS.md
fi

# Bootstrap OAuth tokens from env var (e.g. xAI Grok SuperGrok).
# Set HERMES_AUTH_JSON_BOOTSTRAP to the contents of a locally-generated
# ~/.hermes/auth.json. Written only once — subsequent token refreshes update
# the file in place on the persistent volume.
if [ ! -f /data/.hermes/auth.json ] && [ -n "${HERMES_AUTH_JSON_BOOTSTRAP}" ]; then
  printf '%s' "${HERMES_AUTH_JSON_BOOTSTRAP}" > /data/.hermes/auth.json
  chmod 600 /data/.hermes/auth.json
fi

# Seed the writable, volume-backed subgraph working copy the "subgraph" MCP's
# deploy tools mutate. The image ships a read-only template at /opt/subgraph
# (code + node_modules incl. graph-cli); SUBGRAPH_DIR (set on the MCP env in
# server.py) points the server at /data/subgraph instead so the agent-managed
# token set in subgraph.yaml survives redeploys.
#
# Same "refresh code from the image, preserve runtime state" idiom as the
# identity files above:
#   - Code files (schema, abis, src, scripts, package*.json) are refreshed from
#     the image every boot so mapping/schema fixes ship with a redeploy.
#   - subgraph.yaml is PRESERVED if the volume already has one (the agent's live
#     tracked-token set), else seeded from the image template.
#   - node_modules is symlinked to the image's copy rather than duplicated onto
#     the volume: graph codegen/build only write generated/ and build/ under
#     SUBGRAPH_DIR, never into node_modules, so a shared read-only tree is safe
#     and avoids copying the heavy graph-cli install on every boot.
if [ -d /opt/subgraph ]; then
  mkdir -p /data/subgraph
  for item in schema.graphql abis src scripts package.json package-lock.json .gitignore; do
    if [ -e "/opt/subgraph/$item" ]; then
      rm -rf "/data/subgraph/$item"
      cp -r "/opt/subgraph/$item" "/data/subgraph/$item"
    fi
  done
  # Preserve an existing manifest; seed the template only on a fresh volume.
  if [ ! -f /data/subgraph/subgraph.yaml ]; then
    cp /opt/subgraph/subgraph.yaml /data/subgraph/subgraph.yaml
  fi
  # (Re)point node_modules at the image's baked install.
  rm -rf /data/subgraph/node_modules
  ln -s /opt/subgraph/node_modules /data/subgraph/node_modules
fi

# Clear any stale gateway PID file left over from the previous container.
# `hermes gateway` writes /data/.hermes/gateway.pid on start but does not
# remove it on SIGTERM. Since /data is a persistent volume, the file
# survives container restarts and causes every subsequent boot to exit with
# "ERROR gateway.run: PID file race lost to another gateway instance".
# No hermes process can be running at this point (we're pre-exec in a fresh
# container), so removing the file unconditionally is safe. Same for the `pr`
# profile's own gateway.pid (profiles have independent pid locks).
rm -f /data/.hermes/gateway.pid /data/.hermes/profiles/pr/gateway.pid

exec python /app/server.py
