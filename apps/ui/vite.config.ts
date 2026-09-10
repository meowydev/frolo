import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    port: 5273,
    proxy: {
      // Dev: proxy the API + SSE to the Fastify server on :4512.
      "/api": {
        target: "http://localhost:4512",
        changeOrigin: false,
        ws: true,
      },
    },
  },
});
