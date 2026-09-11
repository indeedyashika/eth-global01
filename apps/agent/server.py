"""
Hermes Agent — Railway admin server.

Responsibilities:
  - Public Tokenization Platform reverse proxy at / (root) — the storefront
    random users land on
  - Admin UI / setup wizard at /setup (Starlette + Jinja, cookie-auth guarded)
  - Management API at /setup/api/* (config, status, logs, gateway, pairing)
  - Reverse proxy at /hermes and /* → native Hermes dashboard
    (hermes_cli/web_server, on 127.0.0.1:9119)
  - Managed subprocesses: `hermes gateway` (agent) and `hermes dashboard` (native UI)
  - Cookie-based session auth for Hermes at /login (HMAC-signed, 7-day expiry, httponly)

Auth model: Basic Auth was dropped in favor of cookies because the Hermes React
SPA's plain fetch() calls do not reliably include basic-auth creds across browsers,
and basic-auth's per-directory protection space forced separate prompts for
/setup and /hermes. Cookies auto-include on every same-origin request, so both
Hermes surfaces work with a single login. The tokenization app is intentionally
public and unguarded. The cookie signing secret is regenerated on every process
start, so any ADMIN_PASSWORD change on Railway (which triggers a redeploy)
invalidates all existing sessions.

Root layout: the Tokenization Next.js app owns / and its own known paths
(/tokens, /api/tokens, /api/runtime-config, /_next, public/ assets). The native
Hermes dashboard's own asset/API paths are root-relative and can't be moved
under a prefix (it's an upstream SPA we don't control), so it keeps living on
whatever isn't claimed by Tokenization: an explicit /hermes entry point for the
first page load, then the catch-all `/{path:path}` route for everything else
(its JS/CSS chunks, `/api/pty` etc., and SPA client-side routes on hard
refresh). First-visit behavior: if no provider+model config exists, GET /hermes
redirects to /setup. Once configured, /hermes proxies to the Hermes dashboard.
A small "← Setup" widget is injected into every proxied HTML response so users
can always return to the wizard.
"""

# PEP 563 lazy annotations: keeps function/parameter type hints as strings so
# they're never evaluated at import. Avoids the startup DeprecationWarning from
# annotating against websockets.WebSocketClientProtocol (renamed in websockets
# >= 14), and is forward-compatible regardless of the installed websockets
# version. Safe here — nothing in this module introspects annotations at runtime.
from __future__ import annotations

import asyncio
import json
import os
import re
import secrets
import shutil
import signal
import tempfile
import time
import zipfile
from collections import deque
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Callable

import httpx
import websockets
import websockets.exceptions
from starlette.applications import Starlette
from starlette.background import BackgroundTask
from starlette.datastructures import UploadFile
from starlette.requests import Request
from starlette.responses import (
    FileResponse,
    HTMLResponse,
    JSONResponse,
    RedirectResponse,
    Response,
)
from starlette.routing import Route, WebSocketRoute
from starlette.templating import Jinja2Templates
from starlette.websockets import WebSocket, WebSocketDisconnect, WebSocketState

ANSI_ESCAPE = re.compile(r"\x1b\[[0-9;]*m")
templates = Jinja2Templates(directory=str(Path(__file__).parent / "templates"))

HERMES_HOME = os.environ.get("HERMES_HOME", str(Path.home() / ".hermes"))
ENV_FILE = Path(HERMES_HOME) / ".env"

# Working directory the agent starts in. Hermes discovers AGENTS.md (and other
# project-context files) from the session's working directory at startup and
# injects it into the system prompt — it is NOT read from HERMES_HOME (that
# path is only scanned for SOUL.md). Two different rules pick that directory:
#   - Gateway/cron sessions honor terminal.cwd in config.yaml.
#   - The dashboard's embedded Chat tab is a TUI/CLI session, and the TUI
#     ALWAYS uses its launch directory (the cwd of the hermes process),
#     ignoring terminal.cwd. So it isn't enough to set terminal.cwd; we must
#     also spawn `hermes gateway`/`hermes dashboard` with cwd=AGENT_WORKDIR so
#     the pty the dashboard forks for /api/pty inherits it. Otherwise sessions
#     launch from server.py's own cwd (`/`, the image default) and AGENTS.md
#     at /AGENTS.md is never found.
# We use a dedicated workspace dir (seeded with AGENTS.md by start.sh) rather
# than HERMES_HOME itself so the agent's shell cwd stays out of the dir holding
# auth.json, .env, and sessions.
AGENT_WORKDIR = str(Path(HERMES_HOME) / "workspace")
Path(AGENT_WORKDIR).mkdir(parents=True, exist_ok=True)


def _resolve_pairing_dir() -> Path:
    """Locate the pairing store the same way hermes' get_hermes_dir() does.

    hermes resolves ``PAIRING_DIR = get_hermes_dir("platforms/pairing", "pairing")``:
    it honours the legacy ``$HERMES_HOME/pairing/`` ONLY when that dir has
    content, otherwise it uses the consolidated ``platforms/pairing/``. The rule
    changed in **v2026.7.1** — before it (v2026.6.19 and earlier) get_hermes_dir
    used a bare ``old_path.exists()``, so an *empty* ``pairing/`` (which start.sh
    used to seed on every boot) counted as "legacy in use" and both sides agreed
    on ``pairing/``. v2026.7.1 switched to ``_legacy_path_has_content()``, which
    ignores an empty stub (upstream #27602): the gateway now writes pending/
    approved files to ``platforms/pairing/`` while a hard-coded ``pairing/`` here
    would read the wrong (empty) dir — pending users vanish and approvals land
    where the gateway never looks. We mirror the exact rule so this admin panel
    and the gateway never split-brain: a *populated* legacy dir wins (preserves a
    pre-v2026.7.1 deployment's approved users with no migration), else the new
    consolidated path. Re-verify this against get_hermes_dir on the next bump.
    """
    legacy = Path(HERMES_HOME) / "pairing"
    try:
        if legacy.is_dir() and any(legacy.iterdir()):
            return legacy
    except OSError:
        # Can't inspect (e.g. permissions) — assume occupied rather than risk
        # orphaning legacy data, matching hermes' _legacy_path_has_content.
        return legacy
    return Path(HERMES_HOME) / "platforms" / "pairing"


PAIRING_DIR = _resolve_pairing_dir()
PAIRING_TTL = 3600

# Native Hermes dashboard — runs on loopback, fronted by our reverse proxy.
HERMES_DASHBOARD_HOST = "127.0.0.1"
HERMES_DASHBOARD_PORT = int(os.environ.get("HERMES_DASHBOARD_PORT", "9119"))
HERMES_DASHBOARD_URL = f"http://{HERMES_DASHBOARD_HOST}:{HERMES_DASHBOARD_PORT}"

# Tokenization Platform — a standalone Next.js server exposed publicly at the
# root domain (/) via reverse proxy. Keeping it on loopback prevents callers
# from bypassing the gateway and reaching port 3000 directly.
TOKENIZATION_HOST = "127.0.0.1"
TOKENIZATION_PORT = int(os.environ.get("TOKENIZATION_PORT", "3000"))
TOKENIZATION_URL = f"http://{TOKENIZATION_HOST}:{TOKENIZATION_PORT}"
TOKENIZATION_APP_DIR = Path(os.environ.get("TOKENIZATION_APP_DIR", "/app/tokenization"))
LIVENESS_SWEEP_INTERVAL_SECONDS = max(
    10, int(os.environ.get("LIVENESS_SWEEP_INTERVAL_SECONDS", "15"))
)

# Internal capabilities shared only by sibling processes in this container.
# Operators may provide stable values through Railway, otherwise a fresh pair is generated on
# every boot and injected into both the Next.js app and the managed Hermes configuration.
TOKENIZATION_AGENT_SECRET = os.environ.get("TOKENIZATION_AGENT_SECRET") or secrets.token_urlsafe(32)
TOKEN_REQUEST_WEBHOOK_SECRET = (
    os.environ.get("TOKEN_REQUEST_WEBHOOK_SECRET") or secrets.token_urlsafe(32)
)
TOKEN_REQUEST_WEBHOOK_URL = "http://127.0.0.1:8644/webhooks/token-request"
LIVENESS_VERIFICATION_WEBHOOK_URL = "http://127.0.0.1:8644/webhooks/liveness-verification"

# ── Public-relations ("pr") Hermes profile ───────────────────────────────────
# A second, locked-down Hermes profile — its own $HERMES_HOME/profiles/pr/
# directory (own config.yaml, .env, workspace, sessions, memories) — that only
# ever gets the read-only MCPs (hedera_read/evm_read/subgraph_read; never
# worldid or any *_write server) and has its terminal/file/browser/etc.
# toolsets disabled (see write_pr_config_yaml, build_pr_env, PrGateway). It
# exposes an OpenAI-compatible API server on a private loopback port that the
# tokenization platform's gated /api/tokens/[id]/chat route proxies to — no
# holder input is ever forwarded to the operator gateway, and no code path in
# this profile's process tree can deploy/mint/transfer/reclaim/pause/whitelist.
PR_PROFILE = "pr"
PR_HOME = Path(HERMES_HOME) / "profiles" / PR_PROFILE
PR_WORKDIR = str(PR_HOME / "workspace")
PR_API_SERVER_HOST = "127.0.0.1"
PR_API_SERVER_PORT = int(os.environ.get("PR_API_SERVER_PORT", "8643"))
PR_API_SERVER_URL = f"http://{PR_API_SERVER_HOST}:{PR_API_SERVER_PORT}"
# Bearer token hermes' api_server platform requires for every request, even on
# loopback (it refuses to start without one). Shared with the tokenization app
# below so its chat route can authenticate to this profile.
PR_API_SERVER_KEY = os.environ.get("PR_API_SERVER_KEY") or secrets.token_urlsafe(32)

# Header hermes' own SPA uses to present its per-process session token
# (hermes_cli/web_server.py's _SESSION_HEADER_NAME) — see
# set_active_model_via_hermes()/_get_hermes_session_token() for why our own
# server-to-server calls to the dashboard need it even on our loopback bind.
_SESSION_TOKEN_HEADER = "X-Hermes-Session-Token"

# Strip transport-scoped headers that must not cross a reverse proxy. Keep
# end-to-end auth headers — notably `authorization`, because the Hermes SPA
# uses Bearer tokens, and `cookie`, which carries our authenticated session.
HOP_BY_HOP = {
    "host",
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
}

ADMIN_USERNAME = os.environ.get("ADMIN_USERNAME", "admin")
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "")
if not ADMIN_PASSWORD:
    ADMIN_PASSWORD = secrets.token_urlsafe(16)
    print(f"[server] Admin credentials — username: {ADMIN_USERNAME}  password: {ADMIN_PASSWORD}", flush=True)
else:
    print(f"[server] Admin username: {ADMIN_USERNAME}", flush=True)

# ── Env var registry ──────────────────────────────────────────────────────────
# (key, label, category, is_secret)
ENV_VARS = [
    ("LLM_MODEL",               "Model",                    "model",     False),
    # ── Hedera operator / storefront (see .env.example) ─────────────────────
    ("HEDERA_NETWORK",           "Network",                  "hedera",    False),
    ("HEDERA_OPERATOR_ID",       "Operator account ID",      "hedera",    False),
    ("HEDERA_OPERATOR_KEY",      "Operator private key",     "hedera",    True),
    ("WALLETCONNECT_PROJECT_ID", "WalletConnect project ID", "hedera",    False),
    # ── Ethereum Sepolia operator ───────────────────────────────────────────
    ("SEPOLIA_RPC_URL",           "Sepolia RPC URL",          "evm",       False),
    ("EVM_OPERATOR_PRIVATE_KEY",  "EVM operator private key", "evm",       True),
    # ── World ID credential verification (server-side except app id) ────────
    ("WORLD_APP_ID",              "World App ID",              "worldid",   False),
    ("WORLD_RP_ID",               "World RP ID",               "worldid",   False),
    ("WORLD_RP_SIGNING_KEY",      "World RP signing key",      "worldid",   True),
    ("WORLD_ACTION",              "Selfie action",             "worldid",   False),
    ("WORLD_IDENTITY_ACTION",     "Identity action",           "worldid",   False),
    # ── Subgraph MCP (The Graph) — read config.yaml's mcp_servers.subgraph_read /
    # mcp_servers.subgraph_write ── SUBGRAPH_URL is the stable ".../version/latest"
    # Studio query URL (see the TS servers' docstrings); GRAPH_DEPLOY_KEY authorizes
    # subgraph_write's deploy tools only (see write_config_yaml).
    ("SUBGRAPH_URL",             "Subgraph query URL",       "subgraph",  False),
    ("GRAPH_DEPLOY_KEY",         "Graph deploy key",         "subgraph",  True),
    ("GRAPH_SUBGRAPH_NAME",      "Subgraph name",            "subgraph",  False),
    # ── Defaults for the next token — parameters (mirror createTokenSchema) ─
    ("TOKEN_NAME",               "Token name",               "token",     False),
    ("TOKEN_SYMBOL",             "Token symbol",             "token",     False),
    ("TOKEN_TYPE",               "Token type",               "token",     False),
    ("TOKEN_DECIMALS",           "Decimals",                 "token",     False),
    ("TOKEN_INITIAL_SUPPLY",     "Initial supply",           "token",     False),
    ("TOKEN_SUPPLY_TYPE",        "Supply type",              "token",     False),
    ("TOKEN_MAX_SUPPLY",         "Max supply",               "token",     False),
    ("TOKEN_ASSET_CATEGORY",     "Asset category",           "token",     False),
    ("TOKEN_MEMO",               "Memo",                     "token",     False),
    # ── Defaults for the next token — compliance (mirror complianceSchema) ─
    ("COMPLIANCE_KYC_REQUIRED",            "KYC required",           "token", False),
    ("COMPLIANCE_FREEZE_DEFAULT",          "Freeze by default",      "token", False),
    ("COMPLIANCE_WIPE_ENABLED",            "Wipe / clawback",        "token", False),
    ("COMPLIANCE_PAUSE_ENABLED",           "Pausable",               "token", False),
    ("COMPLIANCE_WORLDID_REQUIRED",        "World ID required",      "token", False),
    ("COMPLIANCE_WORLDID_SELFIE_CHECK",     "Selfie Check",           "token", False),
    ("COMPLIANCE_WORLDID_IDENTITY_CHECK",   "Identity Check",         "token", False),
    ("COMPLIANCE_WORLDID_AGE_ENABLED",       "Age condition",          "token", False),
    ("COMPLIANCE_WORLDID_MINIMUM_AGE",      "Minimum age",            "token", False),
    ("COMPLIANCE_WORLDID_NATIONALITY_ENABLED","Nationality condition", "token", False),
    ("COMPLIANCE_WORLDID_NATIONALITY",      "Required nationality",   "token", False),
    ("COMPLIANCE_LIVENESS_ENABLED",        "Liveness re-check",      "token", False),
    ("COMPLIANCE_LIVENESS_PERIOD_SECONDS", "Liveness period (s)",    "token", False),
    ("OPENAI_API_KEY",           "OpenAI API",              "provider",  True),
    ("OPENROUTER_API_KEY",       "OpenRouter",               "provider",  True),
    ("DEEPSEEK_API_KEY",         "DeepSeek",                 "provider",  True),
    ("DASHSCOPE_API_KEY",        "Qwen Cloud (DashScope)",   "provider",  True),
    ("GLM_API_KEY",              "GLM / Z.AI",               "provider",  True),
    ("KIMI_API_KEY",             "Kimi",                     "provider",  True),
    ("MINIMAX_API_KEY",          "MiniMax",                  "provider",  True),
    ("HF_TOKEN",                 "Hugging Face",             "provider",  True),
    # Added in v2026.4.23+ (hermes v0.11.0+). All plain API-key auth — hermes
    # auto-routes by env-var presence, no extra config needed on our side.
    # OAuth-based providers (xAI Grok SuperGrok, Gemini CLI, Qwen OAuth, Claude Code)
    # are set up via the dashboard's Keys tab or HERMES_AUTH_JSON_BOOTSTRAP.
    ("NVIDIA_API_KEY",           "NVIDIA NIM",               "provider",  True),
    ("ARCEEAI_API_KEY",          "Arcee AI",                 "provider",  True),
    ("STEPFUN_API_KEY",          "Step Plan",                "provider",  True),
    ("GEMINI_API_KEY",           "Google AI Studio",         "provider",  True),
    ("NOVITA_API_KEY",           "NovitaAI",                 "provider",  True),
    ("FIREWORKS_API_KEY",        "Fireworks AI",             "provider",  True),
    ("ANTHROPIC_API_KEY",        "Anthropic (Claude)",       "provider",  True),
    ("XAI_API_KEY",              "xAI",                      "provider",  True),
    ("AWS_ACCESS_KEY_ID",        "AWS Access Key ID",        "provider",  True),
    ("AWS_SECRET_ACCESS_KEY",    "AWS Secret Access Key",    "bedrock",   True),
    ("AWS_DEFAULT_REGION",       "AWS Region",               "bedrock",   False),
    ("COPILOT_GITHUB_TOKEN",     "GitHub Copilot",           "provider",  True),
    ("GMI_API_KEY",              "GMI Cloud",                "provider",  True),
    ("OPENCODE_ZEN_API_KEY",     "OpenCode Zen",             "provider",  True),
    ("OPENCODE_GO_API_KEY",      "OpenCode Go",              "provider",  True),
    ("KILOCODE_API_KEY",         "Kilo Code",                "provider",  True),
    ("OLLAMA_API_KEY",           "Ollama Cloud",             "provider",  True),
    ("AZURE_FOUNDRY_API_KEY",    "Azure Foundry key",        "provider",  True),
    ("AZURE_FOUNDRY_BASE_URL",   "Azure Foundry URL",        "azure",     False),
    # Custom OpenAI-compatible endpoint — one slot; more via Hermes dashboard.
    # Only the API key is in category "provider" so PROVIDER_KEYS / is_config_complete
    # only trigger when an actual key is present, not just a base URL.
    ("CUSTOM_PROVIDER_API_KEY",  "Custom Provider key",      "provider",  True),
    ("CUSTOM_PROVIDER_BASE_URL", "Custom Provider base URL", "custom",    False),
    ("CUSTOM_PROVIDER_NAME",     "Custom Provider name",     "custom",    False),
    ("PARALLEL_API_KEY",         "Parallel (search)",        "tool",      True),
    ("FIRECRAWL_API_KEY",        "Firecrawl (scrape)",       "tool",      True),
    ("TAVILY_API_KEY",           "Tavily (search)",          "tool",      True),
    ("FAL_KEY",                  "FAL (image gen)",          "tool",      True),
    ("BROWSERBASE_API_KEY",      "Browserbase key",          "tool",      True),
    ("BROWSERBASE_PROJECT_ID",   "Browserbase project",      "tool",      False),
    ("GITHUB_TOKEN",             "GitHub token",             "tool",      True),
    ("VOICE_TOOLS_OPENAI_KEY",   "OpenAI (voice/TTS)",       "tool",      True),
    ("HONCHO_API_KEY",           "Honcho (memory)",          "tool",      True),
    ("TELEGRAM_BOT_TOKEN",       "Bot Token",                "telegram",  True),
    ("TELEGRAM_ALLOWED_USERS",   "Allowed User IDs",         "telegram",  False),
    ("DISCORD_BOT_TOKEN",        "Bot Token",                "discord",   True),
    ("DISCORD_ALLOWED_USERS",    "Allowed User IDs",         "discord",   False),
    ("SLACK_BOT_TOKEN",          "Bot Token (xoxb-...)",     "slack",     True),
    ("SLACK_APP_TOKEN",          "App Token (xapp-...)",     "slack",     True),
    ("WHATSAPP_ENABLED",         "Enable WhatsApp",          "whatsapp",  False),
    ("EMAIL_ADDRESS",            "Email Address",            "email",     False),
    ("EMAIL_PASSWORD",           "Email Password",           "email",     True),
    ("EMAIL_IMAP_HOST",          "IMAP Host",                "email",     False),
    ("EMAIL_SMTP_HOST",          "SMTP Host",                "email",     False),
    ("MATTERMOST_URL",           "Server URL",               "mattermost",False),
    ("MATTERMOST_TOKEN",         "Bot Token",                "mattermost",True),
    ("MATRIX_HOMESERVER",        "Homeserver URL",           "matrix",    False),
    ("MATRIX_ACCESS_TOKEN",      "Access Token",             "matrix",    True),
    ("MATRIX_USER_ID",           "User ID",                  "matrix",    False),
    ("GATEWAY_ALLOW_ALL_USERS",  "Allow all users",          "gateway",   False),
    ("ADMIN_USERNAME",           "Admin username",           "admin",     False),
    ("ADMIN_PASSWORD",           "Admin password",           "admin",     True),
]

