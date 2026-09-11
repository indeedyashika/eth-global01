"use client";

import React, { useState } from "react";
import { useWallet } from "@/hooks/useWalletConnect";
import { useEvmWallet } from "@/hooks/useEvmWallet";
import { WalletModal } from "./WalletModal";

function shorten(accountId: string): string {
  return accountId.startsWith("0x")
    ? `${accountId.slice(0, 6)}…${accountId.slice(-4)}`
    : accountId;
}

export default function WalletConnectButton() {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const hedera = useWallet();
  const evm = useEvmWallet();

  const isConnected = Boolean(evm.accountId || hedera.accountId);

  return (
    <>
      <div className="app-wallet-control">
        {isConnected ? (
          <>
            {hedera.accountId && (
              <button
                onClick={() => setIsModalOpen(true)}
                title="Hedera wallet details"
                className="app-wallet-button is-connected cursor-pointer"
              >
                <span className="app-wallet-dot" aria-hidden="true" />
                <span>{shorten(hedera.accountId)}</span>
              </button>
            )}
            {evm.accountId && (
              <button
                onClick={() => setIsModalOpen(true)}
                title="EVM wallet details"
                className="app-wallet-button is-connected cursor-pointer"
              >
                <span className="app-wallet-dot" aria-hidden="true" />
                <span>{shorten(evm.accountId)}</span>
              </button>
            )}
            {!evm.accountId && (
              <button
                onClick={() => setIsModalOpen(true)}
                title="Connect EVM wallet"
                className="app-wallet-button cursor-pointer"
              >
                <span>+ Connect EVM</span>
              </button>
            )}
          </>
        ) : (
          <button
            onClick={() => setIsModalOpen(true)}
            disabled={evm.connecting || hedera.connecting}
            className="app-wallet-button cursor-pointer"
          >
            {evm.connecting || hedera.connecting ? "Connecting…" : "Connect Wallet"}
          </button>
        )}
      </div>

      <WalletModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
      />
    </>
  );
}

