import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Strict Mode runs every effect twice in development, which doubles each page's API calls and, for anything uncached,
  // its Alpha Vantage and OpenAI calls (the free Alpha Vantage tier allows about 25 a day)
  reactStrictMode: false,
  // A self-contained server.js with only the modules it needs, for the Docker image
  output: "standalone",
};

export default nextConfig;