SECRET_KEYS  = {k for k, _, _, s in ENV_VARS if s}
PROVIDER_KEYS = [k for k, _, c, _ in ENV_VARS if c == "provider"]

# Env keys the locked-down `pr` profile is allowed to inherit — LLM
# model/provider credentials only. Deliberately excludes every chain/compliance
# category ("hedera", "evm", "worldid", "subgraph", "token"), every messaging
# platform, "gateway" (GATEWAY_ALLOW_ALL_USERS), "admin" (ADMIN_PASSWORD), and
# "tool" (web/browser/search keys for toolsets the pr profile has disabled
# anyway) — see build_pr_env(). A category being harmless today is not a
# reason to include it: the pr profile should only ever see what it needs.
PR_SAFE_ENV_CATEGORIES = {"model", "provider", "bedrock", "azure", "custom"}
PR_SAFE_ENV_KEYS = {k for k, _, c, _ in ENV_VARS if c in PR_SAFE_ENV_CATEGORIES}

# Baseline OS-level env vars any subprocess needs to actually function — PATH
# so `execvp("hermes", ...)` can even locate the binary (build_pr_env() builds
# its dict from scratch rather than inheriting os.environ, so without this the
# spawn fails outright with a bare FileNotFoundError, no filename shown, easy
# to mistake for a missing profile/config problem), plus a few other locale/
# home basics. None of these are secrets.
PR_BASE_ENV_KEYS = ("PATH", "HOME", "LANG", "LC_ALL", "TERM", "TMPDIR", "TZ")

WORLD_ID_NATIONALITIES = {
    "ARG", "AUS", "CHL", "COL", "CRI", "GBR", "HRV", "ITA",
    "JPN", "KOR", "MEX", "MYS", "PAN", "PRT", "SGP", "USA",
}

# Maps our own provider-key env var to hermes' OWN canonical provider id
# (hermes_cli/auth.py PROVIDER_REGISTRY, verified against v2026.7.1). Used by
# set_active_model_via_hermes() to pin an explicit model.provider via hermes'
# own POST /api/model/set instead of leaving config.yaml on "auto" once 2+
# provider keys exist in .env — see write_config_yaml()'s docstring for why
# "auto" alone is unsafe with multiple providers configured. Several ids are
# non-obvious renames upstream (dashscope->alibaba, glm->zai, kimi->kimi-coding,
# hf->huggingface, ollama->ollama-cloud) — re-verify every entry against
# hermes_cli/auth.py on a Hermes version bump (same audit as the WS allowlist).
HERMES_PROVIDER_IDS = {
    "OPENAI_API_KEY":        "openai-api",
    "OPENROUTER_API_KEY":    "openrouter",
    "DEEPSEEK_API_KEY":      "deepseek",
    "DASHSCOPE_API_KEY":     "alibaba",       # "Qwen Cloud" in hermes' own UI
    "GLM_API_KEY":           "zai",           # "Z.AI / GLM"
    "KIMI_API_KEY":          "kimi-coding",
    "MINIMAX_API_KEY":       "minimax",
    "HF_TOKEN":              "huggingface",
    "NVIDIA_API_KEY":        "nvidia",
    "ARCEEAI_API_KEY":       "arcee",
    "STEPFUN_API_KEY":       "stepfun",
    "GEMINI_API_KEY":        "gemini",
    "ANTHROPIC_API_KEY":     "anthropic",
    "XAI_API_KEY":           "xai",
    "AWS_ACCESS_KEY_ID":     "bedrock",
    "COPILOT_GITHUB_TOKEN":  "copilot",
    "GMI_API_KEY":           "gmi",
    "OPENCODE_ZEN_API_KEY":  "opencode-zen",
    "OPENCODE_GO_API_KEY":   "opencode-go",
    "KILOCODE_API_KEY":      "kilocode",
    "OLLAMA_API_KEY":        "ollama-cloud",
    "AZURE_FOUNDRY_API_KEY": "azure-foundry",
    # These three are NOT in hermes' own PROVIDER_REGISTRY — verified against
    # BOTH hermes_cli/auth.py (resolve_provider(), used by the CLI/"auto"
    # env-var auto-detect loop) AND hermes_cli/runtime_provider.py
    # (resolve_runtime_provider(), what the gateway/embedded Chat tab actually
    # call at agent-init) at v2026.7.1. Neither ever discovers them: "auto"
    # only scans PROVIDER_REGISTRY's known env vars (these aren't in it, so
    # they're invisible to it, full stop), and pinning one of these strings
    # as an explicit provider id raises "Unknown provider '<id>'" — both
    # produce a dead agent ("No inference provider configured" / "Unknown
    # provider"), confirmed live for a 9Router custom-endpoint deployment.
    # The only way any of them work is the same mechanism hermes' OWN
    # dashboard uses for a self-hosted/aggregator endpoint: provider="custom"
    # plus an explicit base_url + api_key written onto model.* directly
    # (hermes_cli/runtime_provider.py's bare-"custom" trust path reads
    # model.base_url/model.api_key from the model block — it does NOT consult
    # config.yaml's custom_providers[] list for this, that list is display/
    # bookkeeping only). See CUSTOM_STYLE_BASE_URLS and
    # set_active_model_via_hermes(). Re-verify FIREWORKS_API_KEY/NOVITA_API_KEY
    # base URLs against those providers' own docs (not hermes') if they ever
    # change their API surface.
    "CUSTOM_PROVIDER_API_KEY": "custom",   # base_url is user-supplied (CUSTOM_PROVIDER_BASE_URL) — any OpenAI-compatible endpoint, e.g. 9Router
    "FIREWORKS_API_KEY":       "custom",
    "NOVITA_API_KEY":          "custom",
}

# Fixed base URLs for the "custom"-style providers above whose credential is a
# plain API key against a well-known OpenAI-compatible endpoint. Absent here
# (CUSTOM_PROVIDER_API_KEY) means the base_url is user-supplied instead — see
# CUSTOM_PROVIDER_BASE_URL.
CUSTOM_STYLE_BASE_URLS = {
    "FIREWORKS_API_KEY": "https://api.fireworks.ai/inference/v1",
    "NOVITA_API_KEY":    "https://api.novita.ai/openai/v1",
}

# Every ENV_VARS "provider" key pinned to the literal "custom" id above.
# Computed, not hand-maintained, so a future provider added to
# HERMES_PROVIDER_IDS with value "custom" is automatically covered by both
# api_config_put()'s pin call and write_config_yaml()'s fallback below —
# no other code needs to change.
HERMES_CUSTOM_STYLE_KEYS = {k for k, v in HERMES_PROVIDER_IDS.items() if v == "custom"}

CHANNEL_MAP  = {
    "Telegram":    "TELEGRAM_BOT_TOKEN",
    "Discord":     "DISCORD_BOT_TOKEN",
    "Slack":       "SLACK_BOT_TOKEN",
    "WhatsApp":    "WHATSAPP_ENABLED",
    "Email":       "EMAIL_ADDRESS",
    "Mattermost":  "MATTERMOST_TOKEN",
    "Matrix":      "MATRIX_ACCESS_TOKEN",
}


# ── .env helpers ──────────────────────────────────────────────────────────────
def read_env(path: Path) -> dict[str, str]:
    if not path.exists():
        return {}
    out = {}
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        v = v.strip()
        if len(v) >= 2 and v[0] == v[-1] and v[0] in ('"', "'"):
            v = v[1:-1]
        out[k.strip()] = v
    return out


def validate_world_id_policy(data: dict[str, str]) -> None:
    """Reject World ID combinations the Setup UI cannot represent safely."""
    enabled = data.get("COMPLIANCE_WORLDID_REQUIRED", "").lower() == "true"
    selfie = data.get("COMPLIANCE_WORLDID_SELFIE_CHECK", "").lower() == "true"
    identity = data.get("COMPLIANCE_WORLDID_IDENTITY_CHECK", "").lower() == "true"
    age_enabled = data.get("COMPLIANCE_WORLDID_AGE_ENABLED", "").lower() == "true"
    nationality_enabled = (
        data.get("COMPLIANCE_WORLDID_NATIONALITY_ENABLED", "").lower() == "true"
    )
    minimum_age = data.get("COMPLIANCE_WORLDID_MINIMUM_AGE", "").strip()
    nationality = data.get("COMPLIANCE_WORLDID_NATIONALITY", "").strip().upper()
    liveness_enabled = (
        data.get("COMPLIANCE_LIVENESS_ENABLED", "").lower() == "true"
    )
    liveness_period = data.get(
        "COMPLIANCE_LIVENESS_PERIOD_SECONDS", ""
    ).strip()

    if liveness_enabled and (not enabled or not selfie):
        raise ValueError("Recurring liveness requires World ID Selfie Check.")
    if liveness_enabled:
        if not liveness_period:
            raise ValueError("Enter a recurring Selfie Check period in seconds.")
        try:
            period_seconds = int(liveness_period)
        except ValueError as exc:
            raise ValueError(
                "The recurring Selfie Check period must be a whole number."
            ) from exc
        if period_seconds < 60:
            raise ValueError(
                "The recurring Selfie Check period must be at least 60 seconds."
            )

    if enabled and not selfie and not identity:
        raise ValueError("World ID requires Selfie Check and/or Identity Check.")

    identity_enabled = enabled and identity
    if identity_enabled and not age_enabled and not nationality_enabled:
        raise ValueError(
            "Identity Check requires at least one optional condition."
        )

    if identity_enabled and age_enabled:
        if not minimum_age:
            raise ValueError("Enter a minimum age or disable the age condition.")
        try:
            age = int(minimum_age)
        except ValueError as exc:
            raise ValueError("World ID minimum age must be a whole number.") from exc
        if not 1 <= age <= 120:
            raise ValueError("World ID minimum age must be between 1 and 120.")

    if identity_enabled and nationality_enabled:
        if not nationality:
            raise ValueError(
                "Choose a nationality or disable the nationality condition."
            )
        if nationality not in WORLD_ID_NATIONALITIES:
            raise ValueError(
                f"Unsupported World ID nationality code: {nationality}."
            )
        data["COMPLIANCE_WORLDID_NATIONALITY"] = nationality


