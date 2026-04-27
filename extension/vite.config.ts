import { defineConfig } from "vite";
import { resolve } from "path";
import { copyFileSync, mkdirSync } from "fs";

// Build each entry as a self-contained IIFE — Chrome content scripts cannot be
// ES modules. Service worker can be a module, but for consistency and to avoid
// shared chunks (which break content scripts), we inline everything per entry.
//
// Vite/Rollup only supports `inlineDynamicImports` with a single input, so we
// pick the entry from an env var and build all three in series via npm scripts.

const ENTRY = process.env.ENTRY ?? "background";

const entries: Record<string, string> = {
  background: "src/background.ts",
  content: "src/content.ts",
  popup: "src/popup.ts",
};

export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: ENTRY === "background", // only first entry clears the dir
    rollupOptions: {
      input: resolve(__dirname, entries[ENTRY]),
      output: {
        entryFileNames: `${ENTRY}.js`,
        format: "iife",
        inlineDynamicImports: true,
      },
    },
    target: "esnext",
    minify: false,
  },
  plugins: [
    {
      name: "copy-static",
      closeBundle() {
        // Only copy assets on the last build pass.
        if (ENTRY !== "popup") return;
        const dist = resolve(__dirname, "dist");
        mkdirSync(dist, { recursive: true });
        copyFileSync(resolve(__dirname, "src/manifest.json"), resolve(dist, "manifest.json"));
        copyFileSync(resolve(__dirname, "src/popup.html"), resolve(dist, "popup.html"));
      },
    },
  ],
});
