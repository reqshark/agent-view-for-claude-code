import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// base "./" so built asset URLs are relative and can be rewritten to
// webview URIs by the extension host. Three HTML entry points: the sidebar
// Detail view (index.html), the sidebar Triage view (triage.html), and the
// editor-area Session Board (board.html).
export default defineConfig({
  plugins: [react()],
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2020",
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      input: {
        index: fileURLToPath(new URL("./index.html", import.meta.url)),
        triage: fileURLToPath(new URL("./triage.html", import.meta.url)),
        board: fileURLToPath(new URL("./board.html", import.meta.url)),
      },
    },
  },
});
