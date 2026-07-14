import fs from "fs";
import path from "path";

const IGNORED_KEYS = new Set(["scraped_at", "count"]);

const VOLATILE_QUERY_KEYS = new Set([
  "token",
  "keypair",
  "wmsauthsign",
  "auth_key",
  "wssecret",
  "wsabstime",
  "expires",
  "exp",
  "sign",
  "hash_value",
  "validminutes",
]);

function normalizeUrl(value) {
  if (typeof value !== "string" || !/^https?:\/\//i.test(value)) {
    return value;
  }

  try {
    const url = new URL(value);

    if (/\.m3u8(?:$|[?#])/i.test(value) || /\.m3u8$/i.test(url.pathname)) {
      return `${url.origin}${url.pathname}`;
    }

    for (const key of [...url.searchParams.keys()]) {
      const lower = key.toLowerCase();
      if (
        VOLATILE_QUERY_KEYS.has(lower) ||
        lower.includes("auth") ||
        lower.includes("token") ||
        lower.includes("secret") ||
        lower.startsWith("ws")
      ) {
        url.searchParams.delete(key);
      }
    }
    const search = url.searchParams.toString();
    return `${url.origin}${url.pathname}${search ? `?${search}` : ""}`;
  } catch {
    return value;
  }
}

function normalizeForCompare(value) {
  if (Array.isArray(value)) {
    return value.map(normalizeForCompare);
  }

  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (IGNORED_KEYS.has(key)) continue;
      out[key] = normalizeForCompare(value[key]);
    }
    return out;
  }

  if (typeof value === "string") {
    return normalizeUrl(value);
  }

  return value;
}

export function readLocalJsonSnapshot(root, filename) {
  const localPath = path.join(root, filename);
  if (!fs.existsSync(localPath)) return null;
  return fs.readFileSync(localPath, "utf8");
}

export function jsonContentChanged(beforeContent, afterContent) {
  if (beforeContent === afterContent) return false;
  if (beforeContent == null) return afterContent != null;
  if (afterContent == null) return true;

  try {
    const before = JSON.parse(beforeContent);
    const after = JSON.parse(afterContent);
    return (
      JSON.stringify(normalizeForCompare(before)) !==
      JSON.stringify(normalizeForCompare(after))
    );
  } catch {
    return beforeContent !== afterContent;
  }
}
