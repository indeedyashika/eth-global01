"use client";

import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useWallet } from "@/hooks/useWalletConnect";
import { useEvmWallet } from "@/hooks/useEvmWallet";

export interface WalletModalProps {
  isOpen: boolean;
  onClose: () => void;
}

interface WalletItem {
  id: string;
  name: string;
  badge?: string;
  type: "evm" | "hedera";
  icon: React.ReactNode;
  isInstalled?: boolean;
  downloadUrl?: string;
}

function shorten(accountId: string): string {
  return accountId.startsWith("0x")
    ? `${accountId.slice(0, 6)}…${accountId.slice(-4)}`
    : accountId;
}

export function WalletModal({ isOpen, onClose }: WalletModalProps) {
  const hedera = useWallet();
  const evm = useEvmWallet();

  const [mounted, setMounted] = useState(false);
  const [copiedAddress, setCopiedAddress] = useState<string | null>(null);
  const [connectingWalletId, setConnectingWalletId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"wallets" | "account">("wallets");

  useEffect(() => {
    setMounted(true);
  }, []);

  // Lock body scroll when modal is open
  useEffect(() => {
    if (!isOpen) return;
    const originalStyle = window.getComputedStyle(document.body).overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = originalStyle;
    };
  }, [isOpen]);

  // Extension detection
  const [detected, setDetected] = useState<{
    phantom: boolean;
    brave: boolean;
    metamask: boolean;
    coinbase: boolean;
  }>({
    phantom: false,
    brave: false,
    metamask: false,
    coinbase: false,
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    const win = window as any;
    const eth = win.ethereum;
    setDetected({
      phantom: Boolean(win.phantom?.ethereum || win.solana?.isPhantom || eth?.isPhantom),
      brave: Boolean(eth?.isBraveWallet),
      metamask: Boolean(eth?.isMetaMask && !eth?.isBraveWallet && !eth?.isPhantom),
      coinbase: Boolean(win.coinbaseWalletExtension || eth?.isCoinbaseWallet),
    });
  }, [isOpen]);

  // Switch to account tab if connected
  useEffect(() => {
    if (evm.accountId || hedera.accountId) {
      setActiveTab("account");
    } else {
      setActiveTab("wallets");
    }
  }, [evm.accountId, hedera.accountId, isOpen]);

  // Handle ESC key to close modal
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    if (isOpen) {
      window.addEventListener("keydown", handleKeyDown);
    }
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen || !mounted) return null;

  const handleCopy = (address: string) => {
    navigator.clipboard.writeText(address);
    setCopiedAddress(address);
    setTimeout(() => setCopiedAddress(null), 2000);
  };

  const handleWalletSelect = async (wallet: WalletItem) => {
    setConnectingWalletId(wallet.id);
    try {
      if (wallet.type === "hedera") {
        await hedera.connect();
      } else {
        await evm.connect(wallet.id);
      }
      onClose();
    } catch {
      // errors surfaced in context
    } finally {
      setConnectingWalletId(null);
    }
  };

  // Pure Monochrome SVG Icons
  const icons = {
    phantom: (
      <svg viewBox="0 0 24 24" className="w-5 h-5 fill-black">
        <path d="M19.3 11.5C18.8 6.5 14.5 3 9.8 3 5 3 1.5 6.7 1.5 12c0 4.2 2.7 7.7 6.5 8.7.4.1.8-.2.8-.6v-1.8c0-.6.4-1 1-1s1 .4 1 1v1.8c0 .4.4.7.8.6 3.8-1 6.5-4.5 6.5-8.7 0-.5 0-1-.1-1.5zm-11.8 1c-.8 0-1.5-.7-1.5-1.5s.7-1.5 1.5-1.5 1.5.7 1.5 1.5-.7 1.5-1.5 1.5zm6 0c-.8 0-1.5-.7-1.5-1.5s.7-1.5 1.5-1.5 1.5.7 1.5 1.5-.7 1.5-1.5 1.5z" />
      </svg>
    ),
    brave: (
      <svg viewBox="0 0 24 24" className="w-5 h-5 fill-none stroke-black" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 2L4 6v6c0 5.5 3.5 10 8 11 4.5-1 8-5.5 8-11V6l-8-4z" />
        <path d="M9 10a3 3 0 0 0 6 0" />
      </svg>
    ),
    rainbow: (
      <svg viewBox="0 0 24 24" className="w-5 h-5 fill-none stroke-black" strokeWidth="2.2" strokeLinecap="round">
        <path d="M4 18a8 8 0 0 1 16 0" />
        <path d="M7 18a5 5 0 0 1 10 0" />
        <path d="M10 18a2 2 0 0 1 4 0" />
      </svg>
    ),
    coinbase: (
      <svg viewBox="0 0 24 24" className="w-5 h-5 fill-black">
        <rect x="3" y="3" width="18" height="18" rx="5" fill="black" />
        <circle cx="12" cy="12" r="4.5" fill="#ffffff" />
        <rect x="10.7" y="10.7" width="2.6" height="2.6" rx="0.5" fill="black" />
      </svg>
    ),
    metamask: (
      <svg viewBox="0 0 24 24" className="w-5 h-5 fill-black">
        <path d="M21.5 3.2L13.8 8.8l1.4-3.4-3.2-2.2-3.2 2.2 1.4 3.4L2.5 3.2 5 13.5l7 7.3 7-7.3 2.5-10.3zM8.8 12.8L7.3 9.4l4.7 1.4-3.2 2zM12 18.2l-3.5-3.6 2.3-1.6 1.2 3.1 1.2-3.1 2.3 1.6-3.5 3.6zm3.2-5.4l-3.2-2 4.7-1.4-1.5 3.4z" />
      </svg>
    ),
    walletconnect: (
      <svg viewBox="0 0 24 24" className="w-5 h-5 fill-none stroke-black" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M5 9.5a9.5 9.5 0 0 1 14 0" />
        <path d="M7 12.5l2.5 2.5 2.5-2.5 2.5 2.5 2.5-2.5" />
      </svg>
    ),
    hedera: (
      <svg viewBox="0 0 24 24" className="w-5 h-5 fill-black">
        <path d="M6 4h3v6h6V4h3v16h-3v-6H9v6H6V4zm2 2v4h8V6H8zm0 8v4h8v-4H8z" />
      </svg>
    ),
  };

  // Groupings matching media_1788796710313.png
  const installedWallets: WalletItem[] = [
    {
      id: "phantom",
      name: "Phantom",
      badge: detected.phantom ? "Installed" : "Recent",
      type: "evm",
      icon: icons.phantom,
      isInstalled: detected.phantom,
      downloadUrl: "https://phantom.app/",
    },
    {
      id: "brave",
      name: "Brave Wallet",
      badge: detected.brave ? "Installed" : undefined,
      type: "evm",
      icon: icons.brave,
      isInstalled: detected.brave,
      downloadUrl: "https://brave.com/wallet/",
    },
  ];

  const popularWallets: WalletItem[] = [
    {
      id: "rainbow",
      name: "Rainbow",
      type: "evm",
      icon: icons.rainbow,
      downloadUrl: "https://rainbow.me/",
    },
    {
      id: "coinbase",
      name: "Coinbase Wallet",
      badge: detected.coinbase ? "Installed" : undefined,
      type: "evm",
      icon: icons.coinbase,
      isInstalled: detected.coinbase,
      downloadUrl: "https://www.coinbase.com/wallet",
    },
    {
      id: "metamask",
      name: "MetaMask",
      badge: detected.metamask ? "Installed" : undefined,
      type: "evm",
      icon: icons.metamask,
      isInstalled: detected.metamask,
      downloadUrl: "https://metamask.io/download/",
    },
    {
      id: "walletconnect",
      name: "WalletConnect",
      type: "evm",
      icon: icons.walletconnect,
      downloadUrl: "https://walletconnect.com/",
    },
    {
      id: "hedera",
      name: "HashPack (Hedera)",
      badge: hedera.accountId ? "Connected" : undefined,
      type: "hedera",
      icon: icons.hedera,
      downloadUrl: "https://www.hashpack.app/",
    },
  ];

  const isAnyConnected = Boolean(evm.accountId || hedera.accountId);

  return createPortal(
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-xs p-4 overflow-y-auto font-mono"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="wallet-modal-title"
    >
      <div className="relative w-full max-w-2xl rounded-3xl border border-neutral-300 bg-white text-black shadow-2xl overflow-hidden flex flex-col md:flex-row my-auto max-h-[90vh]">
        
        {/* Close Button at top-right */}
        <button
          onClick={onClose}
          className="absolute top-4 right-4 z-20 w-8 h-8 rounded-lg bg-neutral-100 hover:bg-neutral-200 flex items-center justify-center text-neutral-600 hover:text-black transition-colors cursor-pointer"
          aria-label="Close modal"
        >
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>

        {/* LEFT COLUMN: Connect a Wallet / Accounts */}
        <div className="w-full md:w-[50%] p-6 md:p-7 border-b md:border-b-0 md:border-r border-neutral-200 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between mb-5">
              <h2 id="wallet-modal-title" className="text-xl font-bold tracking-tight text-black">
                {activeTab === "account" ? "Wallet Account" : "Connect a Wallet"}
              </h2>
              {isAnyConnected && (
                <button
                  onClick={() => setActiveTab(activeTab === "wallets" ? "account" : "wallets")}
                  className="text-[11px] font-semibold text-neutral-500 hover:text-black transition-colors"
                >
                  {activeTab === "account" ? "+ Other Wallets" : "← Back"}
                </button>
              )}
            </div>

            {/* Error Message if any */}
            {(evm.error || hedera.error) && (
              <div className="mb-4 p-2.5 bg-neutral-100 border border-neutral-300 text-black text-xs rounded-xl">
                {evm.error || hedera.error}
              </div>
            )}

            {activeTab === "account" ? (
              /* ACCOUNT VIEW */
              <div className="space-y-4">
                {evm.accountId && (
                  <div className="p-4 rounded-2xl border border-black bg-neutral-50 flex flex-col gap-2.5">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="w-2.5 h-2.5 rounded-full bg-black" />
                        <span className="text-xs font-bold uppercase text-black">Sepolia EVM</span>
                      </div>
                      <span className="text-[11px] text-neutral-500 font-medium">Connected</span>
                    </div>

                    <div className="flex items-center justify-between bg-white border border-neutral-200 px-3 py-2 rounded-xl">
                      <span className="text-xs font-semibold">{shorten(evm.accountId)}</span>
                      <button
                        onClick={() => handleCopy(evm.accountId!)}
                        className="text-[11px] text-neutral-500 hover:text-black font-medium"
                      >
                        {copiedAddress === evm.accountId ? "Copied!" : "Copy"}
                      </button>
                    </div>

                    <div className="flex items-center gap-2 pt-1">
                      <a
                        href={`https://sepolia.etherscan.io/address/${evm.accountId}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex-1 text-center py-2 rounded-xl border border-neutral-300 text-[11px] font-semibold hover:bg-neutral-100 transition-colors"
                      >
                        Explorer
                      </a>
                      <button
                        onClick={() => evm.disconnect()}
                        className="flex-1 py-2 rounded-xl border border-black bg-black text-white text-[11px] font-semibold hover:bg-neutral-800 transition-colors"
                      >
                        Disconnect
                      </button>
                    </div>
                  </div>
                )}

                {hedera.accountId && (
                  <div className="p-4 rounded-2xl border border-black bg-neutral-50 flex flex-col gap-2.5">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="w-2.5 h-2.5 rounded-full bg-black" />
                        <span className="text-xs font-bold uppercase text-black">Hedera Testnet</span>
                      </div>
                      <span className="text-[11px] text-neutral-500 font-medium">Connected</span>
                    </div>

                    <div className="flex items-center justify-between bg-white border border-neutral-200 px-3 py-2 rounded-xl">
                      <span className="text-xs font-semibold">{hedera.accountId}</span>
                      <button
                        onClick={() => handleCopy(hedera.accountId!)}
                        className="text-[11px] text-neutral-500 hover:text-black font-medium"
                      >
                        {copiedAddress === hedera.accountId ? "Copied!" : "Copy"}
                      </button>
                    </div>

                    <div className="flex items-center gap-2 pt-1">
                      <a
                        href={`https://hashscan.io/testnet/account/${hedera.accountId}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex-1 text-center py-2 rounded-xl border border-neutral-300 text-[11px] font-semibold hover:bg-neutral-100 transition-colors"
                      >
                        HashScan
                      </a>
                      <button
                        onClick={() => hedera.disconnect()}
                        className="flex-1 py-2 rounded-xl border border-black bg-black text-white text-[11px] font-semibold hover:bg-neutral-800 transition-colors"
                      >
                        Disconnect
                      </button>
                    </div>
                  </div>
                )}

                <button
                  onClick={() => setActiveTab("wallets")}
                  className="w-full py-2.5 text-center text-xs font-semibold border border-dashed border-neutral-400 hover:border-black rounded-xl transition-colors text-black"
                >
                  + Connect Another Wallet
                </button>
              </div>
            ) : (
              /* WALLETS LIST */
              <div className="space-y-4">
                {/* Installed Section */}
                <div>
                  <div className="text-[11px] font-semibold text-neutral-400 tracking-wider uppercase mb-2">
                    Installed
                  </div>
                  <div className="space-y-1.5">
                    {installedWallets.map((wallet) => (
                      <button
                        key={wallet.id}
                        onClick={() => handleWalletSelect(wallet)}
                        disabled={evm.connecting || hedera.connecting}
                        className="w-full flex items-center justify-between p-2 rounded-xl hover:bg-neutral-100 transition-colors text-left group cursor-pointer"
                      >
                        <div className="flex items-center gap-3">
                          <div className="w-9 h-9 rounded-xl bg-neutral-100 border border-neutral-200 flex items-center justify-center group-hover:border-black transition-colors shrink-0">
                            {wallet.icon}
                          </div>
                          <div>
                            <div className="font-semibold text-sm text-black group-hover:text-black">
                              {wallet.name}
                            </div>
                            {wallet.badge && (
                              <div className="text-[11px] text-neutral-400 font-medium">
                                {connectingWalletId === wallet.id ? "Connecting…" : wallet.badge}
                              </div>
                            )}
                          </div>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>

                {/* Popular Section */}
                <div>
                  <div className="text-[11px] font-semibold text-neutral-400 tracking-wider uppercase mt-4 mb-2">
                    Popular
                  </div>
                  <div className="space-y-1.5">
                    {popularWallets.map((wallet) => (
                      <button
                        key={wallet.id}
                        onClick={() => handleWalletSelect(wallet)}
                        disabled={evm.connecting || hedera.connecting}
                        className="w-full flex items-center justify-between p-2 rounded-xl hover:bg-neutral-100 transition-colors text-left group cursor-pointer"
                      >
                        <div className="flex items-center gap-3">
                          <div className="w-9 h-9 rounded-xl bg-neutral-100 border border-neutral-200 flex items-center justify-center group-hover:border-black transition-colors shrink-0">
                            {wallet.icon}
                          </div>
                          <div>
                            <div className="font-semibold text-sm text-black group-hover:text-black">
                              {wallet.name}
                            </div>
                            {wallet.badge && (
                              <div className="text-[11px] text-neutral-400 font-medium">
                                {connectingWalletId === wallet.id ? "Connecting…" : wallet.badge}
                              </div>
                            )}
                          </div>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* RIGHT COLUMN: What is a Wallet? */}
        <div className="w-full md:w-[50%] p-6 md:p-7 flex flex-col justify-between bg-neutral-50/50">
          <div>
            <h3 className="text-lg font-bold text-center text-black mb-7 mt-1">
              What is a Wallet?
            </h3>

            <div className="space-y-6">
              {/* Feature 1: Digital Assets */}
              <div className="flex items-start gap-4">
                <div className="w-11 h-11 rounded-xl bg-white border border-neutral-200 flex items-center justify-center shrink-0 shadow-2xs">
                  <svg viewBox="0 0 24 24" className="w-6 h-6 fill-none stroke-black" strokeWidth="1.75">
                    <rect x="3" y="3" width="7" height="7" rx="1.5" />
                    <rect x="14" y="3" width="7" height="7" rx="1.5" />
                    <rect x="3" y="14" width="7" height="7" rx="1.5" />
                    <path d="M17.5 14.5l2 3.5-2 2.5-2-2.5 2-3.5z" fill="black" />
                  </svg>
                </div>
                <div>
                  <h4 className="font-bold text-sm text-black mb-1">
                    A Home for your Digital Assets
                  </h4>
                  <p className="text-xs text-neutral-600 leading-relaxed">
                    Wallets are used to send, receive, store, and display digital assets like Ethereum and NFTs.
                  </p>
                </div>
              </div>

              {/* Feature 2: New Way to Log In */}
              <div className="flex items-start gap-4">
                <div className="w-11 h-11 rounded-xl bg-white border border-neutral-200 flex items-center justify-center shrink-0 shadow-2xs">
                  <svg viewBox="0 0 24 24" className="w-6 h-6 fill-none stroke-black" strokeWidth="1.75">
                    <rect x="4" y="4" width="16" height="16" rx="4" />
                    <circle cx="12" cy="10" r="2.5" />
                    <path d="M8 17c0-2 1.8-3 4-3s4 1 4 3" strokeLinecap="round" />
                  </svg>
                </div>
                <div>
                  <h4 className="font-bold text-sm text-black mb-1">
                    A New Way to Log In
                  </h4>
                  <p className="text-xs text-neutral-600 leading-relaxed">
                    Instead of creating new accounts and passwords on every website, just connect your wallet.
                  </p>
                </div>
              </div>
            </div>
          </div>

          {/* Bottom Actions: Pure Black and White */}
          <div className="mt-8 pt-4 flex flex-col items-center gap-3">
            <a
              href="https://ethereum.org/en/wallets/find-wallet/"
              target="_blank"
              rel="noopener noreferrer"
              className="w-full max-w-[200px] text-center py-2.5 px-4 rounded-xl bg-black text-white text-xs font-semibold hover:bg-neutral-800 transition-colors shadow-xs"
            >
              Get a Wallet
            </a>
            <a
              href="https://ethereum.org/en/wallets/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs font-semibold text-neutral-500 hover:text-black hover:underline transition-all"
            >
              Learn More
            </a>
          </div>
        </div>

      </div>
    </div>,
    document.body
  );
}

export default WalletModal;
