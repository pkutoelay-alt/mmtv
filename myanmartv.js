import fs from "fs";
import { load } from "cheerio";

const BASE_URL = "https://www.myanmartvchannels.com/";
const CHANNELS_URL = `${BASE_URL}tv-channels.html`;
const OUTPUT_FILE = "myanmartv.json";

const args = process.argv.slice(2);
const saveOutput = args.includes("--save");
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

function parseListGroupChannels($) {
  const items = [];
  const seen = new Set();

  $(".list-group a.list-group-item").each((_, el) => {
    const anchor = $(el);
    const href = anchor.attr("href");
    const url = absUrl(href);
    if (!url || seen.has(url)) return;

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
    const reffer = "https://www.myanmartvchannels.com/";

    seen.add(url);
    items.push({ title, img, url,reffer });
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
    const img = absUrl(card.find("img.card-img-top, img").first().attr("src"));
    const reffer = "https://www.myanmartvchannels.com/"

    if (!title || !url || seen.has(url)) return;

    seen.add(url);
    items.push({ title, img, url ,reffer});
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
  const res = await fetch(url, { headers: HEADERS, redirect: "follow" });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
  return res.text();
}

async function scrapeMyanmarTv() {
  console.error("Fetching:", sourceUrl);
  const html = await fetchHtml(sourceUrl);
  const channels = parseChannels(html);
  console.error(`Found ${channels.length} channels`);
  return channels;
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
