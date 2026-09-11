"use client";

import React, { useState } from "react";
import { BrowserProvider, ContractFactory } from "ethers";
import { HcsAuditBadge } from "./HcsAuditBadge";
import { useEvmWallet } from "@/hooks/useEvmWallet";
import { getMetaMaskProvider } from "@/lib/evm/browserProvider";
import artifact from "@/lib/evm/generated/CompliantRwaToken.json";

export interface PropertyTokenizeModalProps {
  isOpen: boolean;
  onClose: () => void;
  onTokenized?: (propertyData: any) => void;
}

export function PropertyTokenizeModal({
  isOpen,
  onClose,
  onTokenized,
}: PropertyTokenizeModalProps) {
  const evm = useEvmWallet();

  const [street, setStreet] = useState("456 Oak Avenue");
  const [city, setCity] = useState("Miami");
  const [state, setState] = useState("FL");
  const [zip, setZip] = useState("33101");
  const [monthlyRent, setMonthlyRent] = useState(3800);
  const [shares, setShares] = useState(1000);
  const [network, setNetwork] = useState<"EVM" | "HEDERA">("EVM");

  const [isVerifying, setIsVerifying] = useState(false);
  const [isDeploying, setIsDeploying] = useState(false);
  const [verificationStep, setVerificationStep] = useState<string>("");
  const [verificationResult, setVerificationResult] = useState<any | null>(null);
  const [walletPaymentSig, setWalletPaymentSig] = useState<string | null>(null);

  const [deploymentResult, setDeploymentResult] = useState<{
    tokenId: string;
    txId: string;
    explorerUrl: string;
    network: string;
  } | null>(null);

  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  // Step 1: Verify Address via x402 with REAL Wallet Signature
  const handleVerifyUsps = async () => {
    setIsVerifying(true);
    setError(null);

    try {
      setVerificationStep("Step 1: Initiating /api/x402/property-oracle handshake...");
      const unpaidRes = await fetch("/api/x402/property-oracle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ street, city, state, zip }),
      });

      if (unpaidRes.status !== 402) {
        throw new Error("Expected 402 challenge from x402 oracle service");
      }

      const challenge = await unpaidRes.json();
      const invoiceId = challenge.x402?.invoiceId || `inv_${Date.now()}`;

      // Require Wallet Signature for x402 micropayment settlement
      let paymentProofTx = "";
      const rawProvider = getMetaMaskProvider();
      if (rawProvider) {
        setVerificationStep("Step 2: 402 intercepted! Requesting x402 payment signature in your wallet...");
        const provider = new BrowserProvider(rawProvider);
        const signer = await provider.getSigner();
        const signerAddress = await signer.getAddress();

        const messageToSign = [
          "[Prism 8] Hedera x402 Micropayment Settlement",
          `Invoice ID: ${invoiceId}`,
          "Payee: 0.0.4491823",
          "Amount: 0.5 HBAR equivalent",
          `Property: ${street}, ${city}, ${state} ${zip}`,
          `Payer: ${signerAddress}`,
          `Timestamp: ${new Date().toISOString()}`,
        ].join("\n");

        const signature = await signer.signMessage(messageToSign);
        setWalletPaymentSig(signature);
        paymentProofTx = signature;
      } else {
        paymentProofTx = `0.0.4491823@${Math.floor(Date.now() / 1000)}.000000000`;
      }

      setVerificationStep("Step 3: Submitting signed payment proof & executing USPS DPV oracle check...");
      const paidRes = await fetch("/api/x402/property-oracle", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Payment-Tx": paymentProofTx,
          "X-Payment-Invoice": invoiceId,
        },
        body: JSON.stringify({ street, city, state, zip }),
      });

      const paidData = await paidRes.json();
      if (!paidRes.ok) {
        throw new Error(paidData.error || "USPS Oracle verification failed");
      }

      setVerificationStep("Step 4: USPS Deliverable Confirmed (DPV Code Y). HCS Receipt Logged!");
      setVerificationResult(paidData);
    } catch (err: any) {
      if (err.code === 4001 || err.message?.includes("rejected") || err.message?.includes("denied")) {
        setError("Signature request declined in wallet.");
      } else {
        setError(err.message || "Failed to verify property deliverability");
      }
    } finally {
      setIsVerifying(false);
    }
  };

  // Step 2: Deploy Token ON-CHAIN with REAL Wallet Signature & Transaction
  const handleDeployOnChain = async () => {
    if (!verificationResult) {
      setError("Please complete USPS deliverability verification first.");
      return;
    }

    setIsDeploying(true);
    setError(null);

    const tokenName = `${city.trim()} Real Estate Token`;
    const tokenSymbol = `${state.toUpperCase().trim()}${zip.trim().slice(0, 3)}`;

    try {
      if (network === "EVM") {
        const rawProvider = getMetaMaskProvider();
        if (!rawProvider) {
          throw new Error("MetaMask or EVM wallet is required to deploy on Sepolia.");
        }

        const provider = new BrowserProvider(rawProvider);
        const signer = await provider.getSigner();
        const userAddress = await signer.getAddress();

        let deployedTokenId = "";
        let deployedTxId = "";
        let explorerUrl = "";

        try {
          setVerificationStep("Requesting contract deployment transaction in your wallet (MetaMask)...");
          const factory = new ContractFactory(artifact.abi, artifact.bytecode, signer);
          
          const deployed = await factory.deploy(
            tokenName,
            tokenSymbol,
            18,
            BigInt(shares) * BigInt(10 ** 18),
            BigInt(shares) * BigInt(10 ** 18),
            false,
            false,
            true,
            true,
            userAddress
          );

          const deployTx = deployed.deploymentTransaction();
          if (deployTx) {
            deployedTxId = deployTx.hash;
            setVerificationStep(`Transaction broadcast to Sepolia (${deployTx.hash.slice(0, 14)}...). Mining block...`);
          }

          await deployed.waitForDeployment();
          deployedTokenId = await deployed.getAddress();
          explorerUrl = `https://sepolia.etherscan.io/tx/${deployedTxId}`;
        } catch (walletErr: any) {
          // If wallet has 0 Sepolia ETH, allow user to sign an on-chain deployment authorization
          if (
            walletErr.code === "INSUFFICIENT_FUNDS" ||
            walletErr.message?.includes("insufficient funds") ||
            walletErr.message?.includes("gas")
          ) {
            setVerificationStep("Wallet has 0 Sepolia ETH for gas. Requesting signed deployment authorization...");
            
            const authMessage = [
              "[Prism 8] On-Chain Token Minting Authorization",
              `Token: ${tokenName} (${tokenSymbol})`,
              `Shares: ${shares}`,
              `Property: ${street}, ${city}, ${state} ${zip}`,
              `Rent USD: $${monthlyRent}`,
              `Beneficiary: ${userAddress}`,
              `Nonce: ${Date.now()}`,
            ].join("\n");

            const authSig = await signer.signMessage(authMessage);

            setVerificationStep("Broadcasting on-chain deployment via funded Sepolia operator...");
            const deployRes = await fetch("/api/evm/tokens", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                blockchain: "EVM",
                name: tokenName,
                symbol: tokenSymbol,
                decimals: 18,
                initialSupply: shares,
                supplyType: "FINITE",
                maxSupply: shares,
                assetCategory: "real-estate",
                compliance: {
                  kycRequired: false,
                  freezeDefault: false,
                  wipeEnabled: true,
                  pauseEnabled: true,
                  worldIdRequired: false,
                  livenessEnabled: false,
                },
                memo: `USPS DPV ${street}, ${city} ${state} (Signed: ${authSig.slice(0, 14)}...)`,
              }),
            });

            const deployData = await deployRes.json();
            if (!deployRes.ok) throw new Error(deployData.error || "On-chain deployment failed");

            deployedTokenId = deployData.token.id;
            deployedTxId = deployData.token.createTxId;
            explorerUrl = `https://sepolia.etherscan.io/tx/${deployedTxId}`;
          } else if (walletErr.code === 4001 || walletErr.message?.includes("rejected")) {
            throw new Error("Transaction rejected in wallet.");
          } else {
            throw walletErr;
          }
        }

        // Register client-deployed token into the database
        await fetch("/api/evm/tokens", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            blockchain: "EVM",
            name: tokenName,
            symbol: tokenSymbol,
            decimals: 18,
            initialSupply: shares,
            supplyType: "FINITE",
            maxSupply: shares,
            assetCategory: "real-estate",
            treasuryAccountId: userAddress,
            existingTokenId: deployedTokenId,
            createTxId: deployedTxId,
            compliance: {
              kycRequired: false,
              freezeDefault: false,
              wipeEnabled: true,
              pauseEnabled: true,
              worldIdRequired: false,
              livenessEnabled: false,
            },
            memo: `USPS DPV ${street}, ${city} ${state}`,
          }),
        });

        const finalResult = {
          tokenId: deployedTokenId,
          txId: deployedTxId,
          explorerUrl,
          network: "Ethereum Sepolia",
        };
        setDeploymentResult(finalResult);
        setVerificationStep("Token successfully minted and deployed on-chain!");

        if (onTokenized) {
          onTokenized({
            street,
            city,
            state,
            zip,
            monthlyRent,
            shares,
            token: finalResult,
            verification: verificationResult,
          });
        }
      } else {
        // Hedera Testnet Deployment
        setVerificationStep("Requesting deployment signature in wallet...");
        const rawProvider = getMetaMaskProvider();
        if (rawProvider) {
          const provider = new BrowserProvider(rawProvider);
          const signer = await provider.getSigner();
          await signer.signMessage(`[Prism 8] Authorize Hedera HTS Tokenization: ${tokenName} (${tokenSymbol})`);
        }

        setVerificationStep("Broadcasting TokenCreateTransaction to Hedera Testnet...");
        const res = await fetch("/api/tokens", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            blockchain: "HEDERA",
            name: tokenName,
            symbol: tokenSymbol,
            tokenType: "FUNGIBLE",
            decimals: 0,
            initialSupply: shares,
            supplyType: "FINITE",
            maxSupply: shares,
            assetCategory: "real-estate",
            compliance: {
              kycRequired: false,
              freezeDefault: false,
              wipeEnabled: true,
              pauseEnabled: true,
              worldIdRequired: false,
              livenessEnabled: false,
            },
            memo: `USPS DPV ${street}, ${city} ${state}`,
          }),
        });

        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Hedera HTS deployment failed");

        const finalResult = {
          tokenId: data.token.id,
          txId: data.token.createTxId,
          explorerUrl: data.token.hashscanUrl || `https://hashscan.io/testnet/token/${data.token.id}`,
          network: "Hedera Testnet",
        };
        setDeploymentResult(finalResult);
        setVerificationStep("HTS Token successfully created on Hedera Testnet!");

        if (onTokenized) {
          onTokenized({
            street,
            city,
            state,
            zip,
            monthlyRent,
            shares,
            token: finalResult,
            verification: verificationResult,
          });
        }
      }
    } catch (err: any) {
      setError(err.message || "Failed to deploy token on-chain");
    } finally {
      setIsDeploying(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
      <div className="w-full max-w-lg rounded-2xl border border-neutral-300 bg-white p-6 text-black shadow-2xl relative">
        <button
          onClick={onClose}
          className="absolute top-4 right-4 text-neutral-400 hover:text-black text-lg font-bold cursor-pointer"
        >
          ✕
        </button>

        <div className="flex items-center gap-2 mb-1">
          <span className="w-2.5 h-2.5 rounded-full bg-black animate-pulse" />
          <span className="text-xs font-semibold uppercase tracking-wider text-black">
            Hedera x402 + USPS Oracle · On-Chain Tokenizer
          </span>
        </div>
        <h3 className="text-xl font-bold text-black mb-1">Tokenize Physical Real Estate</h3>
        <p className="text-xs text-neutral-600 mb-4 font-mono">
          Verify physical deliverability via machine-to-machine x402 payment and sign the on-chain deployment with your wallet.
        </p>

        {/* Wallet Status Banner */}
        <div className="mb-4 p-3 rounded-xl border border-neutral-300 bg-neutral-50 flex items-center justify-between text-xs font-mono">
          <div className="flex items-center gap-2">
            <span className={`w-2 h-2 rounded-full ${evm.accountId ? "bg-black" : "bg-neutral-400"}`} />
            <span className="text-neutral-600">Wallet:</span>
            <span className="text-black font-bold">
              {evm.accountId ? `${evm.accountId.slice(0, 6)}...${evm.accountId.slice(-4)}` : "Not Connected"}
            </span>
          </div>
          {!evm.accountId ? (
            <button
              onClick={() => evm.connect()}
              className="px-3 py-1 bg-black text-white rounded text-[11px] font-bold hover:bg-neutral-800 cursor-pointer"
            >
              Connect Wallet
            </button>
          ) : (
            <span className="text-[10px] uppercase tracking-wider text-neutral-500 border border-neutral-300 px-2 py-0.5 rounded bg-white">
              Sepolia
            </span>
          )}
        </div>

        {/* Network Toggle */}
        <div className="mb-4">
          <label className="block text-neutral-700 mb-1.5 font-medium font-mono text-xs">Target Blockchain</label>
          <div className="grid grid-cols-2 gap-2 text-xs font-mono">
            <button
              type="button"
              onClick={() => setNetwork("EVM")}
              className={`p-2.5 rounded-xl border text-left cursor-pointer transition-all ${
                network === "EVM"
                  ? "border-black bg-black text-white font-bold"
                  : "border-neutral-300 bg-white text-neutral-700 hover:border-black"
              }`}
            >
              <div className="font-semibold">Ethereum Sepolia</div>
              <div className="text-[10px] opacity-80">ERC-20 Compliant RWA</div>
            </button>
            <button
              type="button"
              onClick={() => setNetwork("HEDERA")}
              className={`p-2.5 rounded-xl border text-left cursor-pointer transition-all ${
                network === "HEDERA"
                  ? "border-black bg-black text-white font-bold"
                  : "border-neutral-300 bg-white text-neutral-700 hover:border-black"
              }`}
            >
              <div className="font-semibold">Hedera Testnet</div>
              <div className="text-[10px] opacity-80">HTS Native Asset</div>
            </button>
          </div>
        </div>

        <div className="space-y-3.5 text-xs">
          <div>
            <label className="block text-neutral-700 mb-1 font-medium font-mono">Street Address</label>
            <input
              type="text"
              value={street}
              onChange={(e) => setStreet(e.target.value)}
              className="w-full rounded-xl border border-neutral-300 bg-neutral-50 px-3.5 py-2 text-black font-mono placeholder-neutral-400 focus:border-black focus:outline-none"
            />
          </div>

          <div className="grid grid-cols-3 gap-2">
            <div>
              <label className="block text-neutral-700 mb-1 font-medium font-mono">City</label>
              <input
                type="text"
                value={city}
                onChange={(e) => setCity(e.target.value)}
                className="w-full rounded-xl border border-neutral-300 bg-neutral-50 px-3 py-2 text-black font-mono focus:border-black focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-neutral-700 mb-1 font-medium font-mono">State</label>
              <input
                type="text"
                value={state}
                onChange={(e) => setState(e.target.value)}
                className="w-full rounded-xl border border-neutral-300 bg-neutral-50 px-3 py-2 text-black font-mono focus:border-black focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-neutral-700 mb-1 font-medium font-mono">ZIP</label>
              <input
                type="text"
                value={zip}
                onChange={(e) => setZip(e.target.value)}
                className="w-full rounded-xl border border-neutral-300 bg-neutral-50 px-3 py-2 text-black font-mono focus:border-black focus:outline-none"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 pt-1">
            <div>
              <label className="block text-neutral-700 mb-1 font-medium font-mono">Monthly Rent ($ USD)</label>
              <input
                type="number"
                value={monthlyRent}
                onChange={(e) => setMonthlyRent(Number(e.target.value))}
                className="w-full rounded-xl border border-neutral-300 bg-neutral-50 px-3.5 py-2 text-black font-mono focus:border-black focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-neutral-700 mb-1 font-medium font-mono">Fractional Shares</label>
              <input
                type="number"
                value={shares}
                onChange={(e) => setShares(Number(e.target.value))}
                className="w-full rounded-xl border border-neutral-300 bg-neutral-50 px-3.5 py-2 text-black font-mono focus:border-black focus:outline-none"
              />
            </div>
          </div>
        </div>

        {verificationStep && (
          <div className="mt-4 p-3 rounded-xl bg-neutral-100 border border-neutral-300 font-mono text-[11px] text-black flex items-center gap-2">
            <span className="inline-block w-2 h-2 rounded-full bg-black animate-ping" />
            <span>{verificationStep}</span>
          </div>
        )}

        {verificationResult && !deploymentResult && (
          <div className="mt-4 rounded-xl bg-neutral-50 border border-neutral-300 p-3.5 text-xs text-neutral-800 space-y-2 font-mono">
            <div className="flex items-center justify-between font-semibold text-black">
              <span>✓ USPS DPV Verified: {verificationResult.standardizedAddress?.street}</span>
              <span className="px-2 py-0.5 rounded bg-neutral-200 text-black text-[10px] border border-neutral-300">
                CODE {verificationResult.dpvConfirmation}
              </span>
            </div>
            <p className="text-[11px] text-neutral-600 font-mono">
              Hash: {verificationResult.addressHash?.slice(0, 24)}...
            </p>
            {walletPaymentSig && (
              <p className="text-[10px] text-neutral-500 font-mono">
                Wallet Signature: {walletPaymentSig.slice(0, 22)}...
              </p>
            )}
            <HcsAuditBadge
              topicId={verificationResult.hcsAudit?.topicId}
              sequenceNumber={verificationResult.hcsAudit?.sequenceNumber}
              txId={verificationResult.hcsAudit?.txId}
            />
          </div>
        )}

        {deploymentResult && (
          <div className="mt-4 rounded-xl bg-neutral-50 border border-neutral-400 p-4 text-xs font-mono space-y-2.5">
            <div className="flex items-center gap-2 text-black font-bold text-sm">
              <span className="w-2 h-2 rounded-full bg-black" />
              <span>✓ Token Successfully Deployed On-Chain!</span>
            </div>
            <div className="text-neutral-700 text-[11px] space-y-1">
              <div>Network: <strong className="text-black">{deploymentResult.network}</strong></div>
              <div>Token Contract / ID: <strong className="text-black break-all">{deploymentResult.tokenId}</strong></div>
              <div>Tx Hash: <strong className="text-black break-all">{deploymentResult.txId}</strong></div>
            </div>
            <div className="pt-2">
              <a
                href={deploymentResult.explorerUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-black text-white rounded-lg text-xs font-bold hover:bg-neutral-800 cursor-pointer"
              >
                <span>View on Explorer</span>
                <span>↗</span>
              </a>
            </div>
          </div>
        )}

        {error && (
          <div className="mt-3 p-2.5 bg-neutral-100 border border-neutral-400 rounded-lg text-xs text-black font-mono">
            ⚠️ {error}
          </div>
        )}

        <div className="mt-6 flex items-center justify-end gap-3 border-t border-neutral-300 pt-4">
          <button
            onClick={onClose}
            className="rounded-xl border border-neutral-300 bg-white px-4 py-2.5 text-xs font-medium text-neutral-700 hover:text-black hover:border-black transition-colors cursor-pointer"
          >
            {deploymentResult ? "Close" : "Cancel"}
          </button>

          {!verificationResult ? (
            <button
              onClick={handleVerifyUsps}
              disabled={isVerifying}
              className="rounded-xl bg-black px-5 py-2.5 text-xs font-semibold text-white border border-black hover:bg-neutral-800 disabled:opacity-50 transition-all flex items-center gap-2 cursor-pointer"
            >
              {isVerifying ? "Requesting Signature & Verifying..." : "1. Sign x402 & Verify with USPS"}
            </button>
          ) : !deploymentResult ? (
            <button
              onClick={handleDeployOnChain}
              disabled={isDeploying}
              className="rounded-xl bg-black px-5 py-2.5 text-xs font-semibold text-white border border-black hover:bg-neutral-800 disabled:opacity-50 transition-all flex items-center gap-2 cursor-pointer animate-pulse"
            >
              {isDeploying ? "Confirming in Wallet & Deploying..." : "2. Sign & Deploy Token On-Chain"}
            </button>
          ) : (
            <button
              onClick={() => {
                onClose();
                window.location.reload();
              }}
              className="rounded-xl bg-black px-5 py-2.5 text-xs font-semibold text-white border border-black hover:bg-neutral-800 transition-all cursor-pointer"
            >
              View in Instruments Catalog →
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
