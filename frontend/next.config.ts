import type { NextConfig } from "next";

// Rewrites send all /api/* requests to the backend. Default to
// http://localhost:4000 for host dev. In Docker the frontend image sets
// NEXT_PUBLIC_API_URL=http://backend:4000 in the Dockerfile so the same
// default resolves to the internal service hostname.
const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";

const nextConfig: NextConfig = {
  output: "standalone",
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${API_BASE}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
