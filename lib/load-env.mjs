import fs from "fs";
import path from "path";

export function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;

  for (const line of fs.readFileSync(filePath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;

    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (!process.env[key]) process.env[key] = value;
  }
}

export function loadProjectEnv(root) {
  loadEnvFile(path.join(root, ".env"));

  const tokenFile = process.env.GITHUB_TOKEN_FILE;
  if (!process.env.GITHUB_TOKEN && !process.env.GH_TOKEN && tokenFile) {
    const filePath = path.isAbsolute(tokenFile)
      ? tokenFile
      : path.join(root, tokenFile);
    if (fs.existsSync(filePath)) {
      const token = fs.readFileSync(filePath, "utf8").trim();
      if (token) process.env.GITHUB_TOKEN = token;
    }
  }
}
