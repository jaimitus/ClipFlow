import path from "path";
import { fileURLToPath } from "url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";
import { defineConfig } from "vitest/config";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), viteSingleFile()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
  build: {
    target: "esnext",
    minify: "esbuild",
    cssMinify: true,
    // Optimizado para app desktop de alto rendimiento
    chunkSizeWarningLimit: 2000,
  },
  optimizeDeps: {
    include: ["react", "react-dom", "clsx", "tailwind-merge"],
  },
  // Mejoras de rendimiento para desarrollo
  server: {
    warmup: {
      clientFiles: ["./src/components/*", "./src/hooks/*"],
    },
  },
  // Previene re-renderizados innecesarios en React
  esbuild: {
    jsxInject: `import React from 'react'`,
  },
});
