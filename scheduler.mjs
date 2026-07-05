import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import { loadProjectEnv } from "./lib/load-env.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
loadProjectEnv(ROOT);

const INTERVAL_MS =
  Number(process.env.SYNC_INTERVAL_MINUTES || 5) * 60 * 1000;

function log(message) {
  const stamp = new Date().toISOString();
  console.error(`[scheduler ${stamp}] ${message}`);
}

function runSync() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["sync-github.mjs"], {
      cwd: ROOT,
      stdio: "inherit",
      env: process.env,
    });

    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`sync-github.mjs exited with code ${code}`));
    });
  });
}

async function loop() {
  log(`Starting. Interval: ${INTERVAL_MS / 60000} minutes`);

  while (true) {
    try {
      await runSync();
    } catch (error) {
      log(`Sync failed: ${error.message}`);
    }

    log(`Waiting ${INTERVAL_MS / 60000} minutes...`);
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
}

loop().catch((error) => {
  console.error(error);
  process.exit(1);
});