def write_config_yaml(data: dict[str, str], *, reset_model: bool = False) -> None:
    """Write config.yaml — deep-merge template defaults with any existing user/cron-managed sections.

    Previously this overwrote ``$HERMES_HOME/config.yaml`` with a hardcoded template
    body on every boot, silently erasing user-managed top-level keys. The most
    common casualty is ``mcp_servers`` — Hermes reads downstream MCP servers
    *only* from this file (see ``hermes_cli/mcp_config.py:_get_mcp_servers``), so
    the wipe broke ``hermes mcp add/test/list`` state across every container
    restart and required hand-restoration after each redeploy.

    The fix: load the existing file if any, apply the deployment-managed keys
    (``model.default``, ``model.provider``, ``terminal``, ``agent``, ``data_dir``)
    on top, and write the merged result. Unknown top-level keys (``mcp_servers``,
    custom skill config, etc.) are preserved verbatim.
    """
    import yaml  # hermes-agent already pulls pyyaml; deferred import keeps cold start light

    model = data.get("LLM_MODEL", "")
    config_path = Path(HERMES_HOME) / "config.yaml"
    config_path.parent.mkdir(parents=True, exist_ok=True)

    existing: dict = {}
    if config_path.exists():
        try:
            with config_path.open() as f:
                loaded = yaml.safe_load(f)
            if isinstance(loaded, dict):
                existing = loaded
        except (yaml.YAMLError, OSError):
            # Treat unparseable as absent — we'll overwrite with template defaults.
            existing = {}

    merged = dict(existing)

    # Deployment-managed (always authoritative — these reflect the runtime env).
    if reset_model:
        # Config reset: wipe the model block to a clean slate. Preserving the old
        # provider/base_url here would leave stale routing behind (e.g. a lingering
        # `base_url: https://openrouter.ai/api/v1` that misroutes the next provider
        # the user configures). Everything else — hermes tuning defaults,
        # mcp_servers — is still deep-merged through untouched below.
        merged_model = {"default": ""}
    else:
        merged_model = dict(merged.get("model") if isinstance(merged.get("model"), dict) else {})
        # A model chosen in Hermes' native dashboard lives in config.yaml, not
        # necessarily in our setup wrapper's LLM_MODEL env var. Preserve it on
        # boot; only overwrite it when our own UI supplied a non-empty model.
        if model:
            merged_model["default"] = model
        else:
            merged_model.setdefault("default", "")
        current_provider = str(merged_model.get("provider") or "").strip()
        # Only default to "auto" on a config that has never had a provider
        # pinned. Once a provider is set explicitly — either by
        # set_active_model_via_hermes() below (which delegates to hermes' own
        # POST /api/model/set) or by hermes' own dashboard — PRESERVE it here.
        # This function runs on every gateway start (Gateway.start() calls it
        # fresh from .env every time a subprocess spawns), so unconditionally
        # forcing "auto" whenever any key is present — the old behavior —
        # would silently revert an explicit pin back to ambiguous "auto" on
        # the very next restart. "auto" resolves by scanning hermes' own
        # PROVIDER_REGISTRY in its OWN dict-insertion order and returning the
        # first provider with a present env var — independent of which model
        # string is configured. With exactly one provider key present this is
        # harmless (only one possible match), but with two or more configured
        # (e.g. minimax + nvidia) it silently pairs whichever provider sorts
        # first in that registry with a model string that may belong to a
        # DIFFERENT provider — the exact bug that made hermes route a
        # deepseek-v4-pro (NVIDIA) request through MiniMax's own API with an
        # unrecognized model name, producing a self-contradictory system
        # prompt and a "confused" identity response.
        if not current_provider:
            named_key = next(
                (k for k in PROVIDER_KEYS if k not in HERMES_CUSTOM_STYLE_KEYS and data.get(k)),
                None,
            )
            custom_style_key = next((k for k in HERMES_CUSTOM_STYLE_KEYS if data.get(k)), None)
            if named_key:
                merged_model["provider"] = "auto"
                current_provider = "auto"
            elif custom_style_key:
                # CUSTOM_PROVIDER_API_KEY / FIREWORKS_API_KEY / NOVITA_API_KEY are
                # NOT in hermes' own PROVIDER_REGISTRY (see HERMES_PROVIDER_IDS'
                # comment) — "auto" can never discover them, so defaulting to
                # "auto" here (the old behavior) left the agent with no usable
                # provider whenever one of these was the ONLY key configured.
                # This is the synchronous safety net for the async
                # set_active_model_via_hermes() pin in api_config_put(): this
                # function also runs directly from .env on every gateway boot
                # (Gateway.start()), so it must independently produce a
                # resolvable config even if that pin call never ran or failed.
                merged_model["provider"] = "custom"
                merged_model["base_url"] = (
                    CUSTOM_STYLE_BASE_URLS.get(custom_style_key)
                    or data.get("CUSTOM_PROVIDER_BASE_URL", "").strip()
                )
                merged_model["api_key"] = data.get(custom_style_key, "").strip()
                current_provider = "custom"
        # A known built-in provider (openrouter, minimax, nvidia, …) resolves
        # its endpoint + credentials from the provider itself, so any inline
        # model.base_url/api_key/api_mode is stale. base_url "takes precedence
        # over provider" upstream (hermes_cli/config.py), so a leftover — e.g.
        # a former `base_url: https://openrouter.ai/api/v1` from the hermes
        # dashboard — silently misroutes EVERY provider you later switch to
        # (all calls forced to that endpoint regardless of the active model).
        # Strip them here, mirroring hermes' own clear_model_endpoint_credentials()
        # on a switch-away-from-custom. Skipped only for "custom"/"local" —
        # hermes' own convention for a user-supplied (or fixed-URL aggregator)
        # endpoint that legitimately needs its own base_url/api_key set
        # directly on model.* (see the "custom_style_key" branch above —
        # hermes' runtime resolver reads model.base_url/api_key directly, NOT
        # the separate custom_providers[] block below, which is display-only).
        if current_provider and current_provider.lower() not in ("custom", "local"):
            for _stale in ("base_url", "api_key", "api", "api_mode"):
                merged_model.pop(_stale, None)
    merged["model"] = merged_model

    merged_terminal = dict(merged.get("terminal") if isinstance(merged.get("terminal"), dict) else {})
    merged_terminal["backend"] = "local"
    merged_terminal["timeout"] = 60
    merged_terminal["cwd"] = AGENT_WORKDIR
    merged["terminal"] = merged_terminal

    merged_agent = dict(merged.get("agent") if isinstance(merged.get("agent"), dict) else {})
    merged_agent.setdefault("max_iterations", 50)
    merged["agent"] = merged_agent

    merged["data_dir"] = HERMES_HOME

    # Seed/update only the deployment-managed parts of the chain and World ID MCP entries.
    # Other MCP servers and optional keys on these entries remain untouched.
    #
    # hedera and evm are each split into a read-only and a write (state-mutating) MCP
    # server (mcps/{hedera,evm}/{read_server,write_server}.py) so a read-only agent
    # profile (see the `pr` profile below) can be handed hedera_read/evm_read without
    # ever getting a code path to deploy/whitelist/distribute/reclaim/pause. Both
    # halves of a pair get the same TOKENIZATION_BASE_URL/AGENT_SECRET env — the
    # isolation is which MCP is registered at all, not the secret.
    mcp_servers = merged.get("mcp_servers")
    if not isinstance(mcp_servers, dict):
        mcp_servers = {}

    def _ensure_mcp_entry(key: str, command: str, args: list[str], env_updates: dict[str, str]) -> dict[str, Any]:
        entry = mcp_servers.get(key)
        if not isinstance(entry, dict):
            entry = {}
        entry.setdefault("command", command)
        entry.setdefault("args", args)
        env = entry.get("env")
        if not isinstance(env, dict):
            env = {}
        env.update(env_updates)
        entry["env"] = env
        mcp_servers[key] = entry
        return entry

    tokenization_env = {
        "TOKENIZATION_BASE_URL": TOKENIZATION_URL,
        "TOKENIZATION_AGENT_SECRET": TOKENIZATION_AGENT_SECRET,
    }
    _ensure_mcp_entry("hedera_read", "python", ["/app/mcps/hedera/read_server.py"], tokenization_env)
    _ensure_mcp_entry("hedera_write", "python", ["/app/mcps/hedera/write_server.py"], tokenization_env)
    _ensure_mcp_entry("evm_read", "python", ["/app/mcps/evm/read_server.py"], tokenization_env)
    _ensure_mcp_entry("evm_write", "python", ["/app/mcps/evm/write_server.py"], tokenization_env)
    _ensure_mcp_entry("worldid", "python", ["/app/worldid_mcp.py"], tokenization_env)
    _ensure_mcp_entry("usps_chainlink", "python", ["/app/mcps/usps_chainlink/server.py"], tokenization_env)
    _ensure_mcp_entry("superfluid", "python", ["/app/mcps/superfluid/server.py"], tokenization_env)

    # The subgraph MCP is the upstream TypeScript server, run as-is: Hermes launches
    # each half via tsx (baked into the image at /opt/subgraph-mcp/src/{read,write}.ts).
    # Unlike hedera/worldid it does NOT talk to the loopback Next.js app — it queries
    # Graph Studio directly (SUBGRAPH_URL) and, for the write half's deploy tools,
    # shells out to graph-cli in SUBGRAPH_DIR. SUBGRAPH_DIR is deployment-managed (the
    # writable, volume-backed copy start.sh seeds); the rest come from .env when set,
    # and we never wipe an operator's manually-set config.yaml value with an empty one.
    #
    # GRAPH_DEPLOY_KEY is intentionally only ever injected into subgraph_write's env —
    # subgraph_read's add_token_source/set_token_sources tools don't exist, so it has
    # no use for the key, and never receiving it is a second, independent guard beyond
    # "the tools aren't registered."
    tsx_bin = "/opt/subgraph-mcp/node_modules/.bin/tsx"
    # Fall back to os.environ so an operator who sets these directly as Railway env
    # vars (not via the setup wizard's .env) still has them injected into the MCP's
    # env block — unlike the loopback Next.js app, the MCP subprocess only gets what
    # hermes passes from config.yaml, so we can't rely on process-env passthrough alone.
    def _env_or_os(key: str) -> str:
        return (data.get(key) or os.environ.get(key, "")).strip()

    subgraph_common_env = {"SUBGRAPH_DIR": "/data/subgraph"}
    for _key in ("SUBGRAPH_URL", "SEPOLIA_RPC_URL"):
        _value = _env_or_os(_key)
        if _value:
            subgraph_common_env[_key] = _value
    _ensure_mcp_entry("subgraph_read", tsx_bin, ["/opt/subgraph-mcp/src/read.ts"], subgraph_common_env)

    subgraph_write_env = dict(subgraph_common_env)
    for _key in ("GRAPH_DEPLOY_KEY", "GRAPH_SUBGRAPH_NAME"):
        _value = _env_or_os(_key)
        if _value:
            subgraph_write_env[_key] = _value
    _ensure_mcp_entry("subgraph_write", tsx_bin, ["/opt/subgraph-mcp/src/write.ts"], subgraph_write_env)

    merged["mcp_servers"] = mcp_servers

    # The storefront POSTs a signed event here after committing a request to
    # SQLite. This route launches a real agent run; its narrow prompt contains
    # no user-authored instructions and directs Hermes through the idempotent
    # request tools rather than the unrestricted distribution tool.
    platforms = merged.get("platforms")
    if not isinstance(platforms, dict):
        platforms = {}
    webhook = platforms.get("webhook")
    if not isinstance(webhook, dict):
        webhook = {}
    webhook["enabled"] = True
    webhook_extra = webhook.get("extra")
    if not isinstance(webhook_extra, dict):
        webhook_extra = {}
    webhook_extra["host"] = "127.0.0.1"
    webhook_extra["port"] = 8644
    routes = webhook_extra.get("routes")
    if not isinstance(routes, dict):
        routes = {}
    routes["token-request"] = {
        "events": ["token_request"],
        "secret": TOKEN_REQUEST_WEBHOOK_SECRET,
        "prompt": (
            "A holder submitted stored token request #{request_id}. "
            "Read request_id={request_id} with get_token_request. A 0.0.x token id is Hedera "
            "and must use the hedera MCP; a 0x contract address is Sepolia and must use the evm "
            "MCP. Inspect the referenced token and holder using that same chain MCP's get_token. "
            "For a World ID-gated token, use the worldid MCP get_holder_verifications tool. "
            "For each configured check whose credential-specific holder timestamp is missing, "
            "call worldid verify_pending_proof with the newest PENDING or FAILED verification id, "
            "then re-read the live token and holder using the selected chain MCP's get_token. "
            "worldIdSelfieVerifiedAt is mandatory when Selfie Check is required; "
            "worldIdIdentityVerifiedAt is mandatory when age or nationality is required. "
            "Never accept the generic worldIdVerifiedAt alone and never ask for proof JSON in chat. "
            "If every configured World ID proof is present but the holder status is PENDING, "
            "you MUST call whitelist_holder for the request's token and account, re-read the "
            "live holder, then call fulfill_token_request with this request id. Do not treat "
            "PENDING status or an ungranted KYC flag as a failure when the required proofs are present. "
            "If the holder is already WHITELISTED and the other live conditions pass, call "
            "fulfill_token_request immediately. "
            "If a compliance condition definitively fails, call reject_token_request with a "
            "concise reason. For a transient API, network, model, Hedera, or Sepolia error, do not reject "
            "the request; report the error and preserve its server-managed state. Never call "
            "distribute for this workflow, "
            "never change the destination or amount, and do not merely describe what should happen."
        ),
        "deliver": "log",
    }
    routes["liveness-verification"] = {
        "events": ["liveness_verification"],
        "secret": TOKEN_REQUEST_WEBHOOK_SECRET,
        "prompt": (
            "Holder {account_id} submitted recurring Selfie verification #{verification_id} "
            "for token {token_id}. Use worldid MCP get_verification with this exact id, confirm "
            "that it is a PENDING or retryable FAILED selfie attempt for the stated token and "
            "holder, then call verify_pending_proof. The trusted backend will verify with World, "
            "refresh the liveness timestamp, cancel the prior reclaim schedule, and arm the next "
            "deadline. Re-read the holder with hedera get_token for a 0.0.x token or evm get_token "
            "for a 0x contract, and report the resulting liveness "
            "state. Never ask for raw proof JSON, never change any financial parameter, and do not "
            "send, distribute, whitelist, revoke, or reclaim a token in this workflow."
        ),
        "deliver": "log",
    }
    webhook_extra["routes"] = routes
    webhook["extra"] = webhook_extra
    platforms["webhook"] = webhook
    merged["platforms"] = platforms

    # Custom OpenAI-compatible endpoint — write custom_providers block when configured,
    # remove it when not (safe on Railway where users don't hand-edit config.yaml).
    custom_base_url = data.get("CUSTOM_PROVIDER_BASE_URL", "").strip()
    if custom_base_url:
        raw_name = data.get("CUSTOM_PROVIDER_NAME", "").strip() or custom_base_url
        # Sanitise to a valid hermes provider name (lowercase alphanumeric + hyphens).
        sanitized_name = re.sub(r"[^a-z0-9-]", "-", raw_name.lower()).strip("-") or "custom"
        merged["custom_providers"] = [{
            "name": sanitized_name,
            "base_url": custom_base_url,
            "key_env": "CUSTOM_PROVIDER_API_KEY",
        }]
    else:
        merged.pop("custom_providers", None)

    with config_path.open("w") as f:
        yaml.safe_dump(merged, f, sort_keys=False, default_flow_style=False)

    # Keep the locked-down `pr` profile's config in sync on every gateway start,
    # same as the operator config above. Reuses the model block we just resolved
    # (model choice isn't security-sensitive — sharing it just means the public
    # chat uses the same LLM the operator configured) but writes an entirely
    # separate mcp_servers/toolset story to its own profile directory.
    write_pr_config_yaml(dict(merged_model))
    # Also refresh its on-disk .env — see write_pr_env_file()'s docstring for
    # why this can't just live in build_pr_env()'s in-memory dict alone.
    write_pr_env_file()


# Toolsets that must never be reachable from the `pr` profile: terminal and
# file give a model a way to shell out to (or read/write) anything the OS user
# can touch — including `curl`-ing the tokenization app's write endpoints
# directly, bypassing the "only read MCPs are registered" guarantee entirely.
# The rest are "outbound-action" toolsets the pr agent has no legitimate use
# for (see the Hermes docs' own recommendation to disable terminal/file/
# outbound-action tools on any session that only needs to read and summarize).
PR_DISABLED_TOOLSETS = [
    "terminal", "file", "browser", "web", "code_execution",
    "delegation", "cronjob", "messaging", "discord", "discord_admin",
    "homeassistant", "spotify", "image_gen",
]


def write_pr_config_yaml(model_block: dict[str, Any]) -> None:
    """Write the `pr` profile's config.yaml — same deep-merge idiom as
    write_config_yaml (preserve unknown top-level keys / any operator-added
    mcp_servers entry), but a deliberately much smaller deployment-managed
    surface: only hedera_read/evm_read/subgraph_read are ever registered here
    — never worldid or any *_write server — and agent.disabled_toolsets is
    force-unioned (not merely setdefault) with PR_DISABLED_TOOLSETS on every
    write, so a stale or hand-edited config can't silently drop the guard.
    """
    import yaml  # deferred import, same rationale as write_config_yaml

    config_path = PR_HOME / "config.yaml"
    config_path.parent.mkdir(parents=True, exist_ok=True)
    Path(PR_WORKDIR).mkdir(parents=True, exist_ok=True)

    existing: dict = {}
    if config_path.exists():
        try:
            with config_path.open() as f:
                loaded = yaml.safe_load(f)
            if isinstance(loaded, dict):
                existing = loaded
        except (yaml.YAMLError, OSError):
            existing = {}

    merged = dict(existing)
    merged["model"] = dict(model_block)

    merged_terminal = dict(merged.get("terminal") if isinstance(merged.get("terminal"), dict) else {})
    merged_terminal["backend"] = "local"
    merged_terminal["timeout"] = 60
    merged_terminal["cwd"] = PR_WORKDIR
    merged["terminal"] = merged_terminal

    merged_agent = dict(merged.get("agent") if isinstance(merged.get("agent"), dict) else {})
    merged_agent.setdefault("max_iterations", 50)
    existing_disabled = merged_agent.get("disabled_toolsets")
    if not isinstance(existing_disabled, list):
        existing_disabled = []
    # Union, never subtract — this list only ever grows across restarts.
    merged_agent["disabled_toolsets"] = sorted(set(existing_disabled) | set(PR_DISABLED_TOOLSETS))
    merged["agent"] = merged_agent

    merged["data_dir"] = str(PR_HOME)

    mcp_servers = merged.get("mcp_servers")
    if not isinstance(mcp_servers, dict):
        mcp_servers = {}

    def _ensure_entry(key: str, command: str, args: list[str], env_updates: dict[str, str]) -> None:
        entry = mcp_servers.get(key)
        if not isinstance(entry, dict):
            entry = {}
        entry.setdefault("command", command)
        entry.setdefault("args", args)
        env = entry.get("env")
        if not isinstance(env, dict):
            env = {}
        env.update(env_updates)
        entry["env"] = env
        mcp_servers[key] = entry

    tokenization_env = {
        "TOKENIZATION_BASE_URL": TOKENIZATION_URL,
        # list_token_requests/get_token_request on hedera_read/evm_read hit the
        # same requireAgentRequest-guarded GET routes the write tools use — this
        # secret gates "is this an authenticated backend caller" for the whole
        # agent-only API surface, not read-vs-write, so hedera_read/evm_read
        # need it to function. It grants no capability beyond what the
        # registered tool FUNCTIONS below can call, and no *_write server is
        # ever registered here.
        "TOKENIZATION_AGENT_SECRET": TOKENIZATION_AGENT_SECRET,
    }
    _ensure_entry("hedera_read", "python", ["/app/mcps/hedera/read_server.py"], tokenization_env)
    _ensure_entry("evm_read", "python", ["/app/mcps/evm/read_server.py"], tokenization_env)

    # SUBGRAPH_URL/SEPOLIA_RPC_URL are public, non-secret values (a query
    # endpoint and a public RPC URL) — check the operator's .env same as
    # write_config_yaml does, falling back to os.environ for a Railway-set var.
    operator_env = read_env(ENV_FILE)
    subgraph_env = {"SUBGRAPH_DIR": "/data/subgraph"}
    for _key in ("SUBGRAPH_URL", "SEPOLIA_RPC_URL"):
        _value = (operator_env.get(_key) or os.environ.get(_key, "")).strip()
        if _value:
            subgraph_env[_key] = _value
    # Deliberately never given GRAPH_DEPLOY_KEY — subgraph_read has no tool that
    # could use it, and not receiving it is a second, independent guard beyond
    # "the deploy tools aren't registered".
    _ensure_entry(
        "subgraph_read",
        "/opt/subgraph-mcp/node_modules/.bin/tsx",
        ["/opt/subgraph-mcp/src/read.ts"],
        subgraph_env,
    )

    merged["mcp_servers"] = mcp_servers

    with config_path.open("w") as f:
        yaml.safe_dump(merged, f, sort_keys=False, default_flow_style=False)


def build_hermes_env() -> dict[str, str]:
    """Merge OS env + HERMES_HOME + .env file contents for a hermes subprocess.

    .env values take priority over Railway env vars. We build the env this way
    so hermes's own dotenv loading (which reads the same file) doesn't shadow
    our values. Shared by every hermes subprocess we spawn (gateway, dashboard)
    — a subprocess started without this (e.g. via a bare env=None, which just
    inherits our own process env from container boot) never sees provider keys
    saved later through the setup wizard, since those only ever land in
    HERMES_HOME/.env, not in our own os.environ.
    """
    env = {**os.environ, "HERMES_HOME": HERMES_HOME}
    env.update(read_env(ENV_FILE))
    return env


def build_pr_env() -> dict[str, str]:
    """Build the subprocess env for the locked-down `pr` profile's gateway.

    Deliberately NOT build_hermes_env() + overrides: that function merges the
    operator's ENTIRE $HERMES_HOME/.env, which holds HEDERA_OPERATOR_KEY,
    EVM_OPERATOR_PRIVATE_KEY, WORLD_RP_SIGNING_KEY, GRAPH_DEPLOY_KEY, etc. Since
    MCP stdio subprocesses commonly inherit their parent's env, blindly reusing
    that merge here would leak those secrets into the pr gateway's own process
    env even though no *_write MCP is ever registered for it — bad hygiene at
    best, a real exposure if a future edit ever mis-registers one.

    Instead: start from PR_BASE_ENV_KEYS (PATH and other non-secret OS
    plumbing a subprocess needs to run at all) plus a hard allowlist
    (PR_SAFE_ENV_KEYS — LLM model/provider credentials only, the one thing
    worth sharing with the operator profile so the pr agent uses the same
    configured model) pulled from BOTH the operator's .env and os.environ (a
    provider key may live in either depending on whether it was set via the
    setup wizard or a Railway var), then layer on this profile's own
    identity/api_server settings.
    """
    operator_env = read_env(ENV_FILE)
    env: dict[str, str] = {k: os.environ[k] for k in PR_BASE_ENV_KEYS if k in os.environ}
    for key in PR_SAFE_ENV_KEYS:
        value = operator_env.get(key) or os.environ.get(key, "")
        if value:
            env[key] = value

    # Point this subprocess's OWN home at the profile directory directly,
    # rather than the root HERMES_HOME + a `-p pr` CLI flag — confirmed live
    # that `-p pr` did not actually scope `hermes gateway run` to this
    # profile's home (see Gateway.start()'s comment on the `args` list).
    env["HERMES_HOME"] = str(PR_HOME)
    env["API_SERVER_ENABLED"] = "true"
    env["API_SERVER_HOST"] = PR_API_SERVER_HOST
    env["API_SERVER_PORT"] = str(PR_API_SERVER_PORT)
    env["API_SERVER_KEY"] = PR_API_SERVER_KEY
    env["API_SERVER_MODEL_NAME"] = "hermes-pr"
    return env


