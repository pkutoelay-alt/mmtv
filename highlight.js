import fs from "fs";
import { load } from "cheerio";
import puppeteer from "puppeteer";

const BASE_URL = "https://hoofoot.com/";
const OUTPUT_FILE = "highlight.json";
const TIMEZONE = "Asia/Ho_Chi_Minh";
const MATCH_DATE_RE = /_(\d{4})_(\d{2})_(\d{2})(?:[/?]|$)/;
const RECENT_DAYS = 4;
const CHROME_PATH =
  process.env.CHROME_PATH ||
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

const args = process.argv.slice(2);
const saveOutput = args.includes("--save");
const noM3u8 = args.includes("--no-m3u8");
const includeAllDates = args.includes("--all-dates");
const limitArg = args.find((a) => a.startsWith("--limit="));
const limit = limitArg ? Number(limitArg.split("=")[1]) : Infinity;

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getDateFilterRange() {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: TIMEZONE });
  const base = new Date(`${today}T00:00:00+07:00`);
  const dates = [];

  for (let offset = 0; offset <= RECENT_DAYS; offset += 1) {
    const day = new Date(base);
    day.setDate(day.getDate() - offset);
    dates.push(day.toLocaleDateString("en-CA", { timeZone: TIMEZONE }));
  }

  return {
    today,
    recent_days: RECENT_DAYS,
    dates,
    allowed: new Set(dates),
  };
}

function extractMatchDateKey(url) {
  const match = url.match(MATCH_DATE_RE);
  if (!match) return null;
  return `${match[1]}-${match[2]}-${match[3]}`;
}

function filterHighlightsByDate(items, allowed) {
  return items.filter((item) => {
    const dateKey = extractMatchDateKey(item.url);
    return dateKey && allowed.has(dateKey);
  });
}

function absUrl(url, base = BASE_URL) {
  if (!url) return "";
  if (url.startsWith("http")) return url;
  if (url.startsWith("//")) return `https:${url}`;
  if (url.startsWith("./")) return `${BASE_URL}${url.slice(2)}`;
  if (url.startsWith("/")) return `${BASE_URL.replace(/\/$/, "")}${url}`;
  return new URL(url, base).href;
}

function parseHighlights(html) {
  const $ = load(html);
  const items = [];
  const seen = new Set();

  $("#gallery > .box > #port").each((_, element) => {
    const anchor = $(element).find('a[id^="rut"]').first();
    if (!anchor.length) return;

    const rutId = anchor.attr("id") || "";
    const id = rutId.replace(/^rut/, "");
    const href = anchor.attr("href") || "";
    const url = absUrl(href);
    if (!url || seen.has(url)) return;
    seen.add(url);

    const img = absUrl(anchor.find("img").attr("src"));
    const title =
      $(element).find(`#d${id}`).text().trim() ||
      anchor.attr("title")?.trim() ||
      anchor.find("img").attr("alt")?.trim() ||
      "";

    const match_date = extractMatchDateKey(url);

    items.push({ title, img, url, match_date });
  });

  return items;
}

