import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

const adminUiRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  root: adminUiRoot,
  base: "/",
  build: {
    outDir: "dist/client",
    emptyOutDir: true,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: "react-vendor",
              test: /node_modules[\\/](?:react|react-dom|react-router|react-router-dom)[\\/]/,
              priority: 30,
            },
            // Keep heavy, rarely-changing libraries out of the builder chunk
            // so they cache independently across admin releases.
            {
              name: "katex-vendor",
              test: /node_modules[\\/]katex[\\/]/,
              priority: 25,
            },
            {
              name: "motion-vendor",
              test: /node_modules[\\/](?:framer-motion|motion-dom|motion-utils)[\\/]/,
              priority: 25,
            },
            {
              name: "builder",
              test: /admin-ui[\\/]src[\\/]components[\\/]builder[\\/]/,
              priority: 20,
            },
            {
              name: "admin-settings",
              test: /admin-ui[\\/]src[\\/]pages[\\/]admin[\\/]settings[\\/]/,
              priority: 11,
            },
            {
              name: "admin-pages",
              test: /admin-ui[\\/]src[\\/]pages[\\/]admin[\\/]/,
              priority: 10,
            },
          ],
        },
      },
    },
  },
  resolve: {
    alias: {
      "@components": path.resolve(adminUiRoot, "src/components"),
      "@lib": path.resolve(adminUiRoot, "../src/lib"),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:3000",
    },
  },
});
