/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./src/**/*.{js,jsx}"],
  // Bootstrap 4 (CDN, public/index.html) provides the base styles
  corePlugins: {
    preflight: false,
  },
};
