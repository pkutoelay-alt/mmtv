import { load } from "cheerio";
import dns from "dns";
import fs from "fs";

dns.setDefaultResultOrder("ipv4first");

const BASE_URL = "https://socolivemm.io";
const SPORT = "football";
const OUTPUT_FILE = "football.json";
const STREAM_CONCURRENCY = 8;
const TIMEZONE = "Asia/Ho_Chi_Minh";

const HOT_LEAGUES = [
  {
    league_name: "UEFA CL",
    league_id: "z8yomo4h7wq0j6l",
    league_icon:
      "https://imgts.sportpulseapiz.com/football/competition/z8yomo4h7wq0j6l/image/small",
  },
  {
    league_name: "UEFA ECL",
    league_id: "p4jwq2gh754m0ve",
    league_icon:
      "https://imgts.sportpulseapiz.com/football/competition/p4jwq2gh754m0ve/image/small",
  },
  {
    league_name: "FIF",
    league_id: "kp3glrw7hwqdyjv",
    league_icon:
      "https://imgts.sportpulseapiz.com/football/competition/kp3glrw7hwqdyjv/image/small",
  },
  {
    league_name: "KOR D1",
    league_id: "gy0or5jhlxgqwzv",
    league_icon:
      "https://imgts.sportpulseapiz.com/football/competition/gy0or5jhlxgqwzv/image/small",
  },
  {
    league_name: "CHA CSL",
    league_id: "9k82rekh52repzj",
    league_icon:
      "https://imgts.sportpulseapiz.com/football/competition/9k82rekh52repzj/image/small",
  },
];

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
  Accept: "text/html,application/json,*/*",
  "Accept-Language": "en-US,en;q=0.9",
};

function absUrl(url) {
  if (!url) return "";
  if (url.startsWith("http")) return url;
  return `${BASE_URL}${url.startsWith("/") ? url : `/${url}`}`;
}

function getAllowedDateKeys(timeZone = TIMEZONE) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  const today = formatter.format(new Date());
  const tomorrow = formatter.format(new Date(Date.now() + 86400000));
  return new Set([today, tomorrow]);
}

function getDateKeyFromUnix(unixSeconds, timeZone = TIMEZONE) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(Number(unixSeconds) * 1000));
}

