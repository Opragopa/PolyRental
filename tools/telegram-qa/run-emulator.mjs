import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// Published 0.1.1 calls Bun.serve, despite advertising Node support.
const localBun = fileURLToPath(new URL("vendor/package/bin/bun.exe", import.meta.url));
const bun = process.env.BUN_EXECUTABLE || (existsSync(localBun) ? localBun : "bun");
const child = spawn(bun, [fileURLToPath(import.meta.resolve("tg-mini-app-emulator")),
  "--config", "emulator.config.json", "--profile", "channel_inline", "--no-open", ...process.argv.slice(2)], {stdio:"inherit"});
child.on("error", error => { console.error(`Install Bun or set BUN_EXECUTABLE: ${error.message}`); process.exitCode = 1; });
child.on("exit", code => { process.exitCode = code ?? 1; });
process.on("SIGINT", () => child.kill("SIGINT"));
