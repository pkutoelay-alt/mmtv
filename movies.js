import fs from "fs";
import puppeteer from "puppeteer";

const BASE_URL = "https://mycinema.asia";
const HOME_URL = `${BASE_URL}/home`;
const MEDIA_BASE = "http://media1.mycinema.asia/media/films";
const OUTPUT_FILE = "movies.json";
const PAGE_SIZE = 24;
const LINK_VERIFY_CONCURRENCY = 10;
const MYCINEMA_TOKEN = process.env.MYCINEMA_TOKEN || "";
const CHROME_PATH =
  process.env.CHROME_PATH ||
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

const CATEGORIES = [
  { key: "အက်ရှင်", id: 20 },
  { key: "ဟာသ", id: 14 },
  { key: "ကာတွန်း", id: 2 },
  { key: "ကြောက်မက်ဖွယ်ရာ", id: 11 },
];

const args = process.argv.slice(2);
const saveOutput = args.includes("--save");
const skipVerify = args.includes("--no-verify");
const limitArg = args.find((a) => a.startsWith("--limit="));
const limitPerCategory = limitArg ? Number(limitArg.split("=")[1]) : Infinity;

function imageUrl(path) {
  if (!path) return "";
  const url = path.startsWith("http")
    ? path
    : `${BASE_URL}${path.startsWith("/") ? "" : "/"}${path}`;
  return url.replace(/^https:/i, "http:");
}

function titleToFilmPath(title) {
  let name = title.trim();
  const yearMatch = name.match(/\((\d{4})\)\s*$/);
  const year = yearMatch ? yearMatch[1] : "";
  if (yearMatch) {
    name = name.slice(0, yearMatch.index).trim();
  }

  name = name
    .replace(/[:&]/g, " ")
    .replace(/[^\w\s.-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  let base = name.split(/\s+/).filter(Boolean).join(".");
  if (year) {
    base = `${base}.${year}`;
  }

  return base;
}

function buildM3u8Link(title, quality = "360p") {
  const filmPath = titleToFilmPath(title);
  if (!filmPath) return "";
  return `${MEDIA_BASE}/${filmPath}.${quality}/${filmPath}.${quality}.m3u8`;
}

const QUALITIES = ["360p", "480p", "720p", "1080p"];

async function launchBrowser() {
  return puppeteer.launch({
    headless: true,
    executablePath: CHROME_PATH,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-extensions"],
  });
}

async function apiRequest(page, method, path, body) {
  return page.evaluate(
    async ({ method, path, body }) => {
      const res = await fetch(path, {
        method,
        headers: {
          "Content-Type": "application/json",
          language: "en",
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      try {
        return { status: res.status, json: JSON.parse(text) };
      } catch {
        return { status: res.status, json: null, text };
      }
    },
    { method, path, body }
  );
}

async function fetchCategoryPage(page, categoryId, pageIndex) {
  const path = `/api/v1/movie-categories/${categoryId}?page=${pageIndex}&size=${PAGE_SIZE}`;
  const res = await apiRequest(page, "GET", path);

  if (res.status !== 200 || res.json?.errorCode !== "0") {
    throw new Error(
      `Category ${categoryId} page ${pageIndex} failed (${res.status})`
    );
  }

  return res.json.data;
}

async function fetchAllCategoryMovies(page, categoryId) {
  const movies = [];
  const seen = new Set();
  let pageIndex = 0;
  let totalPages = 1;

  while (pageIndex < totalPages) {
    const data = await fetchCategoryPage(page, categoryId, pageIndex);
    totalPages = data.totalPages ?? 1;

    for (const item of data.content || []) {
      if (!item?.hashId || seen.has(item.hashId)) continue;
      seen.add(item.hashId);
      movies.push(item);
      if (movies.length >= limitPerCategory) {
        return movies;
      }
    }

    pageIndex += 1;
  }

  return movies;
}

async function fetchMovieDetail(page, hashId) {
  const res = await apiRequest(page, "GET", `/api/v1/movies/${hashId}`);
  if (res.status !== 200 || res.json?.errorCode !== "0") {
    return null;
  }
  return res.json.data;
}

async function fetchEpisodeM3u8(page, episodeHashId) {
  const res = await apiRequest(page, "POST", `/api/v1/episodes/${episodeHashId}/play`, {
    token: MYCINEMA_TOKEN,
  });

  if (res.json?.errorCode !== "0" || !res.json?.data) {
    return "";
  }

  const link =
    res.json.data.link ||
    res.json.data.url ||
    res.json.data.watchLink ||
    res.json.data.streamUrl ||
    "";

  if (!link || !/\.m3u8/i.test(link)) {
    return "";
  }

  return link.replace(/^https:/i, "http:");
}

async function verifyM3u8Link(link) {
  if (!link) return false;

  try {
    const res = await fetch(link, { method: "HEAD", redirect: "follow" });
    return res.status === 200;
  } catch {
    return false;
  }
}

async function findVerifiedM3u8(title) {
  for (const quality of QUALITIES) {
    const link = buildM3u8Link(title, quality);
    if (link && (await verifyM3u8Link(link))) {
      return link;
    }
  }
  return "";
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

async function resolveLink(page, movie) {
  const title = movie.movieName || "";

  if (!skipVerify) {
    const verified = await findVerifiedM3u8(title);
    if (verified) return verified;
  }

  if (MYCINEMA_TOKEN) {
    const detail = await fetchMovieDetail(page, movie.hashId);
    const episodeHashId = detail?.episodes?.[0]?.hashId || "";
    if (episodeHashId) {
      const apiLink = await fetchEpisodeM3u8(page, episodeHashId);
      if (apiLink && (skipVerify || (await verifyM3u8Link(apiLink)))) {
        return apiLink;
      }
    }
  }

  return "";
}

function buildItem(movie, link) {
  return {
    Title: movie.movieName || "",
    Img: imageUrl(movie.avatar || movie.poster || ""),
    link,
  };
}

async function scrapeCategory(page, category) {
  console.error(`Fetching category: ${category.key} (${category.id})`);
  const movies = await fetchAllCategoryMovies(page, category.id);
  console.error(`  Found ${movies.length} movies`);

  const items = await mapWithConcurrency(movies, LINK_VERIFY_CONCURRENCY, async (movie, index) => {
    console.error(`  [${index + 1}/${movies.length}] ${movie.movieName || movie.hashId}`);

    try {
      const link = await resolveLink(page, movie);
      if (!link || !/\.m3u8/i.test(link)) {
        console.error("    skipped (no playable .m3u8)");
        return null;
      }
      return buildItem(movie, link);
    } catch (error) {
      console.error(`    error: ${error.message}`);
      return null;
    }
  });

  const playable = items.filter(Boolean);
  console.error(`  Keeping ${playable.length}/${movies.length} with playable .m3u8`);
  return playable;
}

function emptyOutput() {
  return {
    "အက်ရှင်": [],
    "ဟာသ": [],
    "ကာတွန်း": [],
    "ကြောက်မက်ဖွယ်ရာ": [],
  };
}

async function scrapeMovies() {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
  );

  console.error("Opening:", HOME_URL);
  await page.goto(HOME_URL, { waitUntil: "networkidle2", timeout: 120000 });

  const output = emptyOutput();

  for (const category of CATEGORIES) {
    output[category.key] = await scrapeCategory(page, category);
  }

  await browser.close();
  return output;
}

async function main() {
  const data = await scrapeMovies();
  const json = `${JSON.stringify(data, null, 2)}\n`;

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
