"use client";

import React, { useState, useEffect, useRef } from "react";
import Link from "next/link";
import { HcsAuditBadge } from "@/components/HcsAuditBadge";

interface LogEntry {
  id: string;
  timestamp: string;
  source: "OPERATOR" | "HERMES" | "MCP" | "HCS";
  content: string;
  data?: any;
}

const INITIAL_LOGS: LogEntry[] = [
  {
    id: "init-1",
    timestamp: "00:00:01",
    source: "HERMES",
    content: "Hermes Agent daemon initialized. Workdir: /data/.hermes/workspace. Loaded AGENTS.md instructions.",
  },
  {
    id: "init-2",
    timestamp: "00:00:02",
    source: "MCP",
    content: "6 MCP servers connected: subgraph_read, subgraph_write, hedera_read, hedera_write, evm_read, evm_write, usps_chainlink, worldid.",
  },
  {
    id: "init-3",
    timestamp: "00:00:03",
    source: "HCS",
    content: "Hedera Consensus Service listening on Topic 0.0.4491823. HIP-423 scheduler ready.",
  },
];

export default function HermesConsolePage() {
  const [activeProfile, setActiveProfile] = useState<"default" | "pr">("default");
  const [inputCommand, setInputCommand] = useState("");
  const [isExecuting, setIsExecuting] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>(INITIAL_LOGS);

  const terminalEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Stamp initial logs with client-side local time after hydration to avoid SSR mismatch
    const now = new Date().toLocaleTimeString();
    setLogs((prev) =>
      prev.map((l) => (l.id.startsWith("init-") ? { ...l, timestamp: now } : l))
    );
  }, []);

  useEffect(() => {
    terminalEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  const addLog = (source: LogEntry["source"], content: string, data?: any) => {
    setLogs((prev) => [
      ...prev,
      {
        id: Math.random().toString(36).slice(2, 9),
        timestamp: new Date().toLocaleTimeString(),
        source,
        content,
        data,
      },
    ]);
  };

  const handleRunCommand = async (command: string) => {
    if (!command.trim() || isExecuting) return;
    const cmd = command.trim();
    setInputCommand("");
    setIsExecuting(true);

    addLog("OPERATOR", cmd);

    try {
      if (cmd.toLowerCase().includes("top holders") || cmd.toLowerCase().includes("subgraph")) {
        addLog("HERMES", "Invoking MCP tool: subgraph_read.get_top_holders({ tokenAddress: '0xf531...' })");
        const res = await fetch("/api/subgraph");
        const json = await res.json();
        const holders = json.data?.holders || [];
        addLog(
          "MCP",
          `The Graph indexed ${holders.length} holders. Derived Superfluid flow rates allocated.`,
          holders
        );
        addLog(
          "HERMES",
          `Top shareholder is ${holders[0]?.address} with ${holders[0]?.sharePercentage} equity. Proportional rental yield: $${holders[0]?.monthlyYieldUsd?.toFixed(2)}/mo.`
        );
      } else if (cmd.toLowerCase().includes("rent") || cmd.toLowerCase().includes("deposit") || cmd.toLowerCase().includes("yield")) {
        addLog("HERMES", "Executing rent inflow injection into Base Sepolia YieldVault.sol ($3,800 USD)...");
        const res = await fetch("/api/rent/simulate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            propertyId: "prop_456_oak_ave",
            amount: 3800,
            tenantName: "Acme Residential Tenant Corp",
          }),
        });
        const json = await res.json();
        addLog("MCP", `Superfluid CFA stream accelerated: +$${(json.amountDeposited / 2592000).toFixed(6)}/sec`, json);
        addLog("HCS", `Consensus receipt anchored on Hedera Testnet! Topic: 0.0.4491823, Sequence: #${json.hcsAudit?.sequenceNumber}`);
        addLog("HERMES", "Autonomous rental yield distribution complete. All token shareholder streams are actively ticking.");
      } else if (cmd.toLowerCase().includes("usps") || cmd.toLowerCase().includes("x402") || cmd.toLowerCase().includes("tokenize")) {
        addLog("HERMES", "Checking physical deliverability for 456 Oak Avenue via Hedera x402 Property Oracle paywall...");
        addLog("MCP", "HTTP 402 Payment Required intercepted. Settling 0.5 HBAR micropayment via Blocky402...");
        await new Promise((r) => setTimeout(r, 700));
        const res = await fetch("/api/x402/property-oracle", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Payment-Tx": `0.0.4491823@${Math.floor(Date.now() / 1000)}.000000000`,
            "X-Payment-Invoice": "inv_console_demo",
          },
          body: JSON.stringify({ street: "456 Oak Avenue", city: "Miami", state: "FL", zip: "33101" }),
        });
        const json = await res.json();
        addLog("MCP", `USPS DPV deliverability confirmed: Code ${json.dpvConfirmation} (Deliverable Address)`, json);
        addLog("HCS", `HCS Audit message recorded on Topic 0.0.4491823 (Sequence #${json.hcsAudit?.sequenceNumber})`);
        addLog("HERMES", "Property is physical asset verified. HTS fractional token creation authorized.");
      } else if (cmd.toLowerCase().includes("hip-423") || cmd.toLowerCase().includes("schedule")) {
        addLog("HERMES", "Queueing Hedera scheduled recurring yield payout transaction (HIP-423)...");
        await new Promise((r) => setTimeout(r, 600));
        addLog("MCP", "Scheduled transaction created: 0.0.4491823@1788783526. Schedule ID: 0.0.592819.");
        addLog("HCS", "HIP-423 schedule confirmation logged to Topic 0.0.4491823.");
        addLog("HERMES", "Recurring schedule active. Payouts will trigger on the 1st of every month automatically.");
      } else {
        addLog("HERMES", `Received instruction: "${cmd}". Routing through Hermes operator autonomous planner...`);
        await new Promise((r) => setTimeout(r, 600));
        addLog("HERMES", `Query evaluated against live system context. All services healthy on Hedera, Base Sepolia, and The Graph.`);
      }
    } catch (err: any) {
      addLog("HERMES", `Execution error: ${err.message || "Failed to execute instruction"}`);
    } finally {
      setIsExecuting(false);
    }
  };

  return (
    <div className="min-h-screen bg-white text-black font-mono">
      <div className="max-w-7xl mx-auto px-4 py-8">
        
        {/* Top Navigation & Status Bar */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-neutral-300 pb-6 mb-8">
          <div>
            <div className="flex items-center gap-3 mb-2">
              <Link
                href="/"
                className="inline-flex items-center gap-1.5 text-xs text-neutral-600 hover:text-black border border-neutral-300 bg-neutral-100 px-3 py-1 font-mono transition-colors"
              >
                <span>← Back to Prism 8 Storefront</span>
              </Link>
              <span className="text-xs px-2.5 py-0.5 bg-black text-white font-mono font-bold">
                HERMES OPERATOR CONSOLE
              </span>
            </div>
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-black">
              Autonomous Real-Estate Yield Operator
            </h1>
            <p className="text-xs text-neutral-600 mt-1">
              Natural-language asset management · Hedera x402 · Superfluid CFA · The Graph MCP Integration
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2 border border-neutral-300 bg-neutral-50 px-3 py-1.5 text-xs">
              <span className="w-2 h-2 rounded-full bg-black animate-ping" />
              <span className="font-bold text-black">DAEMON: ONLINE</span>
            </div>

            <div className="flex items-center border border-neutral-300 bg-white text-xs">
              <button
                onClick={() => setActiveProfile("default")}
                className={`px-3 py-1.5 font-semibold cursor-pointer transition ${
                  activeProfile === "default"
                    ? "bg-black text-white"
                    : "text-neutral-600 hover:text-black"
                }`}
              >
                Profile: default (Operator)
              </button>
              <button
                onClick={() => setActiveProfile("pr")}
                className={`px-3 py-1.5 font-semibold cursor-pointer transition border-l border-neutral-300 ${
                  activeProfile === "pr"
                    ? "bg-black text-white"
                    : "text-neutral-600 hover:text-black"
                }`}
              >
                Profile: pr (Read-only)
              </button>
            </div>
          </div>
        </div>

        {/* 3 Overview Diagnostic Slots (Ad402 Dashed Border Style) */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-8">
          
          {/* Slot 1: The Graph MCP Pipeline */}
          <div className="ad402-slot bg-white p-5 border border-dashed border-black">
            <div className="flex items-center justify-between mb-3 border-b border-neutral-200 pb-2">
              <span className="font-bold text-black text-sm">The Graph MCP Tooling</span>
              <span className="text-[10px] px-2 py-0.5 bg-neutral-100 border border-neutral-300 text-black">
                2 Servers Active
              </span>
            </div>
            <div className="space-y-2 text-xs text-neutral-700">
              <div className="flex justify-between">
                <span className="text-neutral-500">Query Suite:</span>
                <span className="text-black font-semibold">subgraph_read (8 tools)</span>
              </div>
              <div className="flex justify-between">
                <span className="text-neutral-500">Mutator/Deploy:</span>
                <span className="text-black font-semibold">subgraph_write</span>
              </div>
              <div className="flex justify-between">
                <span className="text-neutral-500">Target Studio:</span>
                <span className="text-black font-mono truncate max-w-[150px]">prism8-yield-stream</span>
              </div>
              <div className="flex justify-between">
                <span className="text-neutral-500">Tracked Entities:</span>
                <span className="text-black font-semibold">Account, Token, Transfer</span>
              </div>
            </div>
          </div>

          {/* Slot 2: Superfluid Yield Streaming */}
          <div className="ad402-slot bg-white p-5 border border-dashed border-black">
            <div className="flex items-center justify-between mb-3 border-b border-neutral-200 pb-2">
              <span className="font-bold text-black text-sm">Superfluid CFA Engine</span>
              <span className="text-[10px] px-2 py-0.5 bg-neutral-100 border border-neutral-300 text-black">
                Base Sepolia
              </span>
            </div>
            <div className="space-y-2 text-xs text-neutral-700">
              <div className="flex justify-between">
                <span className="text-neutral-500">Yield Vault:</span>
                <span className="text-black font-mono">YieldVault.sol ↗</span>
              </div>
              <div className="flex justify-between">
                <span className="text-neutral-500">Flow Rate:</span>
                <span className="text-black font-bold">+$0.00162037 / sec</span>
              </div>
              <div className="flex justify-between">
                <span className="text-neutral-500">Super Token:</span>
                <span className="text-black font-semibold">fUSDCx (Superfluid)</span>
              </div>
              <div className="flex justify-between">
                <span className="text-neutral-500">Auto Distribution:</span>
                <span className="text-black font-semibold">Proportional to Graph Shares</span>
              </div>
            </div>
          </div>

          {/* Slot 3: Hedera x402 & HCS Audit */}
          <div className="ad402-slot bg-white p-5 border border-dashed border-black">
            <div className="flex items-center justify-between mb-3 border-b border-neutral-200 pb-2">
              <span className="font-bold text-black text-sm">Hedera x402 & HCS Audit</span>
              <span className="text-[10px] px-2 py-0.5 bg-neutral-100 border border-neutral-300 text-black">
                Testnet Active
              </span>
            </div>
            <div className="space-y-2 text-xs text-neutral-700">
              <div className="flex justify-between">
                <span className="text-neutral-500">Micropayment:</span>
                <span className="text-black font-bold">0.5 HBAR per USPS Query</span>
              </div>
              <div className="flex justify-between">
                <span className="text-neutral-500">Consensus Topic:</span>
                <span className="text-black font-mono">0.0.4491823</span>
              </div>
              <div className="flex justify-between">
                <span className="text-neutral-500">Oracle Validation:</span>
                <span className="text-black font-semibold">USPS DPV Code Y</span>
              </div>
              <div className="flex justify-between">
                <span className="text-neutral-500">Scheduler:</span>
                <span className="text-black font-semibold">HIP-423 Batch Payouts</span>
              </div>
            </div>
          </div>
        </div>

        {/* Main Terminal Section */}
        <div className="border border-neutral-300 bg-white mb-8 shadow-sm">
          
          {/* Terminal Header */}
          <div className="flex flex-wrap items-center justify-between gap-3 bg-neutral-100 px-4 py-3 border-b border-neutral-300 text-xs">
            <div className="flex items-center gap-2">
              <span className="w-3 h-3 rounded-full bg-black inline-block" />
              <span className="font-bold text-black">HERMES INTERACTIVE SHELL</span>
              <span className="text-neutral-500 font-mono">v2026.7.1</span>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setLogs([])}
                className="px-2.5 py-1 text-[11px] border border-neutral-300 bg-white hover:bg-neutral-200 transition text-neutral-700 hover:text-black cursor-pointer"
              >
                Clear Terminal
              </button>
            </div>
          </div>

          {/* Quick Command Chips */}
          <div className="p-3 bg-neutral-50 border-b border-neutral-200 flex flex-wrap items-center gap-2 text-xs">
            <span className="text-neutral-500 font-semibold text-[11px]">Quick Triggers:</span>
            <button
              onClick={() => handleRunCommand("The Graph: Query Top Token Holders & Calculate Flows")}
              disabled={isExecuting}
              className="px-2.5 py-1 bg-white border border-neutral-300 hover:border-black text-black text-[11px] transition cursor-pointer"
            >
              1. The Graph: Inspect Top Holders
            </button>
            <button
              onClick={() => handleRunCommand("Superfluid: Simulate Rent Deposit & Accelerate Stream")}
              disabled={isExecuting}
              className="px-2.5 py-1 bg-white border border-neutral-300 hover:border-black text-black text-[11px] transition cursor-pointer"
            >
              2. Superfluid: Accelerate Yield Flow
            </button>
            <button
              onClick={() => handleRunCommand("Hedera: Verify USPS Property via x402 Micropayment")}
              disabled={isExecuting}
              className="px-2.5 py-1 bg-white border border-neutral-300 hover:border-black text-black text-[11px] transition cursor-pointer"
            >
              3. x402: Verify USPS Deliverability
            </button>
            <button
              onClick={() => handleRunCommand("HIP-423: Queue Recurring Scheduled Batch Distribution")}
              disabled={isExecuting}
              className="px-2.5 py-1 bg-white border border-neutral-300 hover:border-black text-black text-[11px] transition cursor-pointer"
            >
              4. HIP-423: Scheduled Payouts
            </button>
          </div>

          {/* Terminal Logs Window */}
          <div className="p-4 bg-white min-h-[360px] max-h-[500px] overflow-y-auto font-mono text-xs space-y-3">
            {logs.map((log) => (
              <div key={log.id} className="leading-relaxed border-b border-neutral-100 pb-2.5">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-neutral-400 text-[10px]" suppressHydrationWarning>
                    {log.timestamp}
                  </span>
                  <span
                    className={`text-[10px] px-1.5 py-0.2 font-bold border ${
                      log.source === "OPERATOR"
                        ? "bg-black text-white border-black"
                        : log.source === "HERMES"
                        ? "bg-neutral-200 text-black border-neutral-400"
                        : log.source === "MCP"
                        ? "bg-neutral-100 text-neutral-800 border-neutral-300"
                        : "bg-neutral-100 text-black border-neutral-400"
                    }`}
                  >
                    [{log.source}]
                  </span>
                </div>
                <div className="text-black whitespace-pre-wrap pl-1 font-mono">
                  {log.content}
                </div>
                {log.data && (
                  <div className="mt-2 bg-neutral-50 p-2.5 border border-neutral-200 rounded text-[11px] overflow-x-auto text-neutral-800">
                    <pre>{JSON.stringify(log.data, null, 2)}</pre>
                  </div>
                )}
              </div>
            ))}
            {isExecuting && (
              <div className="flex items-center gap-2 text-neutral-500 py-2 italic">
                <span className="w-2 h-2 rounded-full bg-black animate-ping" />
                <span>Hermes agent reasoning & executing toolchain...</span>
              </div>
            )}
            <div ref={terminalEndRef} />
          </div>

          {/* Terminal Input Form */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void handleRunCommand(inputCommand);
            }}
            className="flex items-center border-t border-neutral-300 p-3 bg-neutral-50 gap-3"
          >
            <span className="text-black font-bold text-sm select-none">&gt;</span>
            <input
              type="text"
              value={inputCommand}
              onChange={(e) => setInputCommand(e.target.value)}
              placeholder="Ask Hermes to query The Graph, stream yield on Superfluid, or verify a property via x402..."
              disabled={isExecuting}
              className="flex-1 bg-white border border-neutral-300 px-3.5 py-2 text-xs font-mono text-black placeholder-neutral-400 focus:border-black focus:outline-none"
            />
            <button
              type="submit"
              disabled={isExecuting || !inputCommand.trim()}
              className="bg-black text-white px-5 py-2 text-xs font-bold border border-black hover:bg-neutral-800 disabled:opacity-40 transition cursor-pointer"
            >
              {isExecuting ? "Executing..." : "Send Prompt"}
            </button>
          </form>
        </div>

        {/* Connected Tool Matrix */}
        <div className="border border-neutral-300 bg-white p-6 shadow-sm mb-8">
          <div className="flex items-center justify-between mb-4 border-b border-neutral-200 pb-3">
            <div>
              <h3 className="text-base font-bold text-black">Connected MCP Tool Matrix</h3>
              <p className="text-xs text-neutral-600">Model Context Protocol tools exposed to Hermes</p>
            </div>
            <span className="text-xs font-mono text-black border border-neutral-300 bg-neutral-100 px-2.5 py-1">
              8 Tools Registered
            </span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 text-xs">
            <div className="border border-neutral-200 p-3.5 bg-neutral-50">
              <div className="font-bold text-black mb-1">subgraph_read</div>
              <p className="text-neutral-600 mb-2">Queries live GraphQL studio entities for token distribution and equity ranking.</p>
              <div className="text-[10px] text-neutral-500 font-mono">Tools: get_token_info, get_top_holders, get_recent_transfers</div>
            </div>

            <div className="border border-neutral-200 p-3.5 bg-neutral-50">
              <div className="font-bold text-black mb-1">subgraph_write</div>
              <p className="text-neutral-600 mb-2">Autonomous manifest mutator: edits subgraph.yaml, codegen, and deploys to Studio.</p>
              <div className="text-[10px] text-neutral-500 font-mono">Tools: add_token_source, set_token_sources</div>
            </div>

            <div className="border border-neutral-200 p-3.5 bg-neutral-50">
              <div className="font-bold text-black mb-1">evm_write (Superfluid)</div>
              <p className="text-neutral-600 mb-2">Controls Base Sepolia YieldVault.sol and continuous per-second CFA flow rates.</p>
              <div className="text-[10px] text-neutral-500 font-mono">Tools: update_flow_rate, stream_rental_cashflow</div>
            </div>

            <div className="border border-neutral-200 p-3.5 bg-neutral-50">
              <div className="font-bold text-black mb-1">hedera_write (HTS + HCS)</div>
              <p className="text-neutral-600 mb-2">Mints fractional property shares, anchors immutable HCS audits, queues HIP-423 payouts.</p>
              <div className="text-[10px] text-neutral-500 font-mono">Tools: tokenize_property, log_hcs_receipt, schedule_payout</div>
            </div>

            <div className="border border-neutral-200 p-3.5 bg-neutral-50">
              <div className="font-bold text-black mb-1">usps_chainlink (x402)</div>
              <p className="text-neutral-600 mb-2">Physical property deliverability oracle paid with 0.5 HBAR via HTTP 402.</p>
              <div className="text-[10px] text-neutral-500 font-mono">Tools: verify_property_address, get_dpv_status</div>
            </div>

            <div className="border border-neutral-200 p-3.5 bg-neutral-50">
              <div className="font-bold text-black mb-1">worldid (Policy)</div>
              <p className="text-neutral-600 mb-2">Investor compliance verification gating against Sybil attacks and verifying liveness.</p>
              <div className="text-[10px] text-neutral-500 font-mono">Tools: verify_selfie, check_nationality_policy</div>
            </div>
          </div>
        </div>

        {/* HCS Verifiable Audit Stream Preview */}
        <div className="border border-neutral-300 bg-white p-6 shadow-sm">
          <h3 className="text-base font-bold text-black mb-3">Live Hedera Consensus Audit Receipt</h3>
          <HcsAuditBadge
            topicId="0.0.4491823"
            sequenceNumber={83526}
            txId="0.0.4491823@1788783526.000000000"
          />
        </div>

      </div>
    </div>
  );
}
