import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Produces a minimal, self-contained server bundle for the Docker image.
  output: "standalone",
  reactStrictMode: true,
  experimental: {
    // Keep server-only packages out of the client bundle.
    serverActions: {
      bodySizeLimit: "2mb",
    },
  },
};

export default nextConfig;