def write_pr_env_file() -> None:
    """Persist the same values build_pr_env() computes to $PR_HOME/.env on disk.

    build_pr_env() alone only covers subprocesses THIS supervisor spawns
    directly (its dict is passed via `env=` to asyncio.create_subprocess_exec).
    Hermes' own dashboard "Start" button (or a manual `hermes -p pr gateway
    start`) spawns its own process independently and resolves that profile's
    env via Hermes' own dotenv loading of `$HERMES_HOME/profiles/pr/.env` —
    without this file on disk, a dashboard-started `pr` gateway comes up with
    API_SERVER_ENABLED unset (default false), so it looks "running" in the
    dashboard but the platform's chat route can never reach it.
    """
    env = build_pr_env()
    # HERMES_HOME is this process's own root — writing it into a nested
    # profile's .env would be circular (and Hermes resolves the profile's
    # home from the CLI's own HERMES_HOME + "-p pr" already).
    lines = [f"{key}={value}" for key, value in sorted(env.items()) if key != "HERMES_HOME"]
    PR_HOME.mkdir(parents=True, exist_ok=True)
    (PR_HOME / ".env").write_text("\n".join(lines) + "\n")
    sync_pr_auth_json()


def sync_pr_auth_json() -> None:
    """Mirror $HERMES_HOME/auth.json into the pr profile's own home, if present.

    Some providers (e.g. openai-codex, xAI) authenticate via an OAuth session
    stored in auth.json rather than a plain env-var API key — PR_SAFE_ENV_KEYS
    only ever covers the latter. Without this, the pr profile's config.yaml
    can correctly say `provider: openai-codex` (just a string, copied fine)
    while having no actual session to use it with, so its gateway starts and
    immediately fails to authenticate — looking identical to the working
    profile in config, but dying right after start (which is what "Gateway
    stopped"/not auto-starting looks like from the dashboard).

    Trade-off worth knowing: this makes both gateways share ONE OAuth session.
    If that provider's account has any single-session enforcement, or rotates
    its refresh token on use, running both concurrently could occasionally
    invalidate one side. A plain API-key provider (ANTHROPIC_API_KEY,
    OPENAI_API_KEY, etc.) has no such issue and needs no file copy at all —
    consider that for the pr profile specifically if this becomes a problem.
    """
    source = Path(HERMES_HOME) / "auth.json"
    if not source.is_file():
        return
    dest = PR_HOME / "auth.json"
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(source.read_bytes())
    try:
        dest.chmod(0o600)
    except OSError:
        pass


