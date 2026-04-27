import { defineConfig } from "vite";
import { resolve } from "path";
import { copyFileSync, mkdirSync } from "fs";

export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        background: resolve(__dirname, "src/background.ts"),
        content: resolve(__dirname, "src/content.ts"),
        popup: resolve(__dirname, "src/popup.ts"),
      },
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "[name].js",
        assetFileNames: "[name].[ext]",
        format: "esm",
      },
    },
    target: "esnext",
    minify: false,
  },
  plugins: [
    {
      name: "copy-static",
      closeBundle() {
        const dist = resolve(__dirname, "dist");
        mkdirSync(dist, { recursive: true });
        copyFileSync(resolve(__dirname, "src/manifest.json"), resolve(dist, "manifest.json"));
        copyFileSync(resolve(__dirname, "src/popup.html"), resolve(dist, "popup.html"));
      },
    },
  ],
});
