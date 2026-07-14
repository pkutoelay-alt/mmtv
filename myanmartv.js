import fs from "fs";
import { load } from "cheerio";

const BASE_URL = "https://www.myanmartvchannels.com/";
const CHANNELS_URL = `${BASE_URL}tv-channels.html`;
const OUTPUT_FILE = "myanmartv.json";
const FETCH_CONCURRENCY = 6;
const FETCH_RETRIES = 3;
const FETCH_DELAY_MS = 2000;
const FETCH_TIMEOUT_MS = 30000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const ALLOWED_CHANNEL_PATHS = new Set([
  "5-plus-channel.html",
  "channel-7.html",
  "channel9.html",
  "channel-k.html",
  "mrtv-entertainment.html",
  "dvb.html",
  "farmer.html",
  "fortune.html",
  "hluttaw.html",
  "m-channel.html",
  "mahar.html",
  "mahar-bawdi.html",
  "mitv.html",
  "mrtv.html",
  "mrtv-news.html",
  "mrtv-sport.html",
  "mrtv4.html",
  "nrc.html",
]);

const args = process.argv.slice(2);
const saveOutput = args.includes("--save");
const skipStream = args.includes("--no-stream");
const sourceArg = args.find((a) => a.startsWith("--url="));
const sourceUrl = sourceArg ? sourceArg.slice(6) : CHANNELS_URL;

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,*/*",
  "Accept-Language": "en-US,en;q=0.9",
};

function absUrl(url, base = BASE_URL) {
  if (!url) return "";
  if (url.startsWith("http")) return url;
  if (url.startsWith("//")) return `https:${url}`;
  return new URL(url, base).href;
}

function channelPath(url) {
  try {
    return new URL(url).pathname.replace(/^\//, "");
  } catch {
    return "";
  }
}

function parseJsArray(text) {
  return Function(`return ${text}`)();
}

function buildObfuscatedUrl(html, charArrayText, arrayVar, spanId) {
  const prefix = parseJsArray(charArrayText).join("");
  const arrayMatch = html.match(
    new RegExp(`var\\s+${arrayVar}\\s*=\\s*(\\[[\\s\\S]*?\\])\\s*;?`)
  );
  const middle = arrayMatch ? parseJsArray(arrayMatch[1]).join("") : "";
  const spanMatch = html.match(
    new RegExp(`id=["']?${spanId}["']?[^>]*>([^<]+)<`, "i")
  );
  const token = spanMatch?.[1] || "";
  return `${prefix}${middle}${token}`;
}

function extractStreamUrl(html) {
  const direct =
    html.match(/streamingurl\s*[:=]\s*["']([^"']+)["']/i)?.[1] ||
    html.match(/https?:\/\/[^\s"'<>]+?\.m3u8(?:\?[^\s"'<>]*)?/i)?.[0];
  if (direct) return direct;

  const candidates = [];
  const sourceRegex = /source:\s*(\w+)\(\)/g;
  let sourceMatch;

  while ((sourceMatch = sourceRegex.exec(html)) !== null) {
    const funcName = sourceMatch[1];
    const funcRe = new RegExp(
      `function\\s+${funcName}\\s*\\(\\)\\s*\\{\\s*return\\((\\[[\\s\\S]*?\\])\\.join\\(""\\)\\s*\\+\\s*(\\w+)\\.join\\(""\\)\\s*\\+\\s*document\\.getElementById\\("([^"]+)"\\)\\.innerHTML\\)\\s*;\\s*\\}`
    );
    const returnMatch = html.match(funcRe);
    if (!returnMatch) continue;

    try {
      const url = buildObfuscatedUrl(html, returnMatch[1], returnMatch[2], returnMatch[3]);
      if (url) candidates.push(url);
    } catch {
      // ignore broken player source
    }
  }

  return (
    candidates.find((url) => url.includes(".m3u8")) ||
    candidates.find((url) => /^https?:\/\//.test(url)) ||
    ""
  );
}

function parseListGroupChannels($) {
  const items = [];
  const seen = new Set();

  $(".list-group a.list-group-item").each((_, el) => {
    const anchor = $(el);
    const href = anchor.attr("href");
    const url = absUrl(href);
    const path = channelPath(url);
    if (!url || seen.has(url)) return;
    if (ALLOWED_CHANNEL_PATHS.size > 0 && !ALLOWED_CHANNEL_PATHS.has(path)) return;

    const img = absUrl(anchor.find("img").first().attr("src"));
    const title = anchor
      .clone()
      .children("span")
      .remove()
      .end()
      .text()
      .replace(/\s+/g, " ")
      .trim();

    if (!title) return;

    seen.add(url);
    items.push({ title, img, url });
  });

  return items;
}

function parseCardChannels($) {
  const items = [];
  const seen = new Set();

  $(".card").each((_, el) => {
    const card = $(el);
    const title = card.find(".card-title").first().text().trim();
    const href =
      card.find("a.btn-success").attr("href") ||
      card.find("a").first().attr("href");
    const url = absUrl(href);
    const path = channelPath(url);
    const img = absUrl(card.find("img.card-img-top, img").first().attr("src"));

    if (!title || !url || seen.has(url)) return;
    if (ALLOWED_CHANNEL_PATHS.size > 0 && !ALLOWED_CHANNEL_PATHS.has(path)) return;

    seen.add(url);
    items.push({ title, img, url });
  });

  return items;
}

function parseChannels(html) {
  const $ = load(html);
  const fromList = parseListGroupChannels($);
  if (fromList.length > 0) return fromList;
  return parseCardChannels($);
}

async function fetchHtml(url) {
  let lastError;

  for (let attempt = 1; attempt <= FETCH_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      const res = await fetch(url, {
        headers: HEADERS,
        redirect: "follow",
        signal: controller.signal,
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status} for ${url}`);
      }

      return await res.text();
    } catch (error) {
      lastError = error;
      if (attempt < FETCH_RETRIES) {
        console.error(
          `  fetch retry ${attempt}/${FETCH_RETRIES} (${error.message || error})`
        );
        await sleep(FETCH_DELAY_MS);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError || new Error(`Failed to fetch ${url}`);
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let index = 0;

  async function runNext() {
    while (index < items.length) {
      const current = index++;
      results[current] = await worker(items[current], current);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => runNext())
  );
  return results;
}

async function attachStreamUrls(channels) {
  console.error(`Extracting streamUrl for ${channels.length} channels...`);

  return mapWithConcurrency(channels, FETCH_CONCURRENCY, async (channel) => {
    try {
      const html = await fetchHtml(channel.url);
      const streamUrl = extractStreamUrl(html);
      console.error(`  ${channel.title}: ${streamUrl ? "ok" : "no stream"}`);
      return { title: channel.title, img: channel.img, streamUrl };
    } catch (error) {
      console.error(`  ${channel.title}: ${error.message}`);
      return { title: channel.title, img: channel.img, streamUrl: "" };
    }
  });
}

async function scrapeMyanmarTv() {
  console.error("Fetching:", sourceUrl);
  const html = await fetchHtml(sourceUrl);
  const channels = parseChannels(html);
  console.error(`Found ${channels.length} channels`);

  if (skipStream) {
    return channels.map(({ title, img }) => ({ title, img, streamUrl: "" }));
  }

  return attachStreamUrls(channels);
}

async function main() {
  const channels = await scrapeMyanmarTv();
  const json = `${JSON.stringify(channels, null, 2)}\n`;

  if (saveOutput) {
    fs.writeFileSync(OUTPUT_FILE, json);
    console.error(`Saved ${OUTPUT_FILE}`);
  } else {
    process.stdout.write(json);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
