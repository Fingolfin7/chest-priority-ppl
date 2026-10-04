import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

// Lists every built file so the service worker can precache assets that are not
// referenced from index.html (the Automerge WASM, lazily imported chunks).
function assetManifest(): Plugin {
  return {
    name: "rolling-ppl-asset-manifest",
    apply: "build",
    generateBundle(_options, bundle) {
      const files = Object.keys(bundle).filter((file) => file.startsWith("assets/")).map((file) => `./${file}`).sort();
      this.emitFile({ type: "asset", fileName: "asset-manifest.json", source: JSON.stringify(files) });
    },
  };
}

export default defineConfig({
  base: "./",
  resolve: {
    alias: [{ find: /^@automerge\/automerge$/, replacement: new URL("./src/automergeRuntime.ts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1") }],
  },
  server: {
    host: "127.0.0.1",
    port: 4173,
    strictPort: true,
  },
  plugins: [react(), assetManifest()],
});
