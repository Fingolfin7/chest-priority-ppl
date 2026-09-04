import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "./",
  resolve: {
    // Inline Automerge's WASM so installed/offline PWAs need no separately
    // fetched runtime and no extra WASM loader in Vite.
    alias: [{ find: /^@automerge\/automerge$/, replacement: new URL("./node_modules/@automerge/automerge/dist/mjs/entrypoints/fullfat_base64.js", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1") }],
  },
  server: {
    host: "127.0.0.1",
    port: 4173,
    strictPort: true,
  },
  plugins: [react()],
});
