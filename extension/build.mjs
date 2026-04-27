import { spawnSync } from "node:child_process";

const entries = ["background", "content", "popup"];

for (const entry of entries) {
  console.log(`\n--- Building ${entry} ---`);
  const result = spawnSync("npx", ["vite", "build"], {
    stdio: "inherit",
    env: { ...process.env, ENTRY: entry },
    shell: true,
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
