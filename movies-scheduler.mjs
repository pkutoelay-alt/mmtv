import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import { loadProjectEnv } from "./lib/load-env.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
loadProjectEnv(ROOT);

const INTERVAL_MS =
  Number(process.env.MOVIES_SYNC_INTERVAL_DAYS || 15) *
  24 *
  60 *
  60 *
  1000;

function log(message) {
  const stamp = new Date().toISOString();
  console.error(`[movies-scheduler ${stamp}] ${message}`);
}

function runMoviesSync() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["sync-movies.mjs"], {
      cwd: ROOT,
      stdio: "inherit",
      env: process.env,
    });

    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`sync-movies.mjs exited with code ${code}`));
    });
  });
}

async function loop() {
  log(`Starting. Interval: ${INTERVAL_MS / (24 * 60 * 60 * 1000)} days`);

  while (true) {
    try {
      await runMoviesSync();
    } catch (error) {
      log(`Movies sync failed: ${error.message}`);
    }

    log(`Waiting ${INTERVAL_MS / (24 * 60 * 60 * 1000)} days...`);
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
}

loop().catch((error) => {
  console.error(error);
  process.exit(1);
});
