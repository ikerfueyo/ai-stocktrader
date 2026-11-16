import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Strict Mode runs every effect twice in development, which doubles each page's API calls and, for anything uncached,
  // its Alpha Vantage and OpenAI calls (the free Alpha Vantage tier allows about 25 a day)
  reactStrictMode: false,
  // Loaded by Node at runtime rather than bundled into the routes that use it: the OpenAI SDK is hundreds of modules
  serverExternalPackages: ["openai"],
};

export default nextConfig;
