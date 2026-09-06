import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  // GitHub Pages serves this repo's own site at
  // https://<owner>.github.io/VRAVIO/, not at the domain's own root — every
  // asset URL Vite emits needs that prefix, or the deployed page 404s on
  // its own JS/WASM the moment it loads. Local dev and `vite preview` stay
  // at "/": only the Pages workflow (`.github/workflows/pages.yml`) sets
  // `GITHUB_PAGES=true` when it builds.
  base: process.env.GITHUB_PAGES ? "/VRAVIO/" : "/",
  plugins: [react()],
  publicDir: "../../icons",
  resolve: {
    dedupe: ["react", "react-dom"],
  },
  optimizeDeps: {
    include: ["react", "react-dom", "dockview-react"],
  },
  server: { port: 4173 },
  build: { target: "es2022" },
});