def write_env(path: Path, data: dict[str, str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    cat_order = ["model", "provider", "hedera", "evm", "worldid", "subgraph", "token",
                 "bedrock", "azure", "custom", "tool",
                 "telegram", "discord", "slack", "whatsapp",
                 "email", "mattermost", "matrix", "gateway", "admin"]
    cat_labels = {
        "model": "Model", "provider": "Providers",
        "hedera": "Hedera operator", "evm": "Ethereum Sepolia", "worldid": "World ID",
        "subgraph": "Subgraph (The Graph)",
        "token": "Next token defaults",
        "bedrock": "AWS Bedrock", "azure": "Azure Foundry",
        "custom": "Custom Endpoint", "tool": "Tools",
        "telegram": "Telegram", "discord": "Discord", "slack": "Slack",
        "whatsapp": "WhatsApp", "email": "Email",
        "mattermost": "Mattermost", "matrix": "Matrix", "gateway": "Gateway",
        "admin": "Admin",
    }
    key_cat = {k: c for k, _, c, _ in ENV_VARS}
    grouped: dict[str, list[str]] = {c: [] for c in cat_order}
    grouped["other"] = []

    for k, v in data.items():
        if not v:
            continue
        cat = key_cat.get(k, "other")
        grouped.setdefault(cat, []).append(f"{k}={v}")

    lines: list[str] = []
    for cat in cat_order:
        entries = sorted(grouped.get(cat, []))
        if entries:
            lines.append(f"# {cat_labels.get(cat, cat)}")
            lines.extend(entries)
            lines.append("")
    if grouped["other"]:
        lines.append("# Other")
        lines.extend(sorted(grouped["other"]))
        lines.append("")

    path.write_text("\n".join(lines))


# ── xAI Grok SuperGrok OAuth (Device Code — RFC 8628) ───────────────────────
# xAI's OIDC discovery at https://auth.x.ai/.well-known/openid-configuration
# declares device_authorization_endpoint, so Device Code flow works without
# any redirect URL. The client_id matches hermes's own Grok CLI credential.
_XAI_CLIENT_ID   = "b1a00492-073a-47ea-816f-4c329264a828"
_XAI_SCOPE       = "openid profile email offline_access grok-cli:access api:access"
_XAI_DEVICE_URL  = "https://auth.x.ai/oauth2/device/code"
_XAI_TOKEN_URL   = "https://auth.x.ai/oauth2/token"
_XAI_GRANT_TYPE  = "urn:ietf:params:oauth:grant-type:device_code"

_xai_oauth_state: dict | None = None  # one auth at a time (single-user deployment)


def _has_xai_oauth_tokens() -> bool:
    """True when auth.json contains a valid xAI OAuth refresh token."""
    auth_path = Path(HERMES_HOME) / "auth.json"
    if not auth_path.exists():
        return False
    try:
        data = json.loads(auth_path.read_text())
        tokens = data.get("providers", {}).get("xai-oauth", {}).get("tokens", {})
        return bool(isinstance(tokens, dict) and tokens.get("refresh_token"))
    except Exception:
        return False


def _save_xai_auth_json(tokens: dict) -> None:
    """Write xAI OAuth tokens to auth.json in hermes's expected format."""
    auth_path = Path(HERMES_HOME) / "auth.json"
    existing: dict = {}
    if auth_path.exists():
        try:
            existing = json.loads(auth_path.read_text())
        except Exception:
            pass
    if not isinstance(existing, dict):
        existing = {}

    providers = existing.setdefault("providers", {})
    providers["xai-oauth"] = {
        "tokens": tokens,
        "auth_mode": "oauth_device",
        "last_refresh": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "discovery": {
            "authorization_endpoint": "https://auth.x.ai/oauth2/authorize",
            "token_endpoint": _XAI_TOKEN_URL,
        },
        "redirect_uri": "",
    }
    existing["active_provider"] = "xai-oauth"
    existing["version"] = 2
    existing["updated_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

    auth_path.write_text(json.dumps(existing, indent=2) + "\n")
    try:
        auth_path.chmod(0o600)
    except Exception:
        pass


def _apply_xai_oauth_config(model: str) -> None:
    """Write config.yaml with provider=xai-oauth and the chosen model."""
    import yaml
    config_path = Path(HERMES_HOME) / "config.yaml"
    config_path.parent.mkdir(parents=True, exist_ok=True)
    existing: dict = {}
    if config_path.exists():
        try:
            with config_path.open() as f:
                loaded = yaml.safe_load(f)
            if isinstance(loaded, dict):
                existing = loaded
        except Exception:
            pass

    merged = dict(existing)
    merged_model = dict(merged.get("model") if isinstance(merged.get("model"), dict) else {})
    if model:
        merged_model["default"] = model
    merged_model["provider"] = "xai-oauth"
    merged["model"] = merged_model

    merged_terminal = dict(merged.get("terminal") if isinstance(merged.get("terminal"), dict) else {})
    merged_terminal.setdefault("backend", "local")
    merged_terminal.setdefault("timeout", 60)
    merged_terminal.setdefault("cwd", AGENT_WORKDIR)
    merged["terminal"] = merged_terminal

    merged_agent = dict(merged.get("agent") if isinstance(merged.get("agent"), dict) else {})
    merged_agent.setdefault("max_iterations", 50)
    merged["agent"] = merged_agent
    merged["data_dir"] = HERMES_HOME

    with config_path.open("w") as f:
        yaml.safe_dump(merged, f, sort_keys=False, default_flow_style=False)

    # Persist LLM_MODEL and track the per-provider model so the setup UI can
    # display it alongside the xAI entry in the "Configured Providers" list.
    if model:
        existing_env = read_env(ENV_FILE)
        existing_env["LLM_MODEL"] = model
        existing_env["_MODEL_XAI_OAUTH"] = model
        write_env(ENV_FILE, existing_env)


async def _poll_xai_device_auth(state: dict) -> None:
    """Background task: poll xAI token endpoint until authorized or expired."""
    client = get_http_client()
    while time.time() < state["expires_at"]:
        await asyncio.sleep(state["interval"])
        try:
            resp = await client.post(
                _XAI_TOKEN_URL,
                data={
                    "grant_type": _XAI_GRANT_TYPE,
                    "device_code": state["device_code"],
                    "client_id": _XAI_CLIENT_ID,
                },
                headers={"Content-Type": "application/x-www-form-urlencoded"},
                timeout=httpx.Timeout(15.0),
            )
        except Exception as e:
            print(f"[xai-oauth] poll error: {e!r}", flush=True)
            continue

        if resp.status_code == 200:
            try:
                tokens = resp.json()
            except Exception:
                state["status"] = "error"
                state["error"] = "Invalid token response from xAI"
                return
            _save_xai_auth_json(tokens)
            _apply_xai_oauth_config(state.get("model", ""))
            state["status"] = "authorized"
            print("[xai-oauth] authorized — restarting gateway", flush=True)
            asyncio.create_task(gw.restart())
            return

        try:
            err_data = resp.json()
        except Exception:
            err_data = {}
        error = err_data.get("error", "")

        if error == "authorization_pending":
            continue
        elif error == "slow_down":
            state["interval"] = min(state["interval"] + 5, 30)
        else:
            state["status"] = "error"
            state["error"] = err_data.get("error_description", error) or error or "Unknown error"
            print(f"[xai-oauth] failed: {error}", flush=True)
            return

    state["status"] = "expired"
    print("[xai-oauth] device code expired", flush=True)


async def api_oauth_xai_delete(request: Request) -> Response:
    global _xai_oauth_state
    if err := guard(request):
        return err
    auth_path = Path(HERMES_HOME) / "auth.json"
    if auth_path.exists():
        try:
            data = json.loads(auth_path.read_text(encoding="utf-8"))
            data.get("providers", {}).pop("xai-oauth", None)
            if data.get("active_provider") == "xai-oauth":
                data.pop("active_provider", None)
            auth_path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
        except Exception:
            pass
    env = read_env(ENV_FILE)
    env.pop("_MODEL_XAI_OAUTH", None)
    write_env(ENV_FILE, env)
    _xai_oauth_state = None
    return JSONResponse({"ok": True})


async def api_oauth_xai_start(request: Request) -> Response:
    global _xai_oauth_state
    if err := guard(request):
        return err

    try:
        body = await request.json()
    except Exception:
        body = {}
    model = str(body.get("model", "")).strip()

    client = get_http_client()
    try:
        resp = await client.post(
            _XAI_DEVICE_URL,
            data={"client_id": _XAI_CLIENT_ID, "scope": _XAI_SCOPE},
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            timeout=httpx.Timeout(15.0),
        )
    except Exception as e:
        return JSONResponse({"error": f"Could not reach xAI: {e}"}, status_code=502)

    if resp.status_code != 200:
        return JSONResponse(
            {"error": f"xAI returned {resp.status_code}: {resp.text[:200]}"},
            status_code=502,
        )

    try:
        data = resp.json()
    except Exception:
        return JSONResponse({"error": "Invalid response from xAI"}, status_code=502)

    _xai_oauth_state = {
        "device_code": data["device_code"],
        "user_code": data["user_code"],
        "verification_uri": data.get("verification_uri_complete") or data["verification_uri"],
        "expires_at": time.time() + data.get("expires_in", 900),
        "interval": max(data.get("interval", 5), 5),
        "status": "pending",
        "model": model,
    }
    asyncio.create_task(_poll_xai_device_auth(_xai_oauth_state))

    return JSONResponse({
        "user_code": data["user_code"],
        "verification_uri": _xai_oauth_state["verification_uri"],
        "expires_in": data.get("expires_in", 900),
    })


async def api_oauth_xai_status(request: Request) -> Response:
    if err := guard(request):
        return err
    if _xai_oauth_state is None:
        # No active flow — check if a previous session left valid tokens.
        if _has_xai_oauth_tokens():
            return JSONResponse({"status": "authorized"})
        return JSONResponse({"status": "none"})
    return JSONResponse({
        "status": _xai_oauth_state["status"],
        "error": _xai_oauth_state.get("error", ""),
    })


def is_config_complete(data: dict[str, str] | None = None) -> bool:
    """Single source of truth for 'ready to run the gateway'.

    Used by: GET / redirect, auto_start on boot, admin API status.
    """
    if data is None:
        data = read_env(ENV_FILE)
    has_model = bool(data.get("LLM_MODEL"))
    configured_provider = ""
    if not has_model:
        # Hermes' native Models page persists its choice directly to
        # config.yaml. Recognise that state so a deployment configured there
        # still auto-starts the gateway and its webhook adapter.
        try:
            import yaml
            config_path = Path(HERMES_HOME) / "config.yaml"
            with config_path.open() as f:
                config = yaml.safe_load(f)
            model_config = config.get("model", {}) if isinstance(config, dict) else {}
            if isinstance(model_config, dict):
                has_model = bool(model_config.get("default") or model_config.get("model"))
                configured_provider = str(model_config.get("provider") or "").strip()
        except Exception:
            has_model = False
    else:
        # We still need the native provider below (notably OAuth providers).
        try:
            import yaml
            with (Path(HERMES_HOME) / "config.yaml").open() as f:
                config = yaml.safe_load(f)
            model_config = config.get("model", {}) if isinstance(config, dict) else {}
            if isinstance(model_config, dict):
                configured_provider = str(model_config.get("provider") or "").strip()
        except Exception:
            pass
    has_provider = (
        any(data.get(k) for k in PROVIDER_KEYS)
        or _has_xai_oauth_tokens()
        # Native Hermes model setup pins authenticated OAuth providers such as
        # openai-codex directly in config.yaml. Let Hermes validate/refresh its
        # own auth store rather than incorrectly declaring the wrapper incomplete.
        or bool(configured_provider and configured_provider.lower() != "auto")
    )
    return has_model and has_provider


def mask(data: dict[str, str]) -> dict[str, str]:
    return {
        k: (v[:8] + "***" if len(v) > 8 else "***") if k in SECRET_KEYS and v else v
        for k, v in data.items()
    }


def unmask(new: dict[str, str], existing: dict[str, str]) -> dict[str, str]:
    return {
        k: (existing.get(k, "") if k in SECRET_KEYS and v.endswith("***") else v)
        for k, v in new.items()
    }


# ── Auth (cookie-based) ───────────────────────────────────────────────────────
# We use HMAC-signed cookies instead of HTTP Basic Auth because:
#   1. Basic auth's per-directory protection space means browsers cache creds
#      for /setup/* separately from /*, forcing re-prompt on navigation.
#   2. Browser behavior for sending Basic auth on XHR/fetch is inconsistent;
#      the Hermes React SPA's plain fetch() calls don't reliably include it,
#      causing every proxied API call to 401.
# Cookies are auto-included on every same-origin request (navigation + XHR)
# so both the setup UI and the proxied Hermes dashboard work with one login.
#
# The SECRET is regenerated on every process start. That means any ADMIN_PASSWORD
# change via Railway → redeploy → all existing cookies invalidate → users re-login.
import hashlib as _hashlib
import hmac as _hmac
from urllib.parse import quote as _url_quote, urlparse as _urlparse

COOKIE_NAME = "hermes_auth"
COOKIE_MAX_AGE = 7 * 86400  # 7 days
COOKIE_SECRET = secrets.token_bytes(32)

# Public paths — no auth required. Everything else is behind the cookie gate.
PUBLIC_PATHS = {"/health", "/login", "/logout"}


def _make_auth_token() -> str:
    """Build a cookie value: `<expires>.<hmac-sha256>`."""
    expires = str(int(time.time()) + COOKIE_MAX_AGE)
    sig = _hmac.new(COOKIE_SECRET, expires.encode(), _hashlib.sha256).hexdigest()
    return f"{expires}.{sig}"


def _verify_auth_token(token: str) -> bool:
    try:
        expires_s, sig = token.rsplit(".", 1)
        if int(expires_s) < time.time():
            return False
        expected = _hmac.new(COOKIE_SECRET, expires_s.encode(), _hashlib.sha256).hexdigest()
        return _hmac.compare_digest(sig, expected)
    except Exception:
        return False


def _is_authenticated(request: Request) -> bool:
    return _verify_auth_token(request.cookies.get(COOKIE_NAME, ""))


def _safe_return_to(value: str) -> str:
    """Reject open-redirect attempts — only allow same-origin relative paths."""
    if not value or not value.startswith("/") or value.startswith("//"):
        return "/"
    # Strip any scheme/netloc that slipped through.
    p = _urlparse(value)
    if p.scheme or p.netloc:
        return "/"
    return value


def guard(request: Request) -> Response | None:
    """Enforce auth on protected routes.

    - HTML navigation: 302 to /login?returnTo=<path>
    - API / XHR: 401 JSON (so the SPA's fetch() can surface it cleanly)
    """
    if _is_authenticated(request):
        return None
    accept = request.headers.get("accept", "").lower()
    wants_html = "text/html" in accept
    if wants_html:
        rt = request.url.path
        if request.url.query:
            rt = f"{rt}?{request.url.query}"
        return RedirectResponse(f"/login?returnTo={_url_quote(rt)}", status_code=302)
    return JSONResponse({"error": "Unauthorized"}, status_code=401)


LOGIN_PAGE_HTML = """<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Hermes Agent — Sign in</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#ffffff;color:#000000;font-family:'JetBrains Mono','SFMono-Regular',Consolas,monospace;
  min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
.card{background:#ffffff;border:1px solid #000000;border-radius:16px;padding:36px 32px;width:100%;max-width:380px;
  box-shadow:0 10px 30px rgba(0,0,0,0.06)}
.logo-box{width:34px;height:34px;border:1px dashed #000000;border-radius:6px;background:#f5f5f5;margin:0 auto 14px}
.brand{text-align:center;margin-bottom:24px}
.brand-logo{display:inline-flex;align-items:center;gap:6px;font-family:'JetBrains Mono',monospace;font-weight:700;font-size:20px;color:#000000;letter-spacing:-0.02em}
.brand-logo span{color:#737373;font-weight:400}
.brand-sub{font-family:'JetBrains Mono',monospace;font-size:10px;color:#737373;margin-top:8px;letter-spacing:1.8px;text-transform:uppercase;font-weight:600}
label{display:block;font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:600;color:#000000;
  letter-spacing:0.06em;text-transform:uppercase;margin-bottom:6px;margin-top:16px}
input{width:100%;background:#ffffff;border:1px solid #d4d4d4;border-radius:8px;color:#000000;
  font-family:'JetBrains Mono',monospace;font-size:13px;padding:10px 12px;outline:none;transition:border-color .15s,box-shadow .15s}
input:focus{border-color:#000000;box-shadow:0 0 0 1px #000000}
button{width:100%;margin-top:24px;background:#000000;border:1px solid #000000;border-radius:8px;color:#ffffff;
  font-family:'JetBrains Mono',monospace;font-size:13px;font-weight:600;padding:11px;cursor:pointer;
  transition:background .15s}
button:hover{background:#262626;border-color:#262626}
.err{background:#f5f5f5;border:1px solid #000000;border-radius:8px;
  color:#000000;font-family:'JetBrains Mono',monospace;font-size:12px;font-weight:600;padding:10px 12px;margin-bottom:16px;text-align:center}
.footnote{margin-top:20px;font-family:'JetBrains Mono',monospace;font-size:10px;color:#737373;text-align:center;line-height:1.6}
.footnote code{background:#f5f5f5;border:1px solid #e5e5e5;padding:2px 5px;border-radius:4px;color:#000000;font-size:10px}
.back-link{margin-top:16px;text-align:center}
.back-link a{color:#737373;font-size:11px;text-decoration:none;font-family:'JetBrains Mono',monospace;transition:color .15s}
.back-link a:hover{color:#000000;text-decoration:underline}
</style></head>
<body>
<div class="card">
  <div class="brand">
    <div class="logo-box" aria-label="Logo placeholder"></div>
    <div class="brand-logo">hermes<span>/admin</span></div>
    <div class="brand-sub">Sign in to continue</div>
  </div>
  __ERROR__
  <form method="POST" action="/login">
    <input type="hidden" name="returnTo" value="__RETURN_TO__">
    <label for="username">Username</label>
    <input id="username" name="username" type="text" autocomplete="username" autofocus required>
    <label for="password">Password</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required>
    <button type="submit">Sign in</button>
  </form>
  <p class="footnote">Credentials are the <code>ADMIN_USERNAME</code> and <code>ADMIN_PASSWORD</code><br>Railway service variables.</p>
  <div class="back-link"><a href="/">← Back to Prism 8</a></div>
</div>
</body></html>"""


def _html_escape(s: str) -> str:
    return (s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
             .replace('"', "&quot;").replace("'", "&#39;"))


async def page_login(request: Request) -> Response:
    """GET /login — render the sign-in form."""
    # Already signed in? Bounce to returnTo (or /).
    if _is_authenticated(request):
        return RedirectResponse(_safe_return_to(request.query_params.get("returnTo", "/")), status_code=302)
    rt = _safe_return_to(request.query_params.get("returnTo", "/"))
    error_html = ('<div class="err">Invalid username or password</div>'
                  if request.query_params.get("error") else "")
    html = (LOGIN_PAGE_HTML
            .replace("__ERROR__", error_html)
            .replace("__RETURN_TO__", _html_escape(rt)))
    return HTMLResponse(html)


async def login_post(request: Request) -> Response:
    """POST /login — validate creds and set the auth cookie."""
    form = await request.form()
    username = str(form.get("username", ""))
    password = str(form.get("password", ""))
    return_to = _safe_return_to(str(form.get("returnTo", "/")))

    valid_user = _hmac.compare_digest(username, ADMIN_USERNAME)
    valid_pw = _hmac.compare_digest(password, ADMIN_PASSWORD)
    if valid_user and valid_pw:
        resp = RedirectResponse(return_to, status_code=302)
        resp.set_cookie(
            COOKIE_NAME,
            _make_auth_token(),
            max_age=COOKIE_MAX_AGE,
            httponly=True,
            samesite="lax",
            path="/",
        )
        return resp
    return RedirectResponse(f"/login?returnTo={_url_quote(return_to)}&error=1", status_code=302)


async def logout(request: Request) -> Response:
    """GET /logout — clear cookie and bounce to login."""
    resp = RedirectResponse("/login", status_code=302)
    resp.delete_cookie(COOKIE_NAME, path="/")
    return resp


# ── Gateway manager ───────────────────────────────────────────────────────────
# Auto-respawn tuning. When the gateway exits without us asking it to — an
# in-band `/restart` (inside a container hermes exits 75 expecting a supervisor
# to bring it back; verified it takes the exit-75 path, NOT a detached
# self-restart, when /run/.containerenv or /.dockerenv exists), a crash, or an
# OOM kill — server.py is that supervisor and must restart it. Nothing else
# will, and /health stays 200, so the bot would otherwise sit silently dead.
# A crash-loop guard stops us hammering a gateway that genuinely can't stay up
# (e.g. a bad provider key / model).
RESPAWN_WINDOW_S   = 120     # rolling window (s) for counting unexpected exits
RESPAWN_MAX_IN_WIN = 5       # give up auto-restart after this many exits in window
RESPAWN_BASE_DELAY = 2.0     # first backoff (seconds)
RESPAWN_MAX_DELAY  = 30.0    # backoff cap


class Gateway:
    """Supervises one `hermes gateway run` subprocess.

    Parametrized (rather than hardcoded to the operator/default profile) so the
    same class also supervises the locked-down `pr` profile's gateway — see
    `gw_pr` below. Everything profile-specific (the session cwd for AGENTS.md
    discovery, the subprocess env — which is what actually selects the
    profile, via HERMES_HOME, see build_pr_env() — the config.yaml writer, and
    where that profile's gateway.pid lock lives) is passed in; behavior for
    the default `gw = Gateway()` instance is unchanged. Deliberately NOT a
    `-p <name>` CLI flag: confirmed live that `hermes -p pr gateway run
    --replace` did not scope the process to that profile's home (its boot log
    showed the ROOT session storage path) — Hermes' own `<alias> chat`
    wrapper scripts select a profile purely via HERMES_HOME, which is the
    mechanism used here instead.
    """

    def __init__(
        self,
        *,
        cwd: str = AGENT_WORKDIR,
        env_builder: Callable[[], dict[str, str]] = build_hermes_env,
        config_writer: Callable[[], None] | None = None,
        pid_home: str = HERMES_HOME,
        log_prefix: str = "gateway",
    ):
        self.cwd = cwd
        self.env_builder = env_builder
        self.config_writer = config_writer or (lambda: write_config_yaml(read_env(ENV_FILE)))
        self.pid_home = pid_home
        self.log_prefix = log_prefix

        self.proc: asyncio.subprocess.Process | None = None
        self.state = "stopped"
        self.logs: deque[str] = deque(maxlen=500)
        self.started_at: float | None = None
        self.restarts = 0
        # True while a deliberate stop()/restart()/reset is in flight, so the
        # exiting process's _drain() doesn't fire an auto-respawn that races the
        # intentional lifecycle.
        self._stopping = False
        # Monotonic timestamps of recent unexpected exits (crash-loop guard).
        self._recent_exits: list[float] = []

    async def start(self, *, reset_budget: bool = True):
        if self.proc and self.proc.returncode is None:
            return
        # A manual Start/Restart (or boot) grants a fresh crash-loop budget; the
        # auto-respawn path passes reset_budget=False so repeated crashes keep
        # accumulating toward the give-up threshold.
        if reset_budget:
            self._recent_exits.clear()
        self.state = "starting"
        self._stopping = False
        try:
            env = self.env_builder()
            model = env.get("LLM_MODEL", "")
            provider_key = next((env.get(k, "") for k in PROVIDER_KEYS if env.get(k)), "")
            print(f"[{self.log_prefix}] model={model or '⚠ NOT SET'} | provider_key={'set' if provider_key else '⚠ NOT SET'}", flush=True)
            # Write config.yaml so hermes picks up the model (env vars alone aren't always enough)
            self.config_writer()
            # --replace: force-displace any existing gateway.pid lock holder
            # before claiming it. Without this, a lock left behind by a prior
            # incarnation this supervisor doesn't recognize as "our" dead
            # process (e.g. hermes' own dashboard spawns its own detached
            # `hermes gateway restart` via its native /api/gateway/restart
            # action, entirely outside this class's tracking) makes every
            # subsequent plain `hermes gateway` invocation refuse to start
            # ("Another gateway instance is already running"), which
            # _clear_stale_pidfile() can never self-heal since it only clears
            # a pid file matching the exact pid THIS supervisor just watched
            # die. --replace is hermes' own blessed fix for exactly this
            # class of stuck-lock — it force-kills whatever holds the lock
            # (graceful SIGTERM, escalating to SIGKILL) before claiming it.
            #
            # Profile selection is via HERMES_HOME in `env` (set by
            # env_builder), NOT a `-p <profile>` CLI flag: confirmed live that
            # `hermes -p pr gateway run --replace` did not actually scope this
            # process to the pr profile's home (its own boot log showed
            # "Session storage: /data/.hermes/sessions" — the ROOT path, not
            # profiles/pr/sessions) — the two gateways ended up fighting over
            # the same underlying lock via repeated --replace takeovers. This
            # is exactly how the `<alias> chat` wrapper scripts work per
            # Hermes' own docs: they set HERMES_HOME=~/.hermes/profiles/<name>
            # and invoke plain `hermes`, no -p flag involved.
            args = ["gateway", "run", "--replace"]
            self.proc = await asyncio.create_subprocess_exec(
                "hermes", *args,
                # cwd is the session working dir the TUI/CLI uses for AGENTS.md
                # discovery (it ignores terminal.cwd) — see AGENT_WORKDIR/PR_WORKDIR.
                cwd=self.cwd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
                env=env,
            )
            self.state = "running"
            self.started_at = time.time()
            asyncio.create_task(self._drain(self.proc))
        except Exception as e:
            self.state = "error"
            message = f"[{self.log_prefix}] [error] Failed to start: {e!r}"
            self.logs.append(message)
            # This branch covers everything before the subprocess spawns
            # (env_builder()/config_writer() raising, or the exec itself
            # failing) — none of that reaches _drain()'s stdout mirror, so
            # without this print it's only visible via the cookie-authenticated
            # /setup/api/logs endpoint, not Railway's raw log stream.
            print(message, flush=True)

    async def stop(self):
        self._stopping = True
        if not self.proc or self.proc.returncode is not None:
            self.state = "stopped"
            return
        self.state = "stopping"
        self.proc.terminate()
        try:
            await asyncio.wait_for(self.proc.wait(), timeout=10)
        except asyncio.TimeoutError:
            self.proc.kill()
            await self.proc.wait()
        self.state = "stopped"
        self.started_at = None

    async def restart(self):
        await self.stop()
        self.restarts += 1
        await self.start()

    async def _drain(self, proc: asyncio.subprocess.Process):
        assert proc.stdout
        async for raw in proc.stdout:
            line = ANSI_ESCAPE.sub("", raw.decode(errors="replace").rstrip())
            self.logs.append(line)
            # Same idiom as Dashboard._drain(): mirror to stdout (→ Railway
            # logs) so a startup failure (e.g. an unrecognized `-p <profile>`
            # invocation, a bad config.yaml) is visible without needing the
            # cookie-authenticated /setup/api/logs endpoint.
            print(f"[{self.log_prefix}] {line}", flush=True)
        rc = proc.returncode
        # Ignore the drain of a process we've already replaced (e.g. via restart()).
        if proc is not self.proc:
            return
        # A deliberate stop()/restart()/reset owns its own lifecycle — don't respawn.
        if self._stopping:
            return
        # Unexpected exit: in-band `/restart` (exit 75), a crash, or an OOM kill.
        # On Railway nothing else brings the gateway back, so we supervise it.
        self.state = "error"
        self.logs.append(f"[{self.log_prefix}] exited (code {rc}) — supervising restart")
        asyncio.create_task(self._supervise_respawn(proc.pid))

    async def _supervise_respawn(self, dead_pid: int | None):
        # Crash-loop guard: count unexpected exits inside a rolling window and
        # give up (rather than hammer) once they exceed the threshold.
        now = time.monotonic()
        self._recent_exits = [t for t in self._recent_exits if now - t < RESPAWN_WINDOW_S]
        self._recent_exits.append(now)
        if len(self._recent_exits) > RESPAWN_MAX_IN_WIN:
            self.state = "crashed"
            self.logs.append(
                f"[{self.log_prefix}] crash-looping ({len(self._recent_exits)} exits in "
                f"{RESPAWN_WINDOW_S}s) — giving up auto-restart. Fix the provider/"
                f"model in the admin UI, then Start/Restart the gateway."
            )
            return
        delay = min(RESPAWN_BASE_DELAY * 2 ** (len(self._recent_exits) - 1), RESPAWN_MAX_DELAY)
        self.logs.append(f"[{self.log_prefix}] restarting in {int(delay)}s (attempt {len(self._recent_exits)})")
        await asyncio.sleep(delay)
        # Re-check the deliberate-lifecycle conditions AFTER the backoff sleep: a
        # Stop, Reset, or shutdown issued during the wait must win over the respawn.
        if self._stopping:
            self.logs.append(f"[{self.log_prefix}] restart cancelled (stopped/reconfigured)")
            return
        if self.proc and self.proc.returncode is None:
            return  # a manual Start already brought a live gateway back
        if not is_config_complete():
            self.state = "stopped"
            self.logs.append(f"[{self.log_prefix}] restart skipped — provider/model not configured")
            return
        # Clear a pid file left stale by a hard crash (SIGKILL/OOM skips hermes'
        # atexit cleanup) so the respawn's own O_EXCL pid claim can't bail with
        # "PID file race lost". Scoped to the pid we just buried — never disturbs
        # a live gateway's lock.
        self._clear_stale_pidfile(dead_pid)
        self.restarts += 1
        await self.start(reset_budget=False)

    def _clear_stale_pidfile(self, dead_pid: int | None) -> None:
        if dead_pid is None:
            return
        pid_file = Path(self.pid_home) / "gateway.pid"
        try:
            rec = json.loads(pid_file.read_text())
        except Exception:
            return
        if rec.get("pid") == dead_pid:
            try:
                pid_file.unlink()
                self.logs.append(f"[{self.log_prefix}] cleared stale pid file (pid {dead_pid})")
            except OSError:
                pass

    def status(self) -> dict:
        uptime = int(time.time() - self.started_at) if self.started_at and self.state == "running" else None
        return {
            "state":    self.state,
            "pid":      self.proc.pid if self.proc and self.proc.returncode is None else None,
            "uptime":   uptime,
            "restarts": self.restarts,
        }


gw = Gateway()

# The locked-down `pr` (public-relations) profile's gateway — same class, same
# supervision/respawn/crash-loop behavior, but its own profile flag, session
# cwd, env (build_pr_env — LLM provider key only, no operator/write secrets),
# config writer (write_pr_config_yaml, registers only the *_read MCPs), and
# pid-lock file (profiles have their own gateway.pid, not the root one gw uses
# — see the Hermes profiles docs). Started/stopped alongside gw in
# auto_start()/lifespan() below; the tokenization platform's chat route talks
# to it over its api_server port (PR_API_SERVER_URL), never through gw.
def _write_pr_config() -> None:
    write_pr_config_yaml(_current_pr_model_block())
    # Same reasoning as the write_config_yaml() call site: a dashboard- or
    # CLI-initiated start of this profile doesn't go through build_pr_env(),
    # so the .env file on disk is what makes api_server actually come up
    # regardless of who spawns the gateway.
    write_pr_env_file()


gw_pr = Gateway(
    cwd=PR_WORKDIR,
    env_builder=build_pr_env,
    config_writer=_write_pr_config,
    pid_home=str(PR_HOME),
    log_prefix="pr-gateway",
)


def _current_pr_model_block() -> dict[str, str]:
    """Resolve the model block gw_pr's config_writer should use.

    write_config_yaml() already calls write_pr_config_yaml() itself with the
    just-resolved operator model block on every operator gateway start/restart
    (keeping the two in sync the moment either changes). This is the fallback
    for the independent path where gw_pr starts, restarts, or respawns on its
    own (e.g. its own crash-loop recovery) without gw also having just run —
    read whatever model.default/provider write_config_yaml last persisted for
    the operator profile, rather than leaving gw_pr on a stale or empty model.
    """
    import yaml

    config_path = Path(HERMES_HOME) / "config.yaml"
    try:
        with config_path.open() as f:
            loaded = yaml.safe_load(f)
    except (OSError, yaml.YAMLError):
        loaded = None
    model_block = loaded.get("model") if isinstance(loaded, dict) else None
    return dict(model_block) if isinstance(model_block, dict) else {"default": ""}


cfg_lock = asyncio.Lock()


# ── Hermes dashboard subprocess ───────────────────────────────────────────────
class Dashboard:
    """Manages the `hermes dashboard` subprocess (native Hermes web UI).

    Bound to loopback only — we expose it to the public internet through our
    reverse proxy on $PORT, where edge basic auth guards every request.
    The dashboard is independent of the gateway: it reads config files
    directly and tolerates a stopped gateway.

    Spawned with the same merged env (OS env + HERMES_HOME + .env contents)
    as the gateway — see build_hermes_env(). Without it, the dashboard process
    only ever sees our own os.environ from container boot, before any
    provider key exists; the embedded Chat tab's agent-init then fails with
    "No inference provider configured" even though /setup shows a key saved,
    because hermes' own provider auto-resolution (hermes_cli/auth.py) reads
    credentials via plain os.getenv(), not by re-parsing .env from disk. Since
    the dashboard only starts once at boot, restart() must be called whenever
    a provider key is saved so the running process picks up the new env.

    All subprocess output is streamed to our stdout (→ Railway logs) with a
    `[dashboard]` prefix AND retained in a ring buffer for diagnostics.
    Unexpected exits are explicitly logged with their return code.
    """

    def __init__(self):
        self.proc: asyncio.subprocess.Process | None = None
        self.logs: deque[str] = deque(maxlen=300)
        self._drain_task: asyncio.Task | None = None

    async def start(self):
        if self.proc and self.proc.returncode is None:
            return
        try:
            self.proc = await asyncio.create_subprocess_exec(
                "hermes", "dashboard",
                "--host", HERMES_DASHBOARD_HOST,
                "--port", str(HERMES_DASHBOARD_PORT),
                "--no-open",
                # --skip-build: the Dockerfile pre-builds the React dashboard
                # into hermes_cli/web_dist/ at image time. This flag tells
                # hermes to trust that dist and skip its npm build check,
                # which would otherwise add ~30s to first startup (hermes >= v2026.5.16).
                "--skip-build",
                # NOTE: the embedded Chat tab (/api/pty + /api/ws + /api/events)
                # is unconditionally enabled as of hermes v2026.6.5 — the old
                # `--tui` flag was REMOVED from the dashboard subcommand. Passing
                # it now aborts startup with "unrecognized arguments: --tui",
                # which kills this subprocess and 503s the reverse proxy. The
                # Dockerfile still pre-builds ui-tui/dist/ (via HERMES_TUI_DIR)
                # so the PTY child spawns instantly on first chat connect.
                #
                # cwd is the crucial bit for AGENTS.md: the Chat tab's PTY child
                # is a TUI session that discovers AGENTS.md from its LAUNCH dir
                # (it ignores terminal.cwd), and it inherits this process's cwd.
                # Launch from AGENT_WORKDIR (seeded with AGENTS.md) so the agent
                # loads its identity — without this it starts in `/`.
                cwd=AGENT_WORKDIR,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
                env=build_hermes_env(),
            )
            print(f"[dashboard] spawned pid={self.proc.pid} → {HERMES_DASHBOARD_URL}", flush=True)
            self._drain_task = asyncio.create_task(self._drain())
        except Exception as e:
            print(f"[dashboard] FAILED to spawn: {e!r}", flush=True)

    async def _drain(self):
        """Stream subprocess output to Railway logs (prefixed) and a ring buffer."""
        assert self.proc and self.proc.stdout
        try:
            async for raw in self.proc.stdout:
                line = ANSI_ESCAPE.sub("", raw.decode(errors="replace").rstrip())
                self.logs.append(line)
                print(f"[dashboard] {line}", flush=True)
        except Exception as e:
            print(f"[dashboard] drain error: {e!r}", flush=True)
        finally:
            rc = self.proc.returncode if self.proc else None
            if rc is not None and rc != 0:
                print(f"[dashboard] EXITED with code {rc} — reverse proxy will return 503 until restart", flush=True)
            elif rc == 0:
                print(f"[dashboard] exited cleanly (code 0)", flush=True)

    async def stop(self):
        if not self.proc or self.proc.returncode is not None:
            return
        self.proc.terminate()
        try:
            await asyncio.wait_for(self.proc.wait(), timeout=5)
        except asyncio.TimeoutError:
            self.proc.kill()
            await self.proc.wait()

    async def restart(self):
        """Respawn so a freshly-saved provider key reaches the embedded Chat tab.

        Drops any live /api/pty, /api/ws, /api/events connections (the
        reverse-proxy WS pumps just see the upstream close and the SPA
        reconnects) — an acceptable trade-off since the alternative is Chat
        staying broken until a full redeploy.
        """
        await self.stop()
        await self.start()


dash = Dashboard()


# ── Tokenization Platform subprocess ─────────────────────────────────────────
class TokenizationApp:
    """Run the standalone Next.js application on a private loopback port."""

    def __init__(self):
        self.proc: asyncio.subprocess.Process | None = None
        self.logs: deque[str] = deque(maxlen=300)
        self._drain_task: asyncio.Task | None = None
        self._stopping = False

    async def start(self):
        if self.proc and self.proc.returncode is None:
            return
        self._stopping = False
        server_entrypoint = TOKENIZATION_APP_DIR / "server.js"
        if not server_entrypoint.is_file():
            print(
                f"[tokenization] standalone server missing at {server_entrypoint}",
                flush=True,
            )
            return

        env = os.environ.copy()
        # Settings saved through the deployment UI live on the persistent
        # Hermes volume rather than in Railway's immutable process environment.
        env.update(read_env(ENV_FILE))
        env.update({
            "NODE_ENV": "production",
            "HOSTNAME": TOKENIZATION_HOST,
            "PORT": str(TOKENIZATION_PORT),
            "TOKENIZATION_AGENT_SECRET": TOKENIZATION_AGENT_SECRET,
            "HERMES_TOKEN_REQUEST_WEBHOOK_URL": TOKEN_REQUEST_WEBHOOK_URL,
            "HERMES_TOKEN_REQUEST_WEBHOOK_SECRET": TOKEN_REQUEST_WEBHOOK_SECRET,
            "HERMES_LIVENESS_WEBHOOK_URL": LIVENESS_VERIFICATION_WEBHOOK_URL,
            "HERMES_LIVENESS_WEBHOOK_SECRET": TOKEN_REQUEST_WEBHOOK_SECRET,
            # Read-only "pr" Hermes profile's OpenAI-compatible API server —
            # the holder-facing token chat route proxies to this, never to the
            # operator gateway. Loopback-only; see PR_* constants above.
            "HERMES_PR_API_SERVER_URL": PR_API_SERVER_URL,
            "HERMES_PR_API_SERVER_KEY": PR_API_SERVER_KEY,
        })
        env.setdefault("DATABASE_PATH", "/data/tokenization/tokenization.db")

        try:
            self.proc = await asyncio.create_subprocess_exec(
                "node",
                "server.js",
                cwd=str(TOKENIZATION_APP_DIR),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
                env=env,
            )
            print(
                f"[tokenization] spawned pid={self.proc.pid} → {TOKENIZATION_URL} (public at /)",
                flush=True,
            )
            self._drain_task = asyncio.create_task(self._drain())
        except Exception as e:
            print(f"[tokenization] FAILED to spawn: {e!r}", flush=True)

    async def _drain(self):
        assert self.proc and self.proc.stdout
        try:
            async for raw in self.proc.stdout:
                line = ANSI_ESCAPE.sub("", raw.decode(errors="replace").rstrip())
                self.logs.append(line)
                print(f"[tokenization] {line}", flush=True)
        except Exception as e:
            print(f"[tokenization] drain error: {e!r}", flush=True)
        finally:
            rc = self.proc.returncode if self.proc else None
            expected_stop = self._stopping or rc in {0, 130, 143, -2, -15}
            if rc is not None and not expected_stop:
                print(
                    f"[tokenization] EXITED with code {rc} — / will return 503",
                    flush=True,
                )
            elif expected_stop:
                print(f"[tokenization] stopped cleanly (code {rc})", flush=True)

    async def stop(self):
        if not self.proc or self.proc.returncode is not None:
            return
        self._stopping = True
        self.proc.terminate()
        try:
            await asyncio.wait_for(self.proc.wait(), timeout=10)
        except asyncio.TimeoutError:
            self.proc.kill()
            await self.proc.wait()

    async def restart(self):
        await self.stop()
        await self.start()


tokenization = TokenizationApp()

# Shared async HTTP client for the reverse proxy. Created lazily so we pick up
# the running event loop, torn down in lifespan.
_http_client: httpx.AsyncClient | None = None


def get_http_client() -> httpx.AsyncClient:
    global _http_client
    if _http_client is None:
        _http_client = httpx.AsyncClient(
            timeout=httpx.Timeout(30.0, connect=5.0),
            follow_redirects=False,
        )
    return _http_client


_HERMES_SESSION_TOKEN_RE = re.compile(r'__HERMES_SESSION_TOKEN__\s*=\s*"([^"]*)"')


async def _get_hermes_session_token() -> str:
    """Scrape the dashboard's own ephemeral session token from its SPA shell.

    Hermes gates every non-public ``/api/*`` route behind a per-process
    random ``_SESSION_TOKEN`` — a legacy check in hermes_cli/web_server.py's
    ``auth_middleware`` that's SEPARATE from (and still active alongside) the
    OAuth gate that invariant 3 already covers. Loopback bind only turns off
    the OAuth gate (``auth_required``); it does not exempt this token check.
    A tokenless call like a plain server-to-server POST 401s unconditionally.

    The only way to obtain a valid token without a browser is the same way
    the SPA itself does: on a loopback (ungated) bind, hermes injects it into
    every served HTML shell as ``window.__HERMES_SESSION_TOKEN__="..."``
    (hermes_cli/web_server.py's ``_serve_index``). That HTML-serving catch-all
    route is not under ``/api/``, so it is never itself gated — no chicken-
    and-egg problem. Not cached: cheap (one loopback GET), and self-heals
    across a dashboard restart (which rotates the token) without needing
    invalidation logic. Re-verify the injected variable name against
    hermes_cli/web_server.py on a Hermes version bump — if it's ever renamed
    or removed, this degrades to the pre-existing "no token" 401 handled
    below, not a crash.
    """
    client = get_http_client()
    resp = await client.get(f"{HERMES_DASHBOARD_URL}/", timeout=httpx.Timeout(10.0))
    resp.raise_for_status()
    match = _HERMES_SESSION_TOKEN_RE.search(resp.text)
    return match.group(1) if match else ""


async def set_active_model_via_hermes(
    provider_id: str, model: str, *, base_url: str = "", api_key: str = ""
) -> str | None:
    """Pin model.provider + model.default via hermes' own POST /api/model/set.

    Delegates to hermes_cli/web_server.py's _apply_main_model_assignment — the
    same code path its dashboard's "Switch Model" dialog and flat Config page
    use — instead of us hand-writing config.yaml's model block. Hermes always
    resolves an EXPLICIT provider there (never "auto") and correctly clears
    stale base_url/api_key only on a genuine provider switch, preserving them
    on a same-provider re-pick.

    Necessary because our own /setup wizard has a single shared "LLM Model"
    field across every configured provider: once 2+ provider keys exist in
    .env, config.yaml's model.provider="auto" (write_config_yaml()'s old
    unconditional default) lets hermes resolve to the WRONG provider — the
    first match in its own internal PROVIDER_REGISTRY dict order — paired
    with a model string that belongs to a DIFFERENT provider.

    base_url/api_key are forwarded verbatim into this same request's own
    ``base_url``/``api_key`` fields (hermes_cli/web_server.py's
    ``ModelAssignment`` schema — "Only honored for custom/local providers on
    the main slot"). REQUIRED for provider_id="custom": hermes' actual
    runtime resolver (hermes_cli/runtime_provider.py, what the gateway/Chat
    tab call at agent-init) only trusts a bare "custom" provider when
    model.base_url is ALSO set directly on the model block — it never
    consults config.yaml's separate custom_providers[] list (that's
    display/bookkeeping only, for hermes' own Keys-tab picker). Passing them
    lets hermes write model.base_url/model.api_key itself; it also
    auto-registers a matching custom_providers catalog entry as a side
    effect, mirroring its own dashboard's custom-endpoint flow.

    Best-effort: on any failure (dashboard not up yet, network hiccup, no
    session token obtainable) we leave whatever write_config_yaml() already
    wrote in place (single-provider "auto" default, or a previously-pinned
    provider preserved as-is) rather than blocking the save. Returns a
    human-readable warning string on failure, or None on success.
    """
    client = get_http_client()
    try:
        session_token = await _get_hermes_session_token()
    except httpx.HTTPError as e:
        return f"Could not fetch a Hermes session token to pin {provider_id} ({e}); using auto-resolution instead."
    headers = {_SESSION_TOKEN_HEADER: session_token} if session_token else {}

    try:
        resp = await client.post(
            f"{HERMES_DASHBOARD_URL}/api/model/set",
            json={
                "scope": "main",
                "provider": provider_id,
                "model": model,
                "base_url": base_url,
                "api_key": api_key,
                # We have no UI to show hermes' own "this model looks
                # expensive, are you sure?" confirmation — the user already
                # confirmed intent by pasting a key and a model name here.
                "confirm_expensive_model": True,
            },
            headers=headers,
            timeout=httpx.Timeout(15.0),
        )
    except (httpx.ConnectError, httpx.ConnectTimeout, httpx.ReadTimeout) as e:
        return f"Could not reach the Hermes dashboard to pin {provider_id} ({e}); using auto-resolution instead."
    except httpx.RequestError as e:
        return f"Hermes model/set request failed ({e}); using auto-resolution instead."

    if resp.status_code != 200:
        return f"Hermes rejected the {provider_id} model/provider pin (HTTP {resp.status_code}); using auto-resolution instead."
    try:
        data = resp.json()
    except Exception:
        return None  # 200 with an unparseable body — nothing actionable to report
    if data.get("ok") is False:
        return data.get("confirm_message") or f"Hermes did not apply the {provider_id} model/provider pin; using auto-resolution instead."
    return None


# ── Route handlers ────────────────────────────────────────────────────────────
async def page_index(request: Request):
    if err := guard(request): return err
    return templates.TemplateResponse(request, "index.html")


async def route_health(request: Request):
    return JSONResponse({"status": "ok", "gateway": gw.state, "pr_gateway": gw_pr.state})


async def api_config_get(request: Request):
    if err := guard(request): return err
    async with cfg_lock:
        data = read_env(ENV_FILE)
    defs = [{"key": k, "label": l, "category": c, "secret": s} for k, l, c, s in ENV_VARS]
    return JSONResponse({"vars": mask(data), "defs": defs})


async def api_config_put(request: Request):
    if err := guard(request): return err
    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"error": "Invalid JSON"}, status_code=400)
    try:
        restart = body.pop("_restart", False)
        # Set by the setup wizard to the ENV_VARS key of whichever provider's
        # dropdown entry was selected in this save action (e.g. "NVIDIA_API_KEY")
        # — empty when the user saved without touching a provider (e.g. just
        # toggling a messaging channel). See set_active_model_via_hermes().
        active_provider_key = str(body.pop("_active_provider_key", "") or "").strip()
        new_vars = body.get("vars", {})
        async with cfg_lock:
            existing = read_env(ENV_FILE)
            merged = unmask(new_vars, existing)
            for k, v in existing.items():
                if k not in merged:
                    merged[k] = v
            validate_world_id_policy(merged)
            write_env(ENV_FILE, merged)
            write_config_yaml(merged)

        model_warning = None
        hermes_provider_id = HERMES_PROVIDER_IDS.get(active_provider_key)
        model_value = merged.get("LLM_MODEL", "").strip()
        if hermes_provider_id and model_value:
            pin_base_url = ""
            pin_api_key = ""
            if hermes_provider_id == "custom":
                pin_base_url = (
                    CUSTOM_STYLE_BASE_URLS.get(active_provider_key)
                    or merged.get("CUSTOM_PROVIDER_BASE_URL", "").strip()
                )
                pin_api_key = merged.get(active_provider_key, "").strip()
            model_warning = await set_active_model_via_hermes(
                hermes_provider_id, model_value, base_url=pin_base_url, api_key=pin_api_key
            )

        if restart:
            asyncio.create_task(gw.restart())
            # The dashboard (and its embedded Chat tab) only ever sees the env
            # it was spawned with — a newly-saved provider key doesn't reach
            # the already-running process otherwise. See Dashboard.restart().
            asyncio.create_task(dash.restart())
            # World ID/Hedera settings are also consumed by the standalone
            # tokenization process, so it must receive the freshly saved env.
            asyncio.create_task(tokenization.restart())
        resp = {"ok": True, "restarting": restart}
        if model_warning:
            resp["warning"] = model_warning
        return JSONResponse(resp)
    except ValueError as e:
        return JSONResponse({"error": str(e)}, status_code=400)
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


async def api_status(request: Request):
    if err := guard(request): return err
    data = read_env(ENV_FILE)
    providers = {
        k.replace("_API_KEY","").replace("_TOKEN","").replace("HF_","HuggingFace ").replace("_"," ").title():
        {"configured": bool(data.get(k))}
        for k in PROVIDER_KEYS
    }
    channels = {
        name: {"configured": bool(v := data.get(key,"")) and v.lower() not in ("false","0","no")}
        for name, key in CHANNEL_MAP.items()
    }
    return JSONResponse({
        "gateway": gw.status(),
        "pr_gateway": gw_pr.status(),
        "providers": providers,
        "channels": channels,
    })


async def api_logs(request: Request):
    if err := guard(request): return err
    return JSONResponse({"lines": list(gw.logs), "pr_lines": list(gw_pr.logs)})


async def api_gw_start(request: Request):
    if err := guard(request): return err
    asyncio.create_task(gw.start())
    return JSONResponse({"ok": True})


async def api_gw_stop(request: Request):
    if err := guard(request): return err
    asyncio.create_task(gw.stop())
    return JSONResponse({"ok": True})


async def api_gw_restart(request: Request):
    if err := guard(request): return err
    asyncio.create_task(gw.restart())
    return JSONResponse({"ok": True})


async def api_config_reset(request: Request):
    if err := guard(request): return err
    asyncio.create_task(gw.stop())
    async with cfg_lock:
        if ENV_FILE.exists():
            ENV_FILE.unlink()
        write_config_yaml({}, reset_model=True)
    return JSONResponse({"ok": True})


# ── Pairing ───────────────────────────────────────────────────────────────────
# Pending-request file format (hermes >= v0.15 / v2026.5.29.x, gateway/pairing.py):
# each `{platform}-pending.json` entry is keyed by a random opaque `entry_id`
# (secrets.token_hex), and the user-facing pairing code is stored only as a
# salted hash ({hash, salt, user_id, user_name, created_at}) — the plaintext
# code is never on disk. Our admin-approval flow is code-agnostic: the dashboard
# is already cookie-authed, so we approve by moving an entry from pending →
# approved keyed off that `entry_id` (round-tripped from the pending list as
# `code`), reading `user_id`/`user_name` straight from the entry. We must NOT
# uppercase that key — entry_ids are lowercase hex, and uppercasing them was
# what silently broke approve/deny on the v0.15 upgrade. Older plaintext-keyed
# entries still work here because we treat the key as an opaque handle.
def _pjson(path: Path) -> dict:
    try:
        return json.loads(path.read_text()) if path.exists() else {}
    except Exception:
        return {}


def _wjson(path: Path, data: dict):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False))
    try: os.chmod(path, 0o600)
    except OSError: pass