function findPatterns(text, baseUrl) {
  const found = new Set();
  const regexes = [
    /https?:\/\/[^\s"'<>]+?\.m3u8(?:\?[^\s"'<>]*)?/gi,
    /streamingurl\s*[:=]\s*["']([^"']+)["']/gi,
    /urlStream\s*=\s*["']([^"']+)["']/gi,
    /["']file["']\s*:\s*["']([^"']+\.m3u8[^"']*)["']/gi,
  ];

  for (const regex of regexes) {
    for (const match of text.matchAll(regex)) {
      const value = match[1] || match[0];
      if (!value || /localhost/i.test(value)) continue;
      try {
        found.add(new URL(value, baseUrl).href);
      } catch {
        if (value.startsWith("http")) found.add(value);
      }
    }
  }

  return [...found];
}

function flvToM3u8(url) {
  if (!/\.flv(?:\?|$)/i.test(url)) return null;
  return url.replace(/\.flv(\?.*)?$/i, ".m3u8$1");
}

function pickBestM3u8(urls) {
  const cleaned = [...new Set(urls)].filter((url) => !/localhost/i.test(url));
  if (cleaned.length === 0) return null;

  const ranked = cleaned.sort((a, b) => {
    const score = (url) => {
      let s = 0;
      if (/\/manifest\/0\.m3u8/i.test(url)) s += 50;
      if (/master/i.test(url)) s += 40;
      if (/index\.m3u8/i.test(url)) s += 30;
      if (/1080|720/i.test(url)) s += 20;
      if (/360p/i.test(url)) s -= 10;
      return s;
    };
    return score(b) - score(a);
  });

  return ranked[0];
}

async function launchBrowser() {
  return puppeteer.launch({
    headless: true,
    executablePath: CHROME_PATH,
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-extensions",
      "--disable-component-update",
    ],
  });
}

async function fetchHtml(page, url) {
  await page.goto(url, { waitUntil: "networkidle2", timeout: 90000 });
  return page.content();
}

async function findEmbedUrl(page, matchUrl) {
  const html = await fetchHtml(page, matchUrl);
  const $ = load(html);
  const embed =
    absUrl($("#player a").attr("href"), matchUrl) ||
    absUrl($("#player iframe").attr("src"), matchUrl) ||
    absUrl($("iframe[src*='embed']").first().attr("src"), matchUrl);

  return embed || null;
}

async function findM3u8FromEmbed(browser, embedUrl) {
  const page = await browser.newPage();
  await page.setUserAgent(USER_AGENT);

  const networkM3u8 = new Set();
  const captureUrl = (url) => {
    if (/\.m3u8(?:\?|$)/i.test(url) && !/localhost/i.test(url)) {
      networkM3u8.add(url);
    }
  };

  page.on("request", (request) => captureUrl(request.url()));
  page.on("response", (response) => captureUrl(response.url()));

  await page.goto(embedUrl, { waitUntil: "networkidle2", timeout: 90000 });
  await sleep(5000);
  await page
    .click("video, .vjs-big-play-button, .play-button, button")
    .catch(() => {});
  await sleep(8000);

  const html = await page.content();
  await page.close();

  const htmlUrls = findPatterns(html, embedUrl).flatMap((url) => {
    const hls = flvToM3u8(url);
    return hls ? [hls, url] : [url];
  });

  return pickBestM3u8([...networkM3u8, ...htmlUrls]);
}

async function enrichHighlight(page, browser, item) {
  const embed_url = await findEmbedUrl(page, item.url);
  let m3u8 = null;

  if (embed_url && !noM3u8) {
    m3u8 = await findM3u8FromEmbed(browser, embed_url);
  }

  return { ...item, embed_url, m3u8 };
}

async function main() {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  await page.setUserAgent(USER_AGENT);

  console.error("Fetching homepage:", BASE_URL);
  const homeHtml = await fetchHtml(page, BASE_URL);
  let highlights = parseHighlights(homeHtml);
  const dateFilter = getDateFilterRange();

  console.error(
    `Date filter (${TIMEZONE}): today=${dateFilter.today}, last ${dateFilter.recent_days} days (${dateFilter.dates.at(-1)} .. ${dateFilter.today})`
  );
  console.error(`Found ${highlights.length} highlights on homepage`);

  if (!includeAllDates) {
    highlights = filterHighlightsByDate(highlights, dateFilter.allowed);
    console.error(
      `Keeping ${highlights.length} highlights for today + last ${dateFilter.recent_days} days`
    );
  }

  if (Number.isFinite(limit) && limit > 0) {
    highlights = highlights.slice(0, limit);
  }

  if (!noM3u8) {
    for (let i = 0; i < highlights.length; i += 1) {
      const item = highlights[i];
      console.error(`[${i + 1}/${highlights.length}] ${item.title || item.url}`);
      try {
        highlights[i] = await enrichHighlight(page, browser, item);
        if (highlights[i].m3u8) {
          console.error("  m3u8:", highlights[i].m3u8.slice(0, 80), "...");
        }
      } catch (error) {
        console.error("  error:", error.message);
        highlights[i] = { ...item, embed_url: null, m3u8: null, error: error.message };
      }
    }
  }

  await browser.close();

  const output = {
    source: BASE_URL,
    scraped_at: new Date().toISOString(),
    date_filter: {
      timezone: TIMEZONE,
      today: dateFilter.today,
      recent_days: dateFilter.recent_days,
      dates: dateFilter.dates,
    },
    count: highlights.length,
    highlights,
  };

  const json = `${JSON.stringify(output, null, 2)}\n`;

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
