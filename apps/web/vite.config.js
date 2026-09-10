import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: "127.0.0.1",
    port: 3000,
    proxy: {
      "/api": "http://127.0.0.1:5173",
      "/ws": { target: "ws://127.0.0.1:5173", ws: true },
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: (id) =>
          id.includes("/node_modules/three/") ? "three" : undefined,
      },
    },
  },
});
