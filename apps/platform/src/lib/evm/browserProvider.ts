/**
 * Resolves the genuine MetaMask provider when multiple browser wallets
 * (like Phantom, Coinbase, Brave, etc.) are installed and inject into window.ethereum.
 * Uses EIP-6963 provider announcement as well as legacy window.ethereum.providers.
 */

let eip6963MetaMaskProvider: any = null;

if (typeof window !== "undefined") {
  window.addEventListener("eip6963:announceProvider", (event: any) => {
    const info = event.detail?.info;
    const provider = event.detail?.provider;
    if (info && provider) {
      if (info.rdns === "io.metamask" || info.name?.toLowerCase().includes("metamask")) {
        eip6963MetaMaskProvider = provider;
      }
    }
  });

  // Request providers to announce themselves
  try {
    window.dispatchEvent(new Event("eip6963:requestProvider"));
  } catch {
    // Ignore in non-browser context
  }
}

export function getMetaMaskProvider(): any {
  if (typeof window === "undefined") return undefined;
  const win = window as any;

  // 1. EIP-6963 announced MetaMask provider (Standard, immune to window.ethereum hijacking)
  if (eip6963MetaMaskProvider) {
    return eip6963MetaMaskProvider;
  }

  // 2. Check window.ethereum.providers array (standard EIP-5749 / multi-wallet injection)
  if (Array.isArray(win.ethereum?.providers) && win.ethereum.providers.length > 0) {
    // Specifically search for MetaMask that is NOT Phantom
    const genuineMetaMask = win.ethereum.providers.find(
      (p: any) => p.isMetaMask && !p.isPhantom && !p.isBraveWallet
    );
    if (genuineMetaMask) return genuineMetaMask;

    // Fallback: any provider where isPhantom is falsy
    const nonPhantom = win.ethereum.providers.find((p: any) => !p.isPhantom);
    if (nonPhantom) return nonPhantom;
  }

  // 3. Check window.ethereum directly
  if (win.ethereum) {
    // If window.ethereum is genuine MetaMask (and NOT Phantom)
    if (win.ethereum.isMetaMask && !win.ethereum.isPhantom) {
      return win.ethereum;
    }

    // If window.ethereum was hijacked by Phantom (isPhantom === true),
    // check if there is another provider in providers array
    if (win.ethereum.isPhantom && Array.isArray(win.ethereum.providers)) {
      const found = win.ethereum.providers.find((p: any) => p.isMetaMask && !p.isPhantom);
      if (found) return found;
    }

    // Check if _metamask property exists on window.ethereum
    if (win.ethereum._metamask && !win.ethereum.isPhantom) {
      return win.ethereum;
    }
  }

  // 4. Default fallback
  return win.ethereum;
}
