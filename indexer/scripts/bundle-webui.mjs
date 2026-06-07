// Build the webui (vite) and copy its output into indexer/webui-dist so the
// published @coffeectx/indexer ships a self-contained UI that coffeectx-ui
// serves. ui/server.ts resolves webui-dist next to dist/ at runtime.

import { execFileSync } from "node:child_process";
import { cpSync, rmSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const indexerDir = join(__dirname, "..");
const webuiDir = join(indexerDir, "..", "webui");
const dest = join(indexerDir, "webui-dist");

if (!existsSync(webuiDir)) {
  console.error(`bundle-webui: webui not found at ${webuiDir}; skipping.`);
  process.exit(0);
}

console.log("bundle-webui: building webui (vite)…");
execFileSync("npm", ["run", "build"], { cwd: webuiDir, stdio: "inherit" });

const built = join(webuiDir, "dist");
if (!existsSync(built)) {
  console.error(`bundle-webui: expected build output at ${built}`);
  process.exit(1);
}

rmSync(dest, { recursive: true, force: true });
cpSync(built, dest, { recursive: true });
console.log(`bundle-webui: copied ${built} -> ${dest}`);
