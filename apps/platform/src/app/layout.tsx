import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import "./globals.css";
import { WalletProvider } from "@/hooks/useWalletConnect";
import { EvmWalletProvider } from "@/hooks/useEvmWallet";
import WalletConnectButton from "@/components/WalletConnectButton";

const getAppUrl = () => {
  const envUrl = process.env.TOKENIZATION_APP_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3000");
  try {
    return new URL(envUrl.startsWith("http") ? envUrl : `https://${envUrl}`);
  } catch {
    return new URL("http://localhost:3000");
  }
};

export const metadata: Metadata = {
  metadataBase: getAppUrl(),
  title: "Prism 8 · Real-Estate Yield Streaming Engine",
  description:
    "Decentralized real-estate yield streaming platform powered by Hedera x402, The Graph, and Superfluid.",
  openGraph: {
    title: "Prism 8",
    description: "Autonomous real-estate yield streaming with Hedera x402, The Graph, and Superfluid.",
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-screen bg-white text-black font-mono antialiased flex flex-col">
        <WalletProvider>
          <EvmWalletProvider>
            <header className="py-5 border-b border-border bg-white/95 backdrop-blur sticky top-0 z-50 font-mono">
              <div className="max-w-7xl mx-auto px-4 sm:px-6 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <Link href="/" className="flex items-center gap-2.5">
                    {/* Empty logo container - add logo image here later */}
                    <div className="w-8 h-8 rounded border border-dashed border-black bg-neutral-100 flex items-center justify-center text-xs text-neutral-400" aria-label="Logo placeholder" />
                    <h1 className="text-lg md:text-xl font-bold font-mono text-black tracking-tight">
                      Prism 8
                    </h1>
                  </Link>
                  <span className="hidden md:inline-flex text-[11px] px-2.5 py-0.5 rounded-none font-mono bg-neutral-100 text-black border border-neutral-300">
                    Hedera x402 · Superfluid · The Graph
                  </span>
                </div>
                <nav className="flex items-center gap-3" aria-label="Account actions">
                  <a
                    href="/hermes?force=1"
                    className="bg-black text-white px-4 py-2 border border-black hover:bg-neutral-800 transition-colors font-mono text-xs font-semibold flex items-center gap-1.5"
                    aria-label="Open Hermes admin"
                  >
                    <span>Hermes Console</span>
                  </a>
                  <WalletConnectButton />
                </nav>
              </div>
            </header>
            <main className="flex-1 bg-white text-black">{children}</main>
            <footer className="border-t border-border py-8 bg-white font-mono text-xs text-neutral-600 mt-auto">
              <div className="max-w-7xl mx-auto px-4 sm:px-6 flex flex-col sm:flex-row items-center justify-between gap-4">
                <div className="flex items-center gap-2">
                  <span className="font-bold text-black">Prism 8</span>
                  <span>·</span>
                  <span>Autonomous Real-Estate Yield Streaming Engine</span>
                </div>
                <div className="flex items-center gap-4">
                  <a href="/.well-known/agent-services.json" target="_blank" className="hover:text-black transition-colors">
                    Agent Directory
                  </a>
                  <a href="/api/x402/property-oracle" target="_blank" className="hover:text-black transition-colors">
                    x402 Oracle
                  </a>
                  <a href="/api/subgraph" target="_blank" className="hover:text-black transition-colors">
                    The Graph
                  </a>
                </div>
              </div>
            </footer>
          </EvmWalletProvider>
        </WalletProvider>
      </body>
    </html>
  );
}