def _platforms(suffix: str) -> list[str]:
    if not PAIRING_DIR.exists(): return []
    return [f.stem.rsplit(f"-{suffix}", 1)[0] for f in PAIRING_DIR.glob(f"*-{suffix}.json")]


async def api_pairing_pending(request: Request):
    if err := guard(request): return err
    now = time.time()
    out = []
    for p in _platforms("pending"):
        for code, info in _pjson(PAIRING_DIR / f"{p}-pending.json").items():
            if now - info.get("created_at", now) <= PAIRING_TTL:
                out.append({"platform": p, "code": code,
                            "user_id": info.get("user_id",""), "user_name": info.get("user_name",""),
                            "age_minutes": int((now - info.get("created_at", now)) / 60)})
    return JSONResponse({"pending": out})


async def api_pairing_approve(request: Request):
    if err := guard(request): return err
    try: body = await request.json()
    except Exception: return JSONResponse({"error": "Invalid JSON"}, status_code=400)
    platform, code = body.get("platform",""), body.get("code","").strip()
    if not platform or not code:
        return JSONResponse({"error": "platform and code required"}, status_code=400)
    pending_path = PAIRING_DIR / f"{platform}-pending.json"
    pending = _pjson(pending_path)
    if code not in pending:
        return JSONResponse({"error": "Code not found"}, status_code=404)
    entry = pending.pop(code)
    user_id = (entry.get("user_id") or "").strip() if isinstance(entry, dict) else ""
    if not user_id:
        # Malformed/legacy entry without a user_id — leave it in pending (we
        # haven't written the pop yet) rather than silently discarding it.
        return JSONResponse({"error": "Pending entry has no user_id"}, status_code=422)
    _wjson(pending_path, pending)
    approved = _pjson(PAIRING_DIR / f"{platform}-approved.json")
    approved[user_id] = {"user_name": entry.get("user_name",""), "approved_at": time.time()}
    _wjson(PAIRING_DIR / f"{platform}-approved.json", approved)
    return JSONResponse({"ok": True})


