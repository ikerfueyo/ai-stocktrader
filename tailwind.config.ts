import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  // Bootstrap 4 (imported first in app/layout.tsx) provides the base styles
  corePlugins: {
    preflight: false,
  },
};

export default config;
