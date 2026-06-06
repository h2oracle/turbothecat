import { defineConfig } from "vite";

// Tauri expects a fixed port and ignores the dist during dev.
export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      // Don't watch the Rust side — Tauri handles that.
      ignored: ["**/src-tauri/**"],
    },
  },
  build: {
    target: "es2021",
    minify: false,
    sourcemap: true,
  },
});