async def api_pairing_deny(request: Request):
    if err := guard(request): return err
    try: body = await request.json()
    except Exception: return JSONResponse({"error": "Invalid JSON"}, status_code=400)
    platform, code = body.get("platform",""), body.get("code","").strip()
    p = PAIRING_DIR / f"{platform}-pending.json"
    pending = _pjson(p)
    if code in pending:
        del pending[code]
        _wjson(p, pending)
    return JSONResponse({"ok": True})


async def api_pairing_approved(request: Request):
    if err := guard(request): return err
    out = []
    for p in _platforms("approved"):
        for uid, info in _pjson(PAIRING_DIR / f"{p}-approved.json").items():
            out.append({"platform": p, "user_id": uid,
                        "user_name": info.get("user_name",""), "approved_at": info.get("approved_at",0)})
    return JSONResponse({"approved": out})


async def api_pairing_revoke(request: Request):
    if err := guard(request): return err
    try: body = await request.json()
    except Exception: return JSONResponse({"error": "Invalid JSON"}, status_code=400)
    platform, uid = body.get("platform",""), body.get("user_id","")
    if not platform or not uid:
        return JSONResponse({"error": "platform and user_id required"}, status_code=400)
    p = PAIRING_DIR / f"{platform}-approved.json"
    approved = _pjson(p)
    if uid in approved:
        del approved[uid]
        _wjson(p, approved)
    return JSONResponse({"ok": True})


# ── Backup & Restore ─────────────────────────────────────────────────────────
# Thin wrapper around hermes' OWN `hermes backup` / `hermes import` CLI
# (hermes_cli/backup.py, verified against v2026.7.1) rather than reimplementing
# file selection: it already excludes code checkouts/caches/venvs/lock files
# from the walk, protects against zip-slip on extract, and — critically — skips
# re-writing gateway_state.json/gateway.pid/cron.pid/gateway.lock/processes.json
# even when present in the archive (_IMPORT_SKIP_NAMES). That's exactly the
# "don't let a foreign pid file wedge the supervisor" concern invariant 6
# already documents — we deliberately do not duplicate either behavior
# ourselves. Re-verify both on a future Hermes version bump, same as every
# other upstream-CLI assumption this template makes.
BACKUP_DIR = Path(HERMES_HOME) / "backups"   # hermes' own pre-update-backup convention;
                                              # this dir is itself in hermes' backup
                                              # exclusion list, so snapshots here never
                                              # bloat a future full backup.
PRE_RESTORE_KEEP = 3
BACKUP_SUBPROCESS_TIMEOUT = 600  # 10 min ceiling for both `hermes backup` and `hermes import`
SNAPSHOT_NAME_RE = re.compile(r"^pre-restore-\d+-[0-9a-f]+\.zip$")

backup_lock = asyncio.Lock()


async def _run_hermes_cli(*args: str, timeout: float = BACKUP_SUBPROCESS_TIMEOUT) -> tuple[int, str]:
    """Run a `hermes <args>` subcommand, capturing combined stdout+stderr.

    Shares build_hermes_env() with Gateway/Dashboard so the CLI sees provider
    keys saved via /setup (not just our own os.environ). Never raises — like
    Gateway.start()/Dashboard.start(), a failed spawn (missing binary, bad env)
    is reported as a (rc, message) pair so every caller gets one uniform error
    shape instead of an unhandled exception surfacing as a generic 500.
    """
    try:
        proc = await asyncio.create_subprocess_exec(
            "hermes", *args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            env=build_hermes_env(),
        )
    except OSError as e:
        return 127, f"Could not launch hermes {' '.join(args)}: {e}"
    try:
        raw, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        return 124, f"hermes {' '.join(args)} timed out after {timeout}s"
    return proc.returncode, raw.decode(errors="replace")


async def _hermes_version() -> str:
    """Best-effort `hermes --version`, used only for the restore-time compat hint."""
    try:
        rc, out = await _run_hermes_cli("--version", timeout=15)
        return out.strip() if rc == 0 else "unknown"
    except Exception:
        return "unknown"


def _prune_pre_restore_snapshots() -> None:
    snaps = sorted(BACKUP_DIR.glob("pre-restore-*.zip"), key=lambda p: p.stat().st_mtime, reverse=True)
    for stale in snaps[PRE_RESTORE_KEEP:]:
        try:
            stale.unlink()
        except OSError:
            pass


def _sweep_stale_backup_tmpdirs() -> None:
    """Clean up /tmp/hermes-backup-* left behind by a client aborting a download
    mid-stream (the BackgroundTask cleanup then never runs). Safe: this prefix
    is only ever used by api_backup_download, and /tmp is ephemeral anyway —
    this just bounds growth across many downloads within one long-lived container.
    """
    for stale in Path(tempfile.gettempdir()).glob("hermes-backup-*"):
        shutil.rmtree(stale, ignore_errors=True)


async def api_backup_download(request: Request) -> Response:
    if err := guard(request): return err
    if backup_lock.locked():
        return JSONResponse({"error": "A backup or restore is already in progress"}, status_code=409)
    async with backup_lock:
        tmp_dir = tempfile.mkdtemp(prefix="hermes-backup-")
        zip_path = Path(tmp_dir) / "backup.zip"
        rc, output = await _run_hermes_cli("backup", "-o", str(zip_path))
        if rc != 0 or not zip_path.exists():
            shutil.rmtree(tmp_dir, ignore_errors=True)
            return JSONResponse({"error": "Backup failed", "output": output[-2000:]}, status_code=500)

        # Best-effort manifest entry for the restore-time version hint — never
        # fails the download if this step errors.
        try:
            version = await _hermes_version()
            with zipfile.ZipFile(zip_path, "a") as zf:
                zf.writestr("template_manifest.json", json.dumps({
                    "hermes_version": version,
                    "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                    "template": "hermes-agent-railway-template",
                }))
        except Exception:
            pass

        filename = f"hermes-backup-{int(time.time())}.zip"
        return FileResponse(
            zip_path,
            filename=filename,
            media_type="application/zip",
            background=BackgroundTask(shutil.rmtree, tmp_dir, ignore_errors=True),
        )


async def api_backup_snapshots(request: Request) -> Response:
    if err := guard(request): return err
    out = []
    if BACKUP_DIR.exists():
        for p in sorted(BACKUP_DIR.glob("pre-restore-*.zip"), key=lambda p: p.stat().st_mtime, reverse=True):
            st = p.stat()
            out.append({"name": p.name, "size": st.st_size, "created_at": st.st_mtime})
    return JSONResponse({"snapshots": out})


async def api_backup_snapshot_download(request: Request) -> Response:
    if err := guard(request): return err
    name = request.path_params.get("name", "")
    if not SNAPSHOT_NAME_RE.match(name):
        return Response("Not Found", status_code=404, media_type="text/plain")
    path = BACKUP_DIR / name
    try:
        path.resolve().relative_to(BACKUP_DIR.resolve())
    except ValueError:
        return Response("Not Found", status_code=404, media_type="text/plain")
    if not path.is_file():
        return Response("Not Found", status_code=404, media_type="text/plain")
    return FileResponse(path, filename=name, media_type="application/zip")


async def api_backup_restore(request: Request) -> Response:
    if err := guard(request): return err
    if backup_lock.locked():
        return JSONResponse({"error": "A backup or restore is already in progress"}, status_code=409)

    form = await request.form()
    upload = form.get("file")
    if not isinstance(upload, UploadFile):
        return JSONResponse({"error": "No file uploaded"}, status_code=400)

    async with backup_lock:
        tmp_fd, tmp_name = tempfile.mkstemp(suffix=".zip", prefix="hermes-restore-")
        upload_path = Path(tmp_name)
        try:
            with os.fdopen(tmp_fd, "wb") as f:
                while chunk := await upload.read(1024 * 1024):
                    f.write(chunk)

            if not zipfile.is_zipfile(upload_path):
                return JSONResponse({"error": "Uploaded file is not a valid zip archive"}, status_code=400)

            warning = None
            with zipfile.ZipFile(upload_path) as zf:
                names = {Path(n).name for n in zf.namelist()}
                if not names & {"config.yaml", ".env", "state.db"}:
                    return JSONResponse(
                        {"error": "This doesn't look like a hermes backup (no config.yaml/.env/state.db found)"},
                        status_code=400,
                    )
                if "template_manifest.json" in names:
                    try:
                        manifest = json.loads(zf.read("template_manifest.json"))
                        backup_version = manifest.get("hermes_version", "")
                        current_version = await _hermes_version()
                        if backup_version and current_version != "unknown" and backup_version != current_version:
                            warning = (
                                f"Backup was created with hermes {backup_version}, this deployment runs "
                                f"{current_version} — some settings may not carry over cleanly."
                            )
                    except Exception:
                        pass

            # Safety snapshot BEFORE touching anything live — abort rather than
            # overwrite state with no undo copy behind it.
            BACKUP_DIR.mkdir(parents=True, exist_ok=True)
            # secrets suffix avoids a same-second collision silently clobbering
            # a distinct prior snapshot (two restores fired back-to-back).
            snap_path = BACKUP_DIR / f"pre-restore-{int(time.time())}-{secrets.token_hex(4)}.zip"
            rc, output = await _run_hermes_cli("backup", "-o", str(snap_path))
            if rc != 0:
                return JSONResponse(
                    {"error": "Could not create the pre-restore safety snapshot; restore aborted.",
                     "output": output[-2000:]},
                    status_code=500,
                )
            _prune_pre_restore_snapshots()

            await gw.stop()
            await dash.stop()
            try:
                rc, output = await _run_hermes_cli("import", str(upload_path), "--force")
            finally:
                # Always bring the dashboard back; only auto-start the gateway if
                # the (possibly just-restored) config is actually complete — same
                # rule auto_start() uses on boot. This runs even if the import
                # itself failed, so a bad upload doesn't leave the bot down too.
                await dash.start()
                if is_config_complete():
                    await gw.start()

            if rc != 0:
                return JSONResponse({"error": "Restore failed", "output": output[-2000:]}, status_code=500)

            resp = {"ok": True, "output": output[-2000:]}
            if warning:
                resp["warning"] = warning
            return JSONResponse(resp)
        except Exception as e:
            return JSONResponse({"error": str(e)}, status_code=500)
        finally:
            upload_path.unlink(missing_ok=True)


# ── Reverse proxy → Hermes dashboard ──────────────────────────────────────────
_WIDGET_LINK_STYLE = (
    "background:#ffffff;"
    "border:1px solid #000000;border-radius:6px;padding:6px 12px;"
    "color:#000000;text-decoration:none;display:inline-flex;"
    "align-items:center;gap:6px;font-weight:600;"
)
BACK_TO_SETUP_WIDGET = (
    '<div id="hermes-back-widget" style="position:fixed;bottom:14px;right:14px;'
    'z-index:99999;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;'
    'font-size:11px;display:flex;gap:8px;">'
    f'<a href="/" style="{_WIDGET_LINK_STYLE}">'
    '<span style="width:6px;height:6px;border-radius:999px;background:#000000;'
    '"></span>Prism 8</a>'
    f'<a href="/logout" style="{_WIDGET_LINK_STYLE}">Sign out</a>'
    '</div>'
)

DASHBOARD_UNAVAILABLE_HTML = """<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Dashboard starting…</title>
<style>body{background:#ffffff;color:#000000;font-family:'JetBrains Mono','SFMono-Regular',Consolas,monospace;
display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:20px}
.card{max-width:480px;padding:32px;border:1px solid #000000;border-radius:16px;
background:#ffffff;text-align:center;box-shadow:0 10px 30px rgba(0,0,0,0.06)}
h1{font-size:16px;color:#000000;margin:0 0 12px;font-weight:700}
p{font-size:13px;color:#737373;line-height:1.6;margin:0 0 16px}
a{color:#ffffff;background:#000000;text-decoration:none;border:1px solid #000000;border-radius:8px;
padding:9px 16px;font-size:12px;font-weight:600;display:inline-block;transition:background .15s}
a:hover{background:#262626}</style></head>
<body><div class="card">
<h1>⚠ Hermes dashboard starting…</h1>
<p>The native Hermes daemon is initializing on port %d.<br>
It will be ready in a few moments.</p>
<a href="/">← Back to Prism 8</a>
</div>
<script>setTimeout(()=>location.reload(),4000);</script>
</body></html>""" % HERMES_DASHBOARD_PORT

TOKENIZATION_UNAVAILABLE_HTML = """<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Prism 8 starting…</title>
<style>body{background:#ffffff;color:#000000;font-family:'JetBrains Mono','SFMono-Regular',Consolas,monospace;
display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:20px}
.card{max-width:480px;padding:32px;border:1px solid #000000;border-radius:16px;
background:#ffffff;text-align:center;box-shadow:0 10px 30px rgba(0,0,0,0.06)}
h1{font-size:16px;color:#000000;margin:0 0 12px;font-weight:700}
p{font-size:13px;color:#737373;line-height:1.6;margin:0 0 16px}
a{color:#ffffff;background:#000000;text-decoration:none;border:1px solid #000000;border-radius:8px;
padding:9px 16px;font-size:12px;font-weight:600;display:inline-block;transition:background .15s}
a:hover{background:#262626}</style></head>
<body><div class="card">
<h1>Prism 8 Platform is starting</h1>
<p>The Next.js production server is initializing. This page will retry automatically.</p>
<a href="/hermes?force=1">← Open Hermes Console</a>
</div><script>setTimeout(()=>location.reload(),3000);</script></body></html>"""


async def _proxy_to_dashboard(request: Request) -> Response:
    """Forward an authenticated request to the Hermes dashboard subprocess.

    Assumes edge auth (basic auth middleware) has already validated the caller.
    HTTP-only: the native Hermes dashboard does not use WebSockets.
    """
    client = get_http_client()
    target = f"{HERMES_DASHBOARD_URL}{request.url.path}"
    if request.url.query:
        target = f"{target}?{request.url.query}"

    req_headers = {
        k: v for k, v in request.headers.items()
        if k.lower() not in HOP_BY_HOP
    }
    body = await request.body()

    try:
        upstream = await client.request(
            request.method,
            target,
            headers=req_headers,
            content=body,
        )
    except (httpx.ConnectError, httpx.ConnectTimeout):
        return HTMLResponse(DASHBOARD_UNAVAILABLE_HTML, status_code=503)
    except httpx.RequestError as e:
        print(f"[proxy] upstream error for {request.method} {request.url.path}: {e}", flush=True)
        return HTMLResponse(DASHBOARD_UNAVAILABLE_HTML, status_code=502)

    # Surface non-2xx responses from hermes into Railway logs so we can
    # diagnose 401/500s without needing browser DevTools access.
    if upstream.status_code >= 400:
        body_snip = upstream.content[:200].decode("utf-8", errors="replace")
        print(
            f"[proxy] {request.method} {request.url.path} -> {upstream.status_code} "
            f"body={body_snip!r}",
            flush=True,
        )

    # Strip hop-by-hop and length/encoding headers — Starlette recomputes them.
    resp_headers = {
        k: v for k, v in upstream.headers.items()
        if k.lower() not in HOP_BY_HOP
        and k.lower() not in ("content-encoding", "content-length", "date")
    }

    content = upstream.content
    content_type = upstream.headers.get("content-type", "").lower()

    # Inject the "← Setup" widget into HTML pages so users can always return.
    if "text/html" in content_type and b"</body>" in content:
        try:
            text = content.decode("utf-8", errors="replace")
            text = text.replace("</body>", BACK_TO_SETUP_WIDGET + "</body>", 1)
            content = text.encode("utf-8")
        except Exception:
            pass  # on any error, fall back to raw upstream content

    return Response(
        content=content,
        status_code=upstream.status_code,
        headers=resp_headers,
    )


