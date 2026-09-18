import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  plugins: [vue()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    // Chromium and SQLite create short-lived locked files. They are runtime state, never source.
    watch: { ignored: ["**/src-tauri/**", "**/.browser-session/**", "**/.local-data/**", "**/.playwright-cli/**"] },
    proxy: {
      "/api": "http://127.0.0.1:3210",
      "/browser": {
        target: "http://127.0.0.1:3211",
        rewrite: (path) => path.replace(/^\/browser/, ""),
      },
    },
  },
});
