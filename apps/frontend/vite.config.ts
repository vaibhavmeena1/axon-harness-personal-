import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import config from "./config.json" with { type: "json" };

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: config.VITE_BASE_PATH,
  server: {
    port: config.port,
    // In production the backend serves this build from its own origin, so the
    // app calls the API with relative URLs and needs no CORS. Proxying /api here
    // gives `vite dev` the same same-origin behaviour.
    proxy: {
      "/api": {
        target: config.DEV_API_PROXY_TARGET,
        changeOrigin: true,
      },
    },
  },
  preview: {
    port: config.port,
    proxy: {
      "/api": {
        target: config.DEV_API_PROXY_TARGET,
        changeOrigin: true,
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
      "@config": path.resolve(import.meta.dirname, "./config.json"),
    },
  },
});
