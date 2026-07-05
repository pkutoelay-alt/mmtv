import { execSync, spawnSync } from "child_process";
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
const SKIP_TOKEN_CHECK = process.env.SKIP_TOKEN_CHECK === "1";

const READ_ONLY_HELP =
  "GitHub token is read-only. Open https://github.com/settings/tokens, edit the token, " +
  `set Repository permissions -> Contents: Read and write for ${REPO || "your-repo"}, ` +
  "then paste the new token into .env and run npm run sync again.";

function log(message) {
  console.error(`[sync] ${message}`);
}

function authRemoteUrl() {
  return `https://x-access-token:${encodeURIComponent(TOKEN)}@github.com/${REPO}.git`;
}

function runGit(...argv) {
  let options = {};
  const last = argv[argv.length - 1];
  if (last && typeof last === "object" && "allowFail" in last) {
    options = argv.pop();
  }

  const result = spawnSync(
    "git",
    ["-c", "credential.helper=", ...argv],
    {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    }
  );

  const detail = `${result.stderr || ""}${result.stdout || ""}`.trim();

  if (result.status !== 0) {
    if (options.allowFail) return detail;
    throw new Error(formatGitError(detail || `git ${argv.join(" ")} failed`));
  }

  return detail;
}

function formatGitError(message) {
  if (/403|denied|read.?only/i.test(message)) {
    return `${message}\n\n${READ_ONLY_HELP}`;
  }
  return message;
}

function run(command, options = {}) {
  execSync(command, {
    cwd: ROOT,
    stdio: options.inherit ? "inherit" : "pipe",
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    env: { ...process.env, ...options.env },
  });
}

async function validateTokenWriteAccess() {
  if (SKIP_TOKEN_CHECK) {
    log("Skipping token write check (SKIP_TOKEN_CHECK=1)");
    return;
  }

  const res = await fetch(`https://api.github.com/repos/${REPO}/git/blobs`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "mmtvpro-sync",
    },
    body: JSON.stringify({
      content: Buffer.from("mmtvpro-check").toString("base64"),
      encoding: "base64",
    }),
  });

  if (res.status === 403) {
    throw new Error(READ_ONLY_HELP);
  }

  if (res.status === 404) {
    throw new Error(`Repository not found: ${REPO}. Create it on GitHub first.`);
  }

  if (res.status === 409) {
    const body = await res.text();
    if (/empty/i.test(body)) {
      log("Repository is empty; token check passed, first push will initialize it");
      return;
    }
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Token check failed (${res.status}): ${body.slice(0, 200)}`);
  }

  log("Token write access verified");
}

function ensureGitRepo() {
  if (fs.existsSync(path.join(ROOT, ".git"))) return;

  log("Initializing git repository...");
  try {
    runGit("init", "-b", BRANCH);
  } catch {
    runGit("init");
    runGit("checkout", "-b", BRANCH);
  }
}

function ensureRemote() {
  if (!TOKEN || !REPO) {
    throw new Error("Set GITHUB_TOKEN and GITHUB_REPO in .env or environment");
  }

  const remoteUrl = authRemoteUrl();
  let remotes = "";

  try {
    remotes = runGit("remote");
  } catch {
    remotes = "";
  }

  if (!remotes.includes("origin")) {
    runGit("remote", "add", "origin", remoteUrl);
    return;
  }

  runGit("remote", "set-url", "origin", remoteUrl);
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
  runGit("add", "-A");

  const status = runGit("status", "--porcelain", { allowFail: true });
  if (!status) {
    log("No changes to commit");
    pushToGitHub();
    return;
  }

  const stamp = new Date().toISOString();
  const message = `Auto sync ${stamp}`;

  runGit(
    "-c",
    `user.name=${GIT_NAME}`,
    "-c",
    `user.email=${GIT_EMAIL}`,
    "commit",
    "-m",
    message
  );
  log(`Committed: ${message}`);
  pushToGitHub();
}

function pushToGitHub() {
  try {
    runGit("push", "-u", "origin", BRANCH);
    log("Pushed to GitHub");
    return;
  } catch (firstError) {
    const msg = firstError.message || "";
    if (!/non-fast-forward|fetch first|rejected|diverged/i.test(msg)) {
      throw firstError;
    }
    log("Remote has new commits, rebasing then pushing...");
  }

  runGit("fetch", "origin", BRANCH);
  runGit("pull", "--rebase", "--autostash", "origin", BRANCH);
  runGit("push", "-u", "origin", BRANCH);
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

  await validateTokenWriteAccess();
  ensureGitRepo();
  ensureRemote();
  runScrapers();
  commitAndPush();
  log("Sync complete");
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
