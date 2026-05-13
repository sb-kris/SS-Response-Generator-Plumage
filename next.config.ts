import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Pins the tracing root to this project directory so Next.js doesn't walk
  // up and find ~/pnpm-lock.yaml, which would trigger the workspace-root warning.
  outputFileTracingRoot: path.resolve(__dirname),
  async headers() {
    return [
      {
        source: "/api/:path*",
        headers: [
          { key: "Cache-Control", value: "no-store, no-cache, must-revalidate" },
          { key: "X-Content-Type-Options", value: "nosniff" },
        ],
      },
    ];
  },
  async rewrites() {
    return [
      // The enablement deck (now branded "Flock") lives as a static HTML
      // file at public/deck/index.html. Without these rewrites the bare
      // /deck and /flock paths 404, because Next's static file serving
      // doesn't auto-resolve index.html the way Apache/nginx do.
      // Both URLs serve the same asset so existing /deck links keep
      // working while /flock matches the new brand.
      { source: "/deck", destination: "/deck/index.html" },
      { source: "/flock", destination: "/deck/index.html" },
    ];
  },
};

export default nextConfig;
