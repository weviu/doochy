import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The app is served under /app by the bot's Express server, so all built asset
// URLs must be prefixed with /app/.
export default defineConfig({
  base: "/app/",
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    // Local dev: proxy /api to the running bot so the SPA can be developed
    // against live data (pass a valid initData via the app when testing auth).
    proxy: {
      "/api": "http://127.0.0.1:9009",
    },
  },
});
