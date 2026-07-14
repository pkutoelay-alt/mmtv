import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";
import { loadProjectEnv } from "./lib/load-env.mjs";
import {
  jsonContentChanged,
  readLocalJsonSnapshot,
} from "./lib/json-compare.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
loadProjectEnv(ROOT);

const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
const REPO = normalizeRepo(process.env.GITHUB_REPO || "");
const BRANCH = process.env.GITHUB_BRANCH || "main";
const SKIP_SCRAPE = process.env.SKIP_SCRAPE === "1";
const SKIP_TOKEN_CHECK = process.env.SKIP_TOKEN_CHECK === "1";
const OUTPUT_FILE = "movies.json";

const API_HEADERS = {
  Authorization: `Bearer ${TOKEN}`,
  Accept: "application/vnd.github+json",
  "User-Agent": "mmtvpro-movies-sync",
  "X-GitHub-Api-Version": "2022-11-28",
};

function normalizeRepo(value) {
  const trimmed = value.trim().replace(/\/$/, "");
  const match = trimmed.match(
    /(?:https?:\/\/)?github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/i
  );
  return match ? match[1] : trimmed;
}

function log(message) {
  console.error(`[movies-sync] ${message}`);
}

function run(command) {
  execSync(command, {
    cwd: ROOT,
    stdio: "inherit",
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    env: process.env,
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
      content: Buffer.from("mmtvpro-movies-check").toString("base64"),
      encoding: "base64",
    }),
  });

  if (res.status === 403) {
    throw new Error("GitHub token is read-only. Set Contents: Read and write.");
  }

  if (res.status === 404) {
    throw new Error(`Repository not found: ${REPO}`);
  }

  if (res.status === 409) {
    return;
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Token check failed (${res.status}): ${body.slice(0, 200)}`);
  }

  log("Token write access verified");
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
    throw new Error(`${filename} not found locally`);
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
}

async function main() {
  if (!TOKEN) {
    throw new Error("GITHUB_TOKEN (or GH_TOKEN) is not set in .env");
  }
  if (!REPO || REPO.includes("your-username")) {
    throw new Error("GITHUB_REPO is not set (example: username/mmtvpro)");
  }

  const beforeContent = readLocalJsonSnapshot(ROOT, OUTPUT_FILE);

  if (SKIP_SCRAPE) {
    log("Skipping scraper (SKIP_SCRAPE=1)");
  } else {
    log("Running movies.js...");
    run("node movies.js --save");
  }

  const localPath = path.join(ROOT, OUTPUT_FILE);
  if (!fs.existsSync(localPath)) {
    throw new Error(`${OUTPUT_FILE} was not created`);
  }

  const afterContent = fs.readFileSync(localPath, "utf8");
  if (!jsonContentChanged(beforeContent, afterContent)) {
    log(`No changes in ${OUTPUT_FILE}, skipping GitHub upload`);
    log("Movies sync complete");
    return;
  }

  log(`${OUTPUT_FILE} changed, uploading to GitHub`);
  await validateTokenWriteAccess();
  await uploadJsonFile(OUTPUT_FILE);
  log("Movies sync complete");
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
