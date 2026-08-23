import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "./",
  server: {
    host: "127.0.0.1",
    port: 4173,
    strictPort: true,
  },
  plugins: [react()],
});
