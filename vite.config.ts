import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@api": path.resolve(__dirname, "./artifacts/api-server/src"),
    },
  },
  build: {
    outDir: "dist/public",
    emptyOutDir: true,
  },
});
