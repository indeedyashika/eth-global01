import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

interface SubgraphQueryBody {
  query?: string;
  variables?: Record<string, unknown>;
  action?: "top_holders" | "transfers" | "token_info" | "status";
  tokenAddress?: string;
}

export async function GET() {
  const subgraphUrl = process.env.SUBGRAPH_URL?.trim();
  const isLive = Boolean(subgraphUrl && subgraphUrl.startsWith("http"));

  if (!isLive) {
    return NextResponse.json({
      status: "ok",
      isLive: false,
      subgraphUrl: null,
      mode: "unconfigured",
      schemaEntities: ["Token", "Account", "Transfer"],
      mcpTools: {
        read: [
          "get_token_info",
          "get_biggest_transfer",
          "get_top_holders",
          "get_recent_transfers",
          "get_account_balance",
          "get_latest_sepolia_block",
          "get_tracked_tokens",
          "get_deployment_status",
        ],
        write: ["add_token_source", "set_token_sources"],
      },
      notice:
        "The Graph Subgraph endpoint is not configured in environment (SUBGRAPH_URL). Live indexed queries require a deployed Subgraph endpoint in Graph Studio.",
    });
  }

  // Live query against upstream Subgraph endpoint
  try {
    const metaQuery = `{ _meta { deployment block { number timestamp } hasIndexingErrors } }`;
    const upstreamRes = await fetch(subgraphUrl!, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: metaQuery }),
    });

    const upstreamData = await upstreamRes.json();
    return NextResponse.json({
      status: "ok",
      isLive: true,
      subgraphUrl,
      mode: "live-studio",
      meta: upstreamData.data?._meta || null,
      schemaEntities: ["Token", "Account", "Transfer"],
      mcpTools: {
        read: [
          "get_token_info",
          "get_biggest_transfer",
          "get_top_holders",
          "get_recent_transfers",
          "get_account_balance",
          "get_latest_sepolia_block",
          "get_tracked_tokens",
          "get_deployment_status",
        ],
        write: ["add_token_source", "set_token_sources"],
      },
    });
  } catch (error: any) {
    return NextResponse.json({
      status: "ok",
      isLive: true,
      subgraphUrl,
      mode: "live-studio",
      error: `Failed to query upstream Subgraph: ${error.message || String(error)}`,
      schemaEntities: ["Token", "Account", "Transfer"],
    });
  }
}

export async function POST(req: Request) {
  try {
    const body: SubgraphQueryBody = await req.json();
    const subgraphUrl = process.env.SUBGRAPH_URL?.trim();

    if (!subgraphUrl || !subgraphUrl.startsWith("http")) {
      return NextResponse.json(
        {
          error:
            "The Graph Subgraph is not configured in environment (SUBGRAPH_URL). Live indexed data unavailable.",
          code: "SUBGRAPH_UNCONFIGURED",
          status: 503,
        },
        { status: 503 }
      );
    }

    let query = body.query;
    if (!query) {
      if (body.action === "top_holders") {
        query = `{ accounts(orderBy: balance, orderDirection: desc, first: 20) { id balance } }`;
      } else if (body.action === "transfers") {
        query = `{ transfers(orderBy: blockTimestamp, orderDirection: desc, first: 20) { id from { id } to { id } value blockNumber transactionHash } }`;
      } else if (body.action === "token_info") {
        query = `{ tokens { id name symbol decimals } }`;
      } else {
        query = `{ tokens { id name symbol } }`;
      }
    }

    const response = await fetch(subgraphUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query,
        variables: body.variables || {},
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      return NextResponse.json(
        {
          error: `Upstream Subgraph returned HTTP ${response.status}: ${errText}`,
          code: "UPSTREAM_SUBGRAPH_ERROR",
        },
        { status: 502 }
      );
    }

    const resData = await response.json();

    try {
      const { recordStep9Graph } = await import("@/lib/workflow/judgeWorkflow");
      recordStep9Graph({
        subgraphUrl: subgraphUrl!,
        subgraphStatus: "LIVE",
        queryResult: resData.data,
        success: true,
      });
    } catch (e) {
      console.warn("[subgraph route] Could not update step 9 workflow state:", e);
    }

    return NextResponse.json(resData);
  } catch (error: any) {
    return NextResponse.json(
      {
        error: error.message || "Failed to execute subgraph query",
        code: "SUBGRAPH_QUERY_ERROR",
      },
      { status: 500 }
    );
  }
}
