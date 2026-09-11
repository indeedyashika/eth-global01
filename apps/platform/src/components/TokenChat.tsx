"use client";

import { useEffect, useRef, useState } from "react";
import { useWallet } from "@/hooks/useWalletConnect";
import { useEvmWallet } from "@/hooks/useEvmWallet";
import { streamChatCompletion } from "@/lib/chat/stream";
import { Button, Card, ErrorText, TextInput } from "@/components/ui";
import type { TokenRecord } from "@/types";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

/**
 * Holder-only "ask about this token" chat panel. Proxied server-side
 * (/api/tokens/[tokenId]/chat) to the locked-down `pr` Hermes profile — a
 * read-only agent with no path to mint/transfer/reclaim/pause/whitelist, so
 * this is purely a Q&A surface regardless of what's asked.
 *
 * Gated on a live on-chain balance (>0), not just a local "registered"
 * bookkeeping row — checked here for the greyed-out UI state, and
 * independently re-checked server-side on every message (this component's
 * `eligible` state is never the actual security boundary).
 */
export default function TokenChat({ token }: { token: TokenRecord }) {
  const hederaWallet = useWallet();
  const evmWallet = useEvmWallet();
  const activeWallet = token.blockchain === "EVM" ? evmWallet : hederaWallet;
  const { accountId } = activeWallet;

  // Keyed by `${tokenId}:${accountId}` so a stale in-flight result can never
  // apply to a since-changed wallet/token — checked against the CURRENT key
  // at render time rather than reset via a synchronous setState in the effect
  // body (see the derived `eligible` below).
  const [balanceCheck, setBalanceCheck] = useState<{ key: string; eligible: boolean } | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const balanceCheckKey = accountId ? `${token.id}:${accountId}` : null;
  const eligible = balanceCheck && balanceCheck.key === balanceCheckKey ? balanceCheck.eligible : null;

  useEffect(() => {
    if (!accountId) return;
    const key = `${token.id}:${accountId}`;
    let cancelled = false;
    fetch(`/api/tokens/${token.id}/chat?accountId=${encodeURIComponent(accountId)}`)
      .then((res) => (res.ok ? res.json() : { eligible: false }))
      .then((body) => {
        if (!cancelled) setBalanceCheck({ key, eligible: Boolean(body?.eligible) });
      })
      .catch(() => {
        if (!cancelled) setBalanceCheck({ key, eligible: false });
      });
    return () => {
      cancelled = true;
    };
  }, [accountId, token.id]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  // No wallet connected yet — HolderPanel above already covers "connect a
  // wallet" / "join this token", so there's nothing useful to show here.
  if (!accountId) return null;

  async function send() {
    const question = input.trim();
    if (!question || busy || !eligible) return;
    setInput("");
    setError(null);
    const history = [...messages, { role: "user" as const, content: question }];
    setMessages([...history, { role: "assistant" as const, content: "" }]);
    setBusy(true);
    try {
      const res = await fetch(`/api/tokens/${token.id}/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accountId, messages: history }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? `Chat request failed (${res.status})`);
      }
      let assistantText = "";
      for await (const delta of streamChatCompletion(res)) {
        assistantText += delta;
        setMessages([...history, { role: "assistant", content: assistantText }]);
      }
      if (!assistantText) {
        setMessages(history);
        setError("No response — please try again.");
      }
    } catch (err) {
      setMessages(history);
      setError(err instanceof Error ? err.message : "Chat request failed");
    } finally {
      setBusy(false);
    }
  }

  const locked = eligible !== true;

  return (
    <Card className={`flex flex-col gap-3 transition-opacity ${locked ? "opacity-60" : ""}`}>
      <div className="flex items-center justify-between">
        <h2 className="font-semibold">Ask about {token.symbol}</h2>
        <span className="text-xs text-zinc-500">Read-only — answers questions, can&apos;t transact</span>
      </div>

      {eligible === false && (
        <p className="text-sm text-zinc-500">
          Hold some {token.symbol} in this wallet to unlock chat.
        </p>
      )}
      {eligible === null && <p className="text-sm text-zinc-500">Checking your balance…</p>}

      {messages.length > 0 && (
        <div ref={scrollRef} className="flex flex-col gap-2 max-h-80 overflow-y-auto pr-1">
          {messages.map((message, i) => (
            <div
              key={i}
              className={`text-sm rounded-lg px-3 py-2 max-w-[85%] whitespace-pre-wrap font-mono ${
                message.role === "user"
                  ? "self-end bg-black text-white border border-black"
                  : "self-start bg-neutral-100 text-black border border-neutral-300"
              }`}
            >
              {message.content || (busy && i === messages.length - 1 ? "…" : "")}
            </div>
          ))}
        </div>
      )}

      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <TextInput
          className="flex-1"
          placeholder={locked ? "Hold this token to chat…" : "Ask about holders, transfers, supply…"}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={busy || locked}
        />
        <Button type="submit" disabled={busy || locked || !input.trim()}>
          {busy ? "Asking…" : "Ask"}
        </Button>
      </form>

      <ErrorText>{error}</ErrorText>
    </Card>
  );
}
