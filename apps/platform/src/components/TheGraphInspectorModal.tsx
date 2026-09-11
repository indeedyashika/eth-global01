"use client";

import { useState, useEffect } from "react";

interface TheGraphInspectorModalProps {
  isOpen: boolean;
  onClose: () => void;
}

interface HolderData {
  address: string;
  formattedBalance: string;
  sharePercentage: string;
  monthlyYieldUsd: number;
}

interface TransferData {
  id: string;
  from: { address: string };
  to: { address: string };
  formattedValue: string;
  isMintOrBurn: boolean;
  blockNumber: string;
  transactionHash: string;
}

export function TheGraphInspectorModal({ isOpen, onClose }: TheGraphInspectorModalProps) {
  const [activeTab, setActiveTab] = useState<"query" | "mcp">("query");
  const [queryType, setQueryType] = useState<"holders" | "transfers" | "meta">("holders");
  const [loading, setLoading] = useState(false);
  const [subgraphData, setSubgraphData] = useState<any>(null);

  useEffect(() => {
    if (!isOpen) return;
    fetchData();
  }, [isOpen, queryType]);

  const fetchData = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/subgraph");
      const contentType = res.headers.get("content-type") || "";
      if (contentType.includes("application/json")) {
        const json = await res.json();
        setSubgraphData(json);
      } else {
        const text = await res.text();
        try {
          setSubgraphData(JSON.parse(text));
        } catch {
          console.error("Non-JSON response from /api/subgraph");
        }
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-md p-4 overflow-y-auto animate-fade-in font-mono">
      <div className="relative w-full max-w-4xl rounded-3xl border border-neutral-300 bg-white p-6 sm:p-8 text-black shadow-2xl overflow-hidden max-h-[90vh] flex flex-col">
        {/* Modal Header */}
        <div className="flex items-start justify-between border-b border-neutral-200 pb-5">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-neutral-100 border border-neutral-300 text-black">
              <svg className="h-6 w-6" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z" />
              </svg>
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-2xl font-bold text-black tracking-tight">The Graph AI Integration</h3>
                <span className="rounded-full bg-neutral-100 px-3 py-0.5 text-xs font-semibold text-black border border-neutral-300">
                  Dual MCP + GraphQL
                </span>
              </div>
              <p className="text-sm text-neutral-600 mt-1">
                Live Subgraph indexing real-estate tokens & fueling autonomous Superfluid cashflow distribution
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-xl border border-neutral-300 bg-neutral-50 p-2.5 text-neutral-500 hover:text-black hover:bg-neutral-100 transition cursor-pointer"
          >
            ✕
          </button>
        </div>

        {/* Navigation Tabs */}
        <div className="flex border-b border-neutral-200 mt-4 text-sm font-semibold gap-2">
          <button
            onClick={() => setActiveTab("query")}
            className={`px-5 py-3 rounded-t-xl transition-colors cursor-pointer text-sm ${
              activeTab === "query"
                ? "border-b-2 border-black text-black bg-neutral-100 font-bold"
                : "text-neutral-500 hover:text-black"
            }`}
          >
            Live GraphQL Query Runner
          </button>
          <button
            onClick={() => setActiveTab("mcp")}
            className={`px-5 py-3 rounded-t-xl transition-colors cursor-pointer text-sm ${
              activeTab === "mcp"
                ? "border-b-2 border-black text-black bg-neutral-100 font-bold"
                : "text-neutral-500 hover:text-black"
            }`}
          >
            Subgraph MCP Tooling
          </button>
        </div>

        {/* Tab 1: Live GraphQL Query Runner */}
        {activeTab === "query" && (
          <div className="mt-4 flex-1 overflow-y-auto space-y-4 pr-1 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2 bg-neutral-50 p-3.5 rounded-2xl border border-neutral-300">
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold uppercase tracking-wider text-neutral-600">Endpoint:</span>
                <span className="font-mono text-sm text-black truncate max-w-md font-semibold">
                  {subgraphData?.subgraphUrl || "https://api.studio.thegraph.com/query/.../version/latest"}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <span className="inline-flex h-2.5 w-2.5 rounded-full bg-black animate-pulse" />
                <span className="text-sm text-black font-mono font-bold">
                  {subgraphData?.mode === "live-studio" ? "Studio Live" : "Indexed Simulation"}
                </span>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm text-neutral-700 font-semibold">Quick Queries:</span>
              <button
                onClick={() => setQueryType("holders")}
                className={`rounded-xl px-4 py-2 text-xs sm:text-sm font-semibold transition cursor-pointer ${
                  queryType === "holders"
                    ? "bg-black text-white font-bold border border-black"
                    : "bg-white border border-neutral-300 text-neutral-800 hover:bg-neutral-100"
                }`}
              >
                Top Token Holders (Yield Allocation)
              </button>
              <button
                onClick={() => setQueryType("transfers")}
                className={`rounded-xl px-4 py-2 text-xs sm:text-sm font-semibold transition cursor-pointer ${
                  queryType === "transfers"
                    ? "bg-black text-white font-bold border border-black"
                    : "bg-white border border-neutral-300 text-neutral-800 hover:bg-neutral-100"
                }`}
              >
                Recent Transfers (Mints / Secondary)
              </button>
              <button
                onClick={() => setQueryType("meta")}
                className={`rounded-xl px-4 py-2 text-xs sm:text-sm font-semibold transition cursor-pointer ${
                  queryType === "meta"
                    ? "bg-black text-white font-bold border border-black"
                    : "bg-white border border-neutral-300 text-neutral-800 hover:bg-neutral-100"
                }`}
              >
                Subgraph Metadata (_meta)
              </button>
            </div>

            {/* Query Content Display */}
            {queryType === "holders" && (
              <div className="space-y-3">
                <div className="rounded-2xl border border-neutral-300 bg-white p-5">
                  <div className="text-sm font-semibold text-neutral-700 mb-3 flex items-center justify-between">
                    <span>Indexed Entities: <code className="bg-neutral-100 border border-neutral-300 px-1.5 py-0.5 rounded text-black font-mono font-bold">Account</code> &amp; <code className="bg-neutral-100 border border-neutral-300 px-1.5 py-0.5 rounded text-black font-mono font-bold">Token</code></span>
                    <span className="text-black font-mono text-xs font-bold bg-neutral-100 px-2 py-0.5 rounded border border-neutral-300">Auto-derived Flow Rates</span>
                  </div>
                  <div className="divide-y divide-neutral-200 font-mono text-xs sm:text-sm">
                    <div className="grid grid-cols-12 py-2.5 text-neutral-700 font-bold uppercase text-xs tracking-wider">
                      <div className="col-span-6">Holder Address</div>
                      <div className="col-span-2 text-right">Balance</div>
                      <div className="col-span-2 text-right">Share</div>
                      <div className="col-span-2 text-right text-black">Yield/Mo</div>
                    </div>
                    {(subgraphData?.data?.holders || []).map((h: HolderData, i: number) => (
                      <div key={i} className="grid grid-cols-12 py-3 items-center hover:bg-neutral-50 px-2 rounded-lg transition">
                        <div className="col-span-6 flex items-center gap-2 truncate text-neutral-900 font-semibold">
                          <span className="text-neutral-500 font-normal">#{i + 1}</span>
                          <span className="truncate">{h.address}</span>
                        </div>
                        <div className="col-span-2 text-right text-neutral-700 font-medium">{h.formattedBalance}</div>
                        <div className="col-span-2 text-right text-black font-bold">{h.sharePercentage}</div>
                        <div className="col-span-2 text-right text-black font-extrabold">
                          ${h.monthlyYieldUsd.toFixed(2)}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
                <p className="text-xs sm:text-sm text-neutral-800 bg-neutral-50 p-4 rounded-xl border border-neutral-300 leading-relaxed">
                  <strong className="text-black font-bold">How Agent Uses This:</strong> The Hermes autonomous agent calls <code className="text-black bg-neutral-200 px-1.5 py-0.5 rounded font-bold">subgraph_read.get_top_holders</code> to discover shareholder proportions and immediately opens or scales continuous Superfluid CFA cashflow streams in <code className="text-black bg-neutral-200 px-1.5 py-0.5 rounded font-bold">YieldVault.sol</code>.
                </p>
              </div>
            )}

            {queryType === "transfers" && (
              <div className="rounded-2xl border border-neutral-300 bg-white p-5 font-mono text-xs sm:text-sm">
                <div className="divide-y divide-neutral-200">
                  <div className="grid grid-cols-12 py-2.5 text-neutral-700 font-bold uppercase text-xs tracking-wider">
                    <div className="col-span-3">Tx Hash</div>
                    <div className="col-span-4">From → To</div>
                    <div className="col-span-3 text-right">Amount</div>
                    <div className="col-span-2 text-right">Type</div>
                  </div>
                  {(subgraphData?.data?.recentTransfers || []).map((t: TransferData, i: number) => (
                    <div key={i} className="grid grid-cols-12 py-3 items-center hover:bg-neutral-50 px-2 rounded-lg transition">
                      <div className="col-span-3 truncate text-neutral-700 font-medium">
                        {t.transactionHash.slice(0, 10)}...
                      </div>
                      <div className="col-span-4 text-neutral-800 truncate text-xs sm:text-sm">
                        {t.from.address.slice(0, 6)}... → {t.to.address.slice(0, 6)}...
                      </div>
                      <div className="col-span-3 text-right text-black font-bold">{t.formattedValue}</div>
                      <div className="col-span-2 text-right">
                        <span className="text-xs px-2.5 py-1 rounded bg-neutral-100 text-black border border-neutral-300 font-bold">
                          {t.isMintOrBurn ? "Mint" : "Transfer"}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {queryType === "meta" && (
              <div className="rounded-2xl border border-neutral-300 bg-neutral-50 p-5 font-mono text-xs sm:text-sm text-black">
                <pre className="overflow-x-auto text-xs sm:text-sm leading-relaxed text-neutral-900">
{JSON.stringify(subgraphData?.meta || {}, null, 2)}
                </pre>
              </div>
            )}
          </div>
        )}

        {/* Tab 2: Subgraph MCP Tooling */}
        {activeTab === "mcp" && (
          <div className="mt-4 flex-1 overflow-y-auto space-y-4 pr-1 text-sm">
            <div className="rounded-2xl border border-neutral-300 bg-neutral-50 p-5 space-y-2">
              <h4 className="font-bold text-base sm:text-lg text-black">Official Model Context Protocol (MCP) Integration</h4>
              <p className="text-xs sm:text-sm text-neutral-700 leading-relaxed">
                Two dedicated MCP servers (<code className="text-black bg-neutral-200 px-1.5 py-0.5 rounded font-bold">subgraph_read</code> and <code className="text-black bg-neutral-200 px-1.5 py-0.5 rounded font-bold">subgraph_write</code>) built with <code className="text-neutral-900 font-bold">@modelcontextprotocol/sdk</code> allow any LLM (Hermes, Claude, Cursor, ChatGPT) to interact with The Graph.
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="rounded-2xl border border-neutral-300 bg-white p-5 space-y-3">
                <div className="flex items-center gap-2 font-bold text-base text-black border-b border-neutral-100 pb-2">
                  <span>subgraph_read (Query Suite)</span>
                </div>
                <ul className="space-y-2 font-mono text-xs sm:text-sm text-neutral-700 leading-normal">
                  <li>• <strong className="text-black font-semibold">get_token_info</strong>: Name, symbol, supply, tx count</li>
                  <li>• <strong className="text-black font-semibold">get_top_holders</strong>: Rank holders by balance</li>
                  <li>• <strong className="text-black font-semibold">get_recent_transfers</strong>: Filter transfers/mints</li>
                  <li>• <strong className="text-black font-semibold">get_account_balance</strong>: Live derived balance</li>
                  <li>• <strong className="text-black font-semibold">get_biggest_transfer</strong>: Largest whale movements</li>
                  <li>• <strong className="text-black font-semibold">get_deployment_status</strong>: Graph Studio IPFS hash</li>
                </ul>
              </div>

              <div className="rounded-2xl border border-neutral-300 bg-white p-5 space-y-3">
                <div className="flex items-center gap-2 font-bold text-base text-black border-b border-neutral-100 pb-2">
                  <span>subgraph_write (Self-Deployment)</span>
                </div>
                <p className="text-xs sm:text-sm text-neutral-700 leading-relaxed">
                  Autonomous pipeline enabling the agent to reconfigure and redeploy Subgraphs on the fly:
                </p>
                <ul className="space-y-2 font-mono text-xs sm:text-sm text-neutral-700 leading-normal">
                  <li>• <strong className="text-black font-semibold">add_token_source</strong>: Appends new RWA contract to <code className="text-black bg-neutral-200 px-1.5 py-0.5 rounded font-bold">subgraph.yaml</code></li>
                  <li>• <strong className="text-black font-semibold">set_token_sources</strong>: Replaces tracked token registry</li>
                  <li>• Auto-triggers <code className="text-black bg-neutral-200 px-1.5 py-0.5 rounded font-bold">graph codegen &amp;&amp; graph deploy</code> to Studio</li>
                </ul>
              </div>
            </div>

            <div className="rounded-2xl border border-neutral-300 bg-neutral-50 p-5 space-y-3">
              <div className="text-black font-bold text-sm sm:text-base">Natural Language Agent Query Example:</div>
              <div className="bg-white p-4 rounded-xl font-mono text-xs sm:text-sm leading-relaxed text-neutral-900 border border-neutral-300 space-y-2.5 shadow-sm">
                <div>
                  <span className="text-neutral-500 font-bold">&gt; User:</span>{" "}
                  <span className="text-neutral-800">"Who owns the highest share in 456 Oak Avenue and how much yield did they earn this month?"</span>
                </div>
                <div>
                  <span className="text-black font-bold">&gt; Hermes Agent:</span>{" "}
                  <span className="text-neutral-800">Calling</span>{" "}
                  <code className="text-black bg-neutral-200 px-1.5 py-0.5 rounded font-bold">
                    subgraph_read.get_top_holders(tokenAddress: "0xf531...")
                  </code>
                  ...
                </div>
                <div>
                  <span className="text-neutral-700 font-bold">&gt; Agent Response:</span>{" "}
                  <span className="text-neutral-900">
                    "The top holder is <strong className="text-black">0x742d...</strong> with{" "}
                    <strong className="text-black">250 OAK-RWA</strong> tokens (25% share). Based on monthly rental collections of $3,800, their Superfluid CFA stream continuously accrues{" "}
                    <strong className="text-black font-bold">$950.00/month</strong>."
                  </span>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Modal Footer */}
        <div className="mt-6 flex flex-wrap items-center justify-between border-t border-neutral-200 pt-4 text-xs sm:text-sm text-neutral-700 font-mono">
          <div className="flex items-center gap-2">
            <span>Powered by:</span>
            <span className="font-bold text-black">The Graph</span>
            <span>·</span>
            <span className="font-bold text-black">Superfluid</span>
            <span>·</span>
            <span className="font-bold text-black">Hedera x402</span>
          </div>
          <button
            onClick={onClose}
            className="rounded-xl bg-black text-white px-6 py-2.5 text-xs sm:text-sm font-bold hover:bg-neutral-800 transition cursor-pointer border border-black"
          >
            Close Inspector
          </button>
        </div>
      </div>
    </div>
  );
}