function formatMatchDateTime(unixSeconds) {
  const date = new Date(Number(unixSeconds) * 1000);
  const month = date.toLocaleString("en-US", {
    timeZone: TIMEZONE,
    month: "numeric",
  });
  const day = date.toLocaleString("en-US", {
    timeZone: TIMEZONE,
    day: "numeric",
  });
  const year = date.toLocaleString("en-US", {
    timeZone: TIMEZONE,
    year: "numeric",
  });
  const time = date.toLocaleString("en-US", {
    timeZone: TIMEZONE,
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  return {
    month: `${month}/${day}/${year}`,
    time,
  };
}

async function fetchText(url, timeoutMs = 30000, referer = BASE_URL) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { ...HEADERS, Referer: referer },
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} for ${url}`);
    }

    return res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchLeagueHtml(leagueId) {
  const url = `${BASE_URL}/sport/${SPORT}/filter/league/${leagueId}`;
  const text = await fetchText(url);
  const trimmed = text.trim();

  if (!trimmed.startsWith("{")) {
    throw new Error(`Invalid response for league ${leagueId}`);
  }

  const payload = JSON.parse(trimmed);

  if (!payload?.success || !Array.isArray(payload?.data?.htmls)) {
    throw new Error(`Failed to load league ${leagueId}`);
  }

  return payload.data.htmls.join("");
}

function parseMatchesFromHtml(html, leagueMeta, allowedDates) {
  const $ = load(html);
  const matches = [];
  const seen = new Set();

  $(".match-football-item").each((_, el) => {
    const card = $(el);

    if (card.attr("data-sport") && card.attr("data-sport") !== SPORT) {
      return;
    }

    const runtime = card.attr("data-runtime");

    if (!runtime || !allowedDates.has(getDateKeyFromUnix(runtime))) {
      return;
    }
    const homeName = card.find(".grid-match__team--home-name").first().text().trim();
    const awayName = card.find(".grid-match__team--away-name").first().text().trim();
    const homeLogo = absUrl(
      card.find(".grid-match__team-home img").first().attr("src")
    );
    const awayLogo = absUrl(
      card.find(".grid-match__team-away img").first().attr("src")
    );
    const matchPath = card.find("a.redirectPopup").first().attr("href");
    const matchUrl = absUrl(matchPath);
    const matchId = card.attr("data-fid") || matchUrl;

    if (!homeName || !awayName || !runtime || !matchUrl) {
      return;
    }

    if (seen.has(matchId)) {
      return;
    }

    seen.add(matchId);

    const { month, time } = formatMatchDateTime(runtime);

    matches.push({
      league_name: leagueMeta.league_name,
      league_icon: leagueMeta.league_icon,
      home_team: { name: homeName, logo: homeLogo },
      away_team: { name: awayName, logo: awayLogo },
      month,
      time,
      match_url: matchUrl,
    });
  });

  return matches;
}

function parseListStream(html) {
  const match = html.match(/var\s+list_stream\s*=\s*(\[[\s\S]*?\]);/);
  if (!match) {
    return [];
  }

  try {
    return JSON.parse(match[1]).flat().filter(Boolean);
  } catch {
    return [];
  }
}

function getEmbedUrls(html) {
  return [...new Set(parseListStream(html))].slice(0, 2);
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
    for (const patternMatch of text.matchAll(regex)) {
      const value = patternMatch[1] || patternMatch[0];
      if (!value) continue;
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

function isAdStream(url) {
  return /vd\.apisportpulse\.com/i.test(url);
}

function normalizeStreamUrl(url) {
  if (!url || isAdStream(url)) return "";
  if (/\.m3u8(?:\?|$)/i.test(url)) return url;
  const hls = flvToM3u8(url);
  if (hls) return hls;
  if (/\.flv(?:\?|$)/i.test(url)) return url;
  return "";
}

function pickStreamUrl(urls) {
  const cleaned = urls.map(normalizeStreamUrl).filter(Boolean);
  if (cleaned.length === 0) return "";

  const ranked = [...new Set(cleaned)].sort((a, b) => {
    const score = (url) => {
      if (/\.m3u8(?:\?|$)/i.test(url)) return 10;
      if (/\.flv(?:\?|$)/i.test(url)) return 5;
      return 0;
    };
    return score(b) - score(a);
  });

  return ranked[0];
}

async function extractStreamFromEmbed(embedUrl, matchPageUrl) {
  const html = await fetchText(embedUrl, 30000, matchPageUrl);
  const candidates = findPatterns(html, embedUrl);

  const urlStream = html.match(/urlStream\s*=\s*["']([^"']+)["']/)?.[1];
  if (urlStream) candidates.push(urlStream);

  const streamingUrl = html.match(/streamingurl\s*[:=]\s*["']([^"']+)["']/i)?.[1];
  if (streamingUrl) candidates.push(streamingUrl);

  return pickStreamUrl(candidates);
}

async function extractLiveLinks(matchPageUrl) {
  const html = await fetchText(matchPageUrl, 30000, matchPageUrl);
  const embedUrls = getEmbedUrls(html);
  const links = [];

  for (const [index, embedUrl] of embedUrls.entries()) {
    try {
      const streamUrl = await extractStreamFromEmbed(embedUrl, matchPageUrl);
      links.push({
        name: `Link ${index + 1}`,
        url: streamUrl,
        reffer: embedUrl,
      });
    } catch (error) {
      console.error(`  embed failed (${embedUrl}):`, error.message);
      links.push({
        name: `Link ${index + 1}`,
        url: "",
        reffer: embedUrl,
      });
    }
  }

  if (links.length === 0) {
    const direct = pickStreamUrl(findPatterns(html, matchPageUrl));
    links.push({
      name: "Link 1",
      url: direct,
      reffer: matchPageUrl,
    });
  }

  return links;
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let index = 0;

  async function runWorker() {
    while (index < items.length) {
      const current = index;
      index += 1;
      results[current] = await worker(items[current], current);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, runWorker)
  );

  return results;
}

async function attachLiveLinks(matches) {
  return mapWithConcurrency(matches, STREAM_CONCURRENCY, async (match) => {
    let links = [{ name: "Link 1", url: "", reffer: "" }];

    if (match.match_url) {
      try {
        console.error(`  ${match.home_team.name} vs ${match.away_team.name}`);
        links = await extractLiveLinks(match.match_url);
      } catch (error) {
        console.error(`Failed to fetch links for ${match.match_url}:`, error.message);
      }
    }

    const { match_url: _matchUrl, ...rest } = match;
    return { ...rest, links };
  });
}

function groupByLeague(matches) {
  const leagues = new Map();

  for (const match of matches) {
    const key = `${match.league_name}::${match.league_icon}`;

    if (!leagues.has(key)) {
      leagues.set(key, {
        league_name: match.league_name,
        league_icon: match.league_icon,
        matches: [],
      });
    }

    const { league_name, league_icon, ...matchData } = match;
    leagues.get(key).matches.push(matchData);
  }

  return Array.from(leagues.values());
}

async function scrapeSocolive(options = {}) {
  const { includeStreams = true } = options;
  const allowedDates = getAllowedDateKeys();
  const [today, tomorrow] = [...allowedDates];
  const leagueNames = HOT_LEAGUES.map((l) => l.league_name).join(", ");

  console.error(`Fetching hot leagues only: ${leagueNames}`);
  console.error(`Date filter (${TIMEZONE}): today=${today}, tomorrow=${tomorrow}`);

  const allMatches = [];

  for (const league of HOT_LEAGUES) {
    const html = await fetchLeagueHtml(league.league_id);
    const matches = parseMatchesFromHtml(html, league, allowedDates);
    console.error(`  ${league.league_name}: ${matches.length} matches`);
    allMatches.push(...matches);
  }

  const finalMatches = includeStreams
    ? await (async () => {
        console.error(`Found ${allMatches.length} matches. Extracting livestream links...`);
        return attachLiveLinks(allMatches);
      })()
    : allMatches.map(({ match_url, ...rest }) => ({
        ...rest,
        links: [{ name: "Link 1", url: "", reffer: match_url || "" }],
      }));

  const grouped = groupByLeague(finalMatches);
  const groupedByName = new Map(grouped.map((l) => [l.league_name, l]));

  return {
    leagues: HOT_LEAGUES.map((league) =>
      groupedByName.get(league.league_name) || {
        league_name: league.league_name,
        league_icon: league.league_icon,
        matches: [],
      }
    ),
  };
}

async function main() {
  const includeStreams = !process.argv.includes("--basic");
  const result = await scrapeSocolive({ includeStreams });
  const output = JSON.stringify(result, null, 2);

  if (process.argv.includes("--save")) {
    fs.writeFileSync(OUTPUT_FILE, output);
    console.error(
      `Saved ${result.leagues.length} hot leagues to ${OUTPUT_FILE}`
    );
  } else {
    console.log(output);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
