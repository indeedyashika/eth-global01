#!/usr/bin/env node
// Deploys to Graph Studio using GRAPH_DEPLOY_KEY from the environment instead
// of the interactive `graph auth` flow, so the whole add/remove-token ->
// deploy pipeline can be driven non-interactively (e.g. from the MCP server,
// whose tool result -- including this script's stdout -- is read by an LLM
// agent, not a human).
//
// Every deploy gets a fresh --version-label, so `graph deploy`'s own
// "Queries (HTTP): https://.../<name>/<version>" success line is a DIFFERENT
// URL every time. Earlier we surfaced that line (plus a derived
// "version/latest" one) straight into the tool output "for reference" --
// in practice an agent reading it treated the ever-changing pinned URL as an
// actionable "update SUBGRAPH_URL to this" instruction and relayed that to
// the user, even though SUBGRAPH_URL should be set ONCE to the STABLE
// "<id>/<name>/version/latest" form (see README) and never touched again.
// So we now redact the pinned URL out of what the agent sees and replace it
// with an explicit "nothing to do" statement instead of a URL to misread.
//
// We also strip ANSI/CSI escape codes (graph-cli colorizes its output even
// when not attached to a TTY). Left in, they render fine in a real terminal
// but corrupt anything that regex-parses this stdout downstream -- notably
// the MCP server extracting the "Build completed: Qm<hash>" deployment hash
// to verify a redeploy went live, which a raw `\x1b[34m` prefix glued onto
// the hash silently broke (looked like a permanent mismatch, not a parsing bug).
import { execFileSync } from "node:child_process";

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");

const deployKey = process.env.GRAPH_DEPLOY_KEY;
const subgraphName = process.env.GRAPH_SUBGRAPH_NAME || "sepolia-test";

if (!deployKey) {
  console.error(
    "GRAPH_DEPLOY_KEY is not set. Set it in the environment (or subgraph/.env for local use) -- " +
      "get it from the subgraph's page in Graph Studio."
  );
  process.exit(1);
}

const versionLabel = process.env.GRAPH_VERSION_LABEL || `auto-${Date.now()}`;

let output;
try {
  output = execFileSync(
    "npx",
    [
      "graph",
      "deploy",
      "--node",
      "https://api.studio.thegraph.com/deploy/",
      "--deploy-key",
      deployKey,
      "--version-label",
      versionLabel,
      subgraphName,
    ],
    { encoding: "utf8" }
  );
} catch (err) {
  // Surface whatever the CLI printed before failing, then re-throw so the
  // caller (npm, or the MCP server's execFile wrapper) sees a non-zero exit.
  process.stdout.write(stripAnsi(err.stdout ?? ""));
  process.stderr.write(stripAnsi(err.stderr ?? ""));
  process.exit(err.status ?? 1);
}

output = stripAnsi(output);

// Redact the version-pinned "Queries (HTTP)" URL before echoing -- it's a
// different URL on every deploy, and an agent reading raw tool output tends
// to treat any URL that looks new as something to relay/act on. Replace it
// with an unambiguous statement instead so there's nothing to misread.
const redacted = output.replace(
  /^(\s*Queries \(HTTP\):\s*).*$/m,
  "$1(omitted -- irrelevant; SUBGRAPH_URL should already be the stable .../version/latest URL, which needs no update after this or any future deploy)"
);
process.stdout.write(redacted);
