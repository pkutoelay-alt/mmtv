import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { loadProjectEnv } from "./lib/load-env.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
loadProjectEnv(ROOT);

const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
const REPO = normalizeRepo(process.env.GITHUB_REPO || "");

function normalizeRepo(value) {
  const trimmed = value.trim().replace(/\/$/, "");
  const match = trimmed.match(
    /(?:https?:\/\/)?github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/i
  );
  return match ? match[1] : trimmed;
}
const BRANCH = process.env.GITHUB_BRANCH || "main";
const GIT_NAME = process.env.GITHUB_NAME || "mmtvpro-bot";
const GIT_EMAIL = process.env.GITHUB_EMAIL || "bot@local";
const SKIP_HIGHLIGHTS = process.env.SKIP_HIGHLIGHTS !== "0";
const SKIP_SCRAPE = process.env.SKIP_SCRAPE === "1";

function log(message) {
  console.error(`[sync] ${message}`);
}

function run(command, options = {}) {
  execSync(command, {
    cwd: ROOT,
    stdio: options.inherit ? "inherit" : "pipe",
    encoding: "utf8",
    env: { ...process.env, ...options.env },
  });
}

function runCapture(command) {
  return execSync(command, { cwd: ROOT, encoding: "utf8" }).trim();
}

function ensureGitRepo() {
  if (fs.existsSync(path.join(ROOT, ".git"))) return;

  log("Initializing git repository...");
  try {
    run("git init -b main");
  } catch {
    run("git init");
    run(`git checkout -b ${BRANCH}`);
  }
}

function ensureRemote() {
  if (!TOKEN || !REPO) {
    throw new Error("Set GITHUB_TOKEN and GITHUB_REPO in .env or environment");
  }

  const remoteUrl = `https://x-access-token:${TOKEN}@github.com/${REPO}.git`;
  let remotes = "";

  try {
    remotes = runCapture("git remote");
  } catch {
    remotes = "";
  }

  if (!remotes.includes("origin")) {
    run(`git remote add origin "${remoteUrl}"`);
    return;
  }

  run(`git remote set-url origin "${remoteUrl}"`);
}

function runScrapers() {
  if (SKIP_SCRAPE) {
    log("Skipping scrapers (SKIP_SCRAPE=1)");
    return;
  }

  log("Running soco.js...");
  run("node soco.js --save", { inherit: true });

  log("Running myanmartv.js...");
  run("node myanmartv.js --save", { inherit: true });

  if (!SKIP_HIGHLIGHTS) {
    log("Running highlight.js...");
    run("node highlight.js --save", { inherit: true });
  } else {
    log("Skipping highlight.js (set SKIP_HIGHLIGHTS=0 to enable)");
  }
}

function commitAndPush() {
  run("git add -A");

  let status = "";
  try {
    status = runCapture("git status --porcelain");
  } catch {
    status = "";
  }

  if (!status) {
    log("No changes to commit");
    return;
  }

  const stamp = new Date().toISOString();
  const message = `Auto sync ${stamp}`;

  run(
    `git -c user.name="${GIT_NAME}" -c user.email="${GIT_EMAIL}" commit -m "${message}"`
  );
  log(`Committed: ${message}`);

  try {
    run(`git push -u origin ${BRANCH}`);
  } catch {
    log("Push failed, trying fetch/rebase then push...");
    try {
      run(`git fetch origin ${BRANCH}`);
      run(`git pull --rebase origin ${BRANCH}`);
    } catch {
      log("Remote branch missing or empty, continuing with push...");
    }
    run(`git push -u origin ${BRANCH}`);
  }

  log("Pushed to GitHub");
}

async function main() {
  if (!TOKEN) {
    throw new Error(
      "GITHUB_TOKEN (or GH_TOKEN) is not set. Add it to .env or set GITHUB_TOKEN_FILE."
    );
  }
  if (!REPO || REPO.includes("your-username")) {
    throw new Error("GITHUB_REPO is not set (example: username/mmtvpro)");
  }

  ensureGitRepo();
  ensureRemote();
  runScrapers();
  commitAndPush();
  log("Sync complete");
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