async def _proxy_to_tokenization(request: Request) -> Response:
    """Forward a public request to the loopback-only Next.js server."""
    client = get_http_client()
    target = f"{TOKENIZATION_URL}{request.url.path}"
    if request.url.query:
        target = f"{target}?{request.url.query}"

    req_headers = {
        k: v for k, v in request.headers.items()
        if k.lower() not in HOP_BY_HOP
    }
    req_headers["x-forwarded-host"] = request.headers.get("host", "")
    req_headers["x-forwarded-proto"] = request.url.scheme
    body = await request.body()

    try:
        upstream = await client.request(
            request.method,
            target,
            headers=req_headers,
            content=body,
        )
    except (httpx.ConnectError, httpx.ConnectTimeout):
        return HTMLResponse(TOKENIZATION_UNAVAILABLE_HTML, status_code=503)
    except httpx.RequestError as e:
        print(
            f"[tokenization-proxy] upstream error for {request.method} "
            f"{request.url.path}: {e}",
            flush=True,
        )
        return HTMLResponse(TOKENIZATION_UNAVAILABLE_HTML, status_code=502)

    if upstream.status_code >= 400:
        body_snip = upstream.content[:200].decode("utf-8", errors="replace")
        print(
            f"[tokenization-proxy] {request.method} {request.url.path} "
            f"-> {upstream.status_code} body={body_snip!r}",
            flush=True,
        )

    resp_headers = {
        k: v for k, v in upstream.headers.items()
        if k.lower() not in HOP_BY_HOP
        and k.lower() not in ("content-encoding", "content-length", "date")
    }
    location = resp_headers.get("location")
    if location and location.startswith(TOKENIZATION_URL):
        resp_headers["location"] = location.removeprefix(TOKENIZATION_URL) or "/"

    return Response(
        content=upstream.content,
        status_code=upstream.status_code,
        headers=resp_headers,
    )


async def route_tokenization(request: Request) -> Response:
    return await _proxy_to_tokenization(request)


async def route_hermes_dashboard(request: Request) -> Response:
    """GET /hermes: first-visit smart redirect, otherwise proxy to the dashboard.

    - Unconfigured + bare GET `/hermes` → bounce to `/setup` so new users land
      on the wizard instead of a half-empty dashboard.
    - Sidebar / in-app links pass `?force=1` to opt out of that redirect —
      users who explicitly want the dashboard (e.g. to set providers via
      the Keys tab) can still reach it without saving config first.
    - Non-GET (SPA API calls, etc.) always proxy through.
    """
    if err := guard(request): return err
    if (request.method == "GET"
            and request.query_params.get("force") != "1"
            and not is_config_complete()):
        return RedirectResponse("/setup", status_code=302)
    return await _proxy_to_dashboard(request)


async def route_proxy(request: Request) -> Response:
    """Catch-all: forward any unmatched path to the Hermes dashboard."""
    if err := guard(request): return err
    return await _proxy_to_dashboard(request)


async def route_setup_404(request: Request) -> Response:
    """Typos under /setup/* should 404 here — not fall through to the proxy."""
    if err := guard(request): return err
    return Response("Not Found", status_code=404, media_type="text/plain")


# ── App lifecycle ─────────────────────────────────────────────────────────────
async def auto_start():
    if is_config_complete():
        asyncio.create_task(gw.start())
        # The pr profile shares the operator's provider/model, so the same
        # readiness check applies — no point starting a read-only chat agent
        # that can't reach any LLM either.
        asyncio.create_task(gw_pr.start())
    else:
        print("[server] Config incomplete — gateway not started. Configure provider + model in the admin UI.", flush=True)


async def liveness_sweep_loop():
    """Drive deterministic expiry processing independently from LLM/cron availability."""
    await asyncio.sleep(5)
    last_error = ""
    while True:
        try:
            response = await get_http_client().post(
                f"{TOKENIZATION_URL}/api/liveness/process",
                headers={"X-Tokenization-Agent-Secret": TOKENIZATION_AGENT_SECRET},
                timeout=120.0,
            )
            if response.is_error:
                error = f"HTTP {response.status_code}: {response.text[:200]}"
                if error != last_error:
                    print(f"[liveness] sweep failed: {error}", flush=True)
                last_error = error
            else:
                last_error = ""
                body = response.json()
                if body.get("processed"):
                    print(f"[liveness] processed {body['processed']} expired holder(s)", flush=True)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            error = repr(exc)
            if error != last_error:
                print(f"[liveness] sweep unavailable: {error}", flush=True)
            last_error = error
        await asyncio.sleep(LIVENESS_SWEEP_INTERVAL_SECONDS)


@asynccontextmanager
async def lifespan(app):
    _sweep_stale_backup_tmpdirs()
    # MCP servers and the token-request webhook are deployment capabilities,
    # not optional provider settings. Materialise them even when model setup is
    # incomplete so they appear in the dashboard and are ready once a provider
    # is configured.
    write_config_yaml(read_env(ENV_FILE))
    # Dashboard runs always — it's the user-facing UI after setup is done,
    # and it's independent of gateway state.
    asyncio.create_task(dash.start())
    asyncio.create_task(tokenization.start())
    liveness_task = asyncio.create_task(liveness_sweep_loop())
    await auto_start()
    try:
        yield
    finally:
        liveness_task.cancel()
        try:
            await liveness_task
        except asyncio.CancelledError:
            pass
        await asyncio.gather(
            gw.stop(),
            gw_pr.stop(),
            dash.stop(),
            tokenization.stop(),
            return_exceptions=True,
        )
        global _http_client
        if _http_client is not None:
            await _http_client.aclose()
            _http_client = None


# ── WebSocket reverse proxy ──────────────────────────────────────────────────
# The hermes dashboard exposes several WebSocket endpoints when started with
# --tui. The browser SPA opens these and they must flow through our reverse
# proxy. /api/pub is opened only by the PTY child against loopback and is
# intentionally NOT proxied — exposing it would let an authed user spam events
# into channels. It lives at /api/pub (not under /api/plugins/), so the plugin
# prefix route below does not match it.
#
#   /api/pty                  binary stream — embedded TUI keystrokes/output
#   /api/ws                   JSON-RPC      — gateway sidecar driving Chat metadata
#   /api/events               text frames   — dashboard subscriber for /api/pub fan-out
#   /api/plugins/<name>/...   plugin-contributed sockets. Mounted by hermes
#                             under /api/plugins/<name>/ (web_server.
#                             _mount_plugin_api_routes), e.g. kanban's
#                             /api/plugins/kanban/events live task feed. Added
#                             in v0.15 — without a proxy route Starlette 403s
#                             the upgrade and the SPA retries in a tight loop.
#
# Auth model (matches the HTTP proxy):
#   * Edge: our HMAC cookie via _is_authenticated. WebSocket inherits .cookies
#     from starlette HTTPConnection so the same helper works unchanged.
#   * Upstream: hermes's own ?token=<_SESSION_TOKEN> query param. The SPA
#     fetches that token via /api/auth/session-token and includes it in the
#     WS URL, so we just forward path + query verbatim.
PROXIED_WS_PATHS = ("/api/pty", "/api/ws", "/api/events", "/api/plugins/*")


async def _ws_pump_client_to_upstream(
    client: WebSocket,
    upstream: websockets.WebSocketClientProtocol,
) -> None:
    """Forward client → upstream until the client side disconnects.

    Handles both binary (PTY bytes) and text (JSON-RPC) frames.
    """
    try:
        while True:
            msg = await client.receive()
            if msg.get("type") == "websocket.disconnect":
                return
            data = msg.get("bytes")
            if data is not None:
                await upstream.send(data)
                continue
            text = msg.get("text")
            if text is not None:
                await upstream.send(text)
    except (WebSocketDisconnect, websockets.exceptions.ConnectionClosed):
        return
    except Exception as e:
        print(f"[ws-proxy] client→upstream error on {client.url.path}: {e!r}", flush=True)
        return


async def _ws_pump_upstream_to_client(
    upstream: websockets.WebSocketClientProtocol,
    client: WebSocket,
) -> None:
    """Forward upstream → client until upstream closes."""
    try:
        async for msg in upstream:
            if isinstance(msg, bytes):
                await client.send_bytes(msg)
            else:
                await client.send_text(msg)
    except (websockets.exceptions.ConnectionClosed, WebSocketDisconnect):
        return
    except Exception as e:
        print(f"[ws-proxy] upstream→client error on {client.url.path}: {e!r}", flush=True)
        return


async def ws_proxy(websocket: WebSocket) -> None:
    """Reverse-proxy a single WebSocket from browser → hermes dashboard.

    Order matters: connect upstream BEFORE accepting the client. If hermes
    is wedged or rejects the upgrade, we close the client with a meaningful
    code instead of accepting and then dropping silently.

    Connection lifecycle:
      1. Verify edge cookie auth → 4401 close on failure
      2. Open upstream WS with bounded open_timeout → 1011 on failure
      3. Accept client
      4. Spawn two pump tasks (bidirectional byte forwarding)
      5. When either direction ends (client navigates away, upstream PTY
         exits, etc.), cancel the other task and close both sockets
    """
    # 1. Edge auth.
    if not _is_authenticated(websocket):
        # Close before accept — browser sees the handshake fail (expected
        # for unauthenticated calls).
        await websocket.close(code=4401)
        return

    # 2. Build upstream URL preserving the SPA's path + query (the query
    #    contains the hermes session token + channel id).
    path = websocket.url.path
    qs = websocket.url.query
    upstream_url = f"ws://{HERMES_DASHBOARD_HOST}:{HERMES_DASHBOARD_PORT}{path}"
    if qs:
        upstream_url = f"{upstream_url}?{qs}"

    try:
        upstream = await websockets.connect(
            upstream_url,
            open_timeout=5,
            # Don't forward client cookies/headers — hermes WS auth is
            # purely token-based via the URL, and forwarding random
            # headers risks future upstream surprises.
        )
    except (asyncio.TimeoutError, OSError, websockets.exceptions.WebSocketException) as e:
        # Hermes dashboard down, restarting, or rejected the upgrade
        # (e.g. bad/missing session token).
        print(f"[ws-proxy] upstream connect failed for {path}: {e!r}", flush=True)
        # 1011 = internal error; client SPA will surface a generic close.
        await websocket.close(code=1011)
        return

    # 3. Both sides ready — accept and start pumping.
    await websocket.accept()

    pump_in = asyncio.create_task(_ws_pump_client_to_upstream(websocket, upstream))
    pump_out = asyncio.create_task(_ws_pump_upstream_to_client(upstream, websocket))

    try:
        # First side to finish wins; cancel the other.
        done, pending = await asyncio.wait(
            (pump_in, pump_out),
            return_when=asyncio.FIRST_COMPLETED,
        )
        for task in pending:
            task.cancel()
            try:
                await task
            except (asyncio.CancelledError, Exception):
                pass
    finally:
        # websockets.connect() outside `async with` doesn't auto-close;
        # do it explicitly. Same for the client side if still open.
        try:
            await upstream.close()
        except Exception:
            pass
        if websocket.client_state == WebSocketState.CONNECTED:
            try:
                await websocket.close()
            except Exception:
                pass


ANY_METHOD = ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"]

routes = [
    # Public — no auth required.
    Route("/health",                            route_health),
    Route("/login",                             page_login,          methods=["GET"]),
    Route("/login",                             login_post,          methods=["POST"]),
    Route("/logout",                            logout),

    # Our setup wizard + management API, all under /setup/* (cookie-auth guarded).
    Route("/setup",                             page_index),
    Route("/setup/",                            page_index),
    Route("/setup/api/config",                  api_config_get,      methods=["GET"]),
    Route("/setup/api/config",                  api_config_put,      methods=["PUT"]),
    Route("/setup/api/status",                  api_status),
    Route("/setup/api/logs",                    api_logs),
    Route("/setup/api/gateway/start",           api_gw_start,        methods=["POST"]),
    Route("/setup/api/gateway/stop",            api_gw_stop,         methods=["POST"]),
    Route("/setup/api/gateway/restart",         api_gw_restart,      methods=["POST"]),
    Route("/setup/api/config/reset",            api_config_reset,    methods=["POST"]),
    Route("/setup/api/pairing/pending",         api_pairing_pending),
    Route("/setup/api/pairing/approve",         api_pairing_approve, methods=["POST"]),
    Route("/setup/api/pairing/deny",            api_pairing_deny,    methods=["POST"]),
    Route("/setup/api/pairing/approved",        api_pairing_approved),
    Route("/setup/api/pairing/revoke",          api_pairing_revoke,  methods=["POST"]),
    Route("/setup/api/oauth/xai/start",         api_oauth_xai_start,  methods=["POST"]),
    Route("/setup/api/oauth/xai/status",        api_oauth_xai_status),
    Route("/setup/api/oauth/xai",               api_oauth_xai_delete, methods=["DELETE"]),
    Route("/setup/api/backup/download",         api_backup_download),
    Route("/setup/api/backup/restore",          api_backup_restore,  methods=["POST"]),
    Route("/setup/api/backup/snapshots",        api_backup_snapshots),
    Route("/setup/api/backup/snapshots/{name}", api_backup_snapshot_download),

    # /setup/* typos return a real 404 — not a silent proxy fallthrough.
    Route("/setup/{path:path}",                 route_setup_404,     methods=ANY_METHOD),

    # Public Next.js Tokenization UI + API — this app owns the root domain now,
    # so its own known page/API/asset paths are claimed explicitly here (all
    # unauthenticated — see route_tokenization). Everything NOT listed here
    # falls through to the Hermes dashboard catch-all at the bottom of this
    # list, exactly as / used to before Tokenization took over root.
    Route("/",                                  route_tokenization,  methods=ANY_METHOD),
    Route("/tokens",                            route_tokenization,  methods=ANY_METHOD),
    Route("/tokens/{path:path}",                route_tokenization,  methods=ANY_METHOD),
    Route("/api/tokens",                        route_tokenization,  methods=ANY_METHOD),
    Route("/api/tokens/{path:path}",            route_tokenization,  methods=ANY_METHOD),
    Route("/api/evm",                           route_tokenization,  methods=ANY_METHOD),
    Route("/api/evm/{path:path}",               route_tokenization,  methods=ANY_METHOD),
    Route("/api/worldid",                       route_tokenization,  methods=ANY_METHOD),
    Route("/api/worldid/{path:path}",           route_tokenization,  methods=ANY_METHOD),
    Route("/api/x402",                          route_tokenization,  methods=ANY_METHOD),
    Route("/api/x402/{path:path}",              route_tokenization,  methods=ANY_METHOD),
    Route("/api/properties",                    route_tokenization,  methods=ANY_METHOD),
    Route("/api/properties/{path:path}",        route_tokenization,  methods=ANY_METHOD),
    Route("/api/yield",                         route_tokenization,  methods=ANY_METHOD),
    Route("/api/yield/{path:path}",             route_tokenization,  methods=ANY_METHOD),
    Route("/api/rent",                          route_tokenization,  methods=ANY_METHOD),
    Route("/api/rent/{path:path}",              route_tokenization,  methods=ANY_METHOD),
    Route("/api/agent",                         route_tokenization,  methods=ANY_METHOD),
    Route("/api/agent/{path:path}",             route_tokenization,  methods=ANY_METHOD),
    Route("/api/subgraph",                      route_tokenization,  methods=ANY_METHOD),
    Route("/api/subgraph/{path:path}",          route_tokenization,  methods=ANY_METHOD),
    Route("/api/token-requests",                route_tokenization,  methods=ANY_METHOD),
    Route("/api/token-requests/{path:path}",    route_tokenization,  methods=ANY_METHOD),
    Route("/api/liveness",                      route_tokenization,  methods=ANY_METHOD),
    Route("/api/liveness/{path:path}",          route_tokenization,  methods=ANY_METHOD),
    Route("/.well-known/{path:path}",           route_tokenization,  methods=ANY_METHOD),
    Route("/api/runtime-config",                route_tokenization,  methods=ANY_METHOD),
    Route("/_next/{path:path}",                 route_tokenization,  methods=ANY_METHOD),
    Route("/favicon.ico",                       route_tokenization,  methods=ANY_METHOD),
    Route("/file.svg",                          route_tokenization,  methods=ANY_METHOD),
    Route("/globe.svg",                         route_tokenization,  methods=ANY_METHOD),
    Route("/next.svg",                          route_tokenization,  methods=ANY_METHOD),
    Route("/vercel.svg",                        route_tokenization,  methods=ANY_METHOD),
    Route("/window.svg",                        route_tokenization,  methods=ANY_METHOD),
    Route("/demo-simulation.html",               route_tokenization,  methods=ANY_METHOD),
    Route("/brand/{path:path}",                 route_tokenization,  methods=ANY_METHOD),

    # Reverse-proxy hermes's dashboard WebSockets (Chat tab + sidecar).
    # WebSocketRoute is matched independently of HTTP routes, so order
    # relative to the catch-all HTTP `Route("/{path:path}", ...)` below
    # doesn't matter — but listing them as a group keeps the surface
    # area auditable. Only paths in PROXIED_WS_PATHS are forwarded;
    # /api/pub is intentionally omitted (not under /api/plugins/, so the
    # prefix route below does not match it).
    WebSocketRoute("/api/pty",                  ws_proxy),
    WebSocketRoute("/api/ws",                   ws_proxy),
    WebSocketRoute("/api/events",               ws_proxy),
    # Plugin-contributed sockets, mounted by hermes under /api/plugins/<name>/
    # (e.g. kanban's /api/plugins/kanban/events). Prefix-matched so new plugin
    # WS endpoints in future hermes releases proxy without re-touching this list.
    WebSocketRoute("/api/plugins/{path:path}",  ws_proxy),

    # Hermes admin dashboard entry point (cookie-auth guarded): redirect to
    # /setup if unconfigured, otherwise proxy the dashboard's index page. The
    # dashboard is an upstream SPA whose own asset/API references are
    # root-relative and can't be moved under a prefix, so this is only the
    # first-load entry — its JS/CSS chunks and API calls are unprefixed and
    # fall through to the catch-all below, same as before Tokenization owned root.
    Route("/hermes",                            route_hermes_dashboard, methods=ANY_METHOD),

    # Catch-all: everything else proxies to the Hermes dashboard subprocess
    # (its static assets, /api/* REST endpoints, and SPA client-side routes
    # on a hard refresh).
    Route("/{path:path}",                       route_proxy,         methods=ANY_METHOD),
]

# No middleware — auth is enforced per-handler via guard(). This keeps /health
# and /login truly unauthenticated without middleware gymnastics.
app = Starlette(routes=routes, lifespan=lifespan)

if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", "8080"))
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    config = uvicorn.Config(app, host="0.0.0.0", port=port, log_level="info", loop="asyncio")
    server = uvicorn.Server(config)

    def _shutdown():
        loop.create_task(gw.stop())
        loop.create_task(dash.stop())
        server.should_exit = True

    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, _shutdown)

    loop.run_until_complete(server.serve())
