import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// base "/" by default; for a GitHub Pages project subpath, set base to "/<repo>/".
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // allow importing the canonical Markdown chapters that live in ../guide
    fs: { allow: [".."] },
  },
});
