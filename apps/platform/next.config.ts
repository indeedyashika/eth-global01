import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // This app owns the public root — Hermes reverse-proxies its own admin
  // dashboard under /hermes instead. See src/lib/paths.ts.

  // Produce the minimal Node server embedded in the Hermes container.
  output: "standalone",
};

export default nextConfig;
