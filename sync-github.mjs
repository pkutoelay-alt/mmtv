import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { loadProjectEnv } from "./lib/load-env.mjs";
import {
  jsonContentChanged,
  readLocalJsonSnapshot,
} from "./lib/json-compare.mjs";

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
const SKIP_HIGHLIGHTS = process.env.SKIP_HIGHLIGHTS !== "0";
const SKIP_SCRAPE = process.env.SKIP_SCRAPE === "1";
const SKIP_TOKEN_CHECK = process.env.SKIP_TOKEN_CHECK === "1";

const UPLOAD_FILES = (process.env.SYNC_FILES || "soco.json,highlight.json,myanmartv.json")
  .split(",")
  .map((name) => name.trim())
  .filter(Boolean);

const API_HEADERS = {
  Authorization: `Bearer ${TOKEN}`,
  Accept: "application/vnd.github+json",
  "User-Agent": "mmtvpro-sync",
  "X-GitHub-Api-Version": "2022-11-28",
};

const READ_ONLY_HELP =
  "GitHub token is read-only. Open https://github.com/settings/tokens, edit the token, " +
  `set Repository permissions -> Contents: Read and write for ${REPO || "your-repo"}, ` +
  "then paste the new token into .env and run npm run sync again.";

function log(message) {
  console.error(`[sync] ${message}`);
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
    headers: { ...API_HEADERS, "Content-Type": "application/json" },
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
      log("Repository is empty; JSON upload will initialize it");
      return;
    }
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Token check failed (${res.status}): ${body.slice(0, 200)}`);
  }

  log("Token write access verified");
}

function runScraper(label, command) {
  try {
    log(`Running ${label}...`);
    run(command, { inherit: true });
  } catch (error) {
    const detail = error.stderr?.toString?.() || error.message || String(error);
    log(`${label} failed, continuing sync (${detail.split("\n")[0]})`);
  }
}

function runScrapers() {
  if (SKIP_SCRAPE) {
    log("Skipping scrapers (SKIP_SCRAPE=1)");
    return;
  }

  runScraper("soco.js", "node soco.js --save");
  runScraper("myanmartv.js", "node myanmartv.js --save");

  if (!SKIP_HIGHLIGHTS) {
    runScraper("highlight.js", "node highlight.js --save");
  } else {
    log("Skipping highlight.js (set SKIP_HIGHLIGHTS=0 to enable)");
  }
}

async function getRemoteFileSha(filename) {
  const res = await fetch(
    `https://api.github.com/repos/${REPO}/contents/${encodeURIComponent(filename)}?ref=${encodeURIComponent(BRANCH)}`,
    { headers: API_HEADERS }
  );

  if (res.status === 404) return null;
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Could not read ${filename} on GitHub (${res.status}): ${body.slice(0, 200)}`);
  }

  const data = await res.json();
  return data.sha || null;
}

async function uploadJsonFile(filename) {
  const localPath = path.join(ROOT, filename);
  if (!fs.existsSync(localPath)) {
    log(`Skipping ${filename} (not found locally)`);
    return false;
  }

  const content = fs.readFileSync(localPath);
  const sha = await getRemoteFileSha(filename);
  const stamp = new Date().toISOString();

  const res = await fetch(
    `https://api.github.com/repos/${REPO}/contents/${encodeURIComponent(filename)}`,
    {
      method: "PUT",
      headers: { ...API_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({
        message: `Update ${filename} ${stamp}`,
        content: content.toString("base64"),
        branch: BRANCH,
        ...(sha ? { sha } : {}),
      }),
    }
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Upload failed for ${filename} (${res.status}): ${body.slice(0, 200)}`);
  }

  log(`Uploaded ${filename}`);
  return true;
}

function snapshotUploadFiles() {
  const snapshots = new Map();

  for (const filename of UPLOAD_FILES) {
    snapshots.set(filename, readLocalJsonSnapshot(ROOT, filename));
  }

  return snapshots;
}

function getChangedUploadFiles(beforeSnapshots) {
  const changed = [];

  for (const filename of UPLOAD_FILES) {
    const localPath = path.join(ROOT, filename);
    if (!fs.existsSync(localPath)) {
      log(`Skipping ${filename} (not found locally after scrape)`);
      continue;
    }

    const beforeContent = beforeSnapshots.get(filename) ?? null;
    const afterContent = fs.readFileSync(localPath, "utf8");

    if (jsonContentChanged(beforeContent, afterContent)) {
      changed.push(filename);
    } else {
      log(`No changes in ${filename}`);
    }
  }

  return changed;
}

async function uploadJsonFiles(filenames = UPLOAD_FILES) {
  let uploaded = 0;

  for (const filename of filenames) {
    if (await uploadJsonFile(filename)) uploaded++;
  }

  if (uploaded === 0) {
    throw new Error("No JSON files were uploaded.");
  }

  log(`Uploaded ${uploaded} file(s) to ${REPO}`);
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

  const beforeSnapshots = snapshotUploadFiles();
  runScrapers();

  const changedFiles = getChangedUploadFiles(beforeSnapshots);
  if (changedFiles.length === 0) {
    log("No JSON changes detected, skipping GitHub upload");
    log("Sync complete");
    return;
  }

  log(`Changed files: ${changedFiles.join(", ")}`);
  await validateTokenWriteAccess();
  await uploadJsonFiles(changedFiles);
  log("Sync complete");
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
