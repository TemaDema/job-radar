import { BASE_HEADERS, sleep, log, isItTitle } from "../lib.mjs";
import { matchQuery, buildExternalRecord, cleanText } from "./common.mjs";

/* ------------------------------------------------------------------ */
/* LinkedIn public job cards (guest endpoint, no auth)                 */
/* ------------------------------------------------------------------ */

const LINKEDIN_HEADERS = {
  ...BASE_HEADERS,
  Accept: "text/html,application/xhtml+xml",
  Referer: "https://www.linkedin.com/jobs/",
};

function pick(html, re) {
  const m = String(html || "").match(re);
  return m ? cleanText(m[1]) : "";
}

export function parseLinkedInHtml(html) {
  const cards = [];
  const items = String(html || "").match(/<li[\s\S]*?<\/li>/g) || [];
  for (const item of items) {
    const title = pick(
      item,
      /<h3[^>]*base-search-card__title[^>]*>([\s\S]*?)<\/h3>/
    );
    if (!title) continue;

    const company =
      pick(item, /<h4[^>]*base-search-card__subtitle[^>]*>([\s\S]*?)<\/h4>/) ||
      pick(item, /<a[^>]*hidden-nested-link[^>]*>([\s\S]*?)<\/a>/);
    const area = pick(
      item,
      /<span[^>]*job-search-card__location[^>]*>([\s\S]*?)<\/span>/
    );
    const href = (
      item.match(/href="(https:\/\/[^"]*linkedin\.com\/jobs\/view\/[^"]+)"/) ||
      []
    )[1];
    if (!href) continue;

    const id =
      (href.match(/-(\d+)(?:\?|$)/) || href.match(/\/view\/(\d+)/) || [])[1];
    if (!id) continue;

    const publishedAt =
      (item.match(/<time[^>]*datetime="([^"]+)"/) || [])[1] || null;

    cards.push({
      id,
      title,
      company: company || "LinkedIn",
      area,
      url: href.split("?")[0],
      publishedAt,
    });
  }
  return cards;
}

export async function collectLinkedIn(cfg, queries) {
  const lc = cfg.linkedin || {};
  if (lc.enabled === false) return [];

  const keywords =
    Array.isArray(lc.keywords) && lc.keywords.length
      ? lc.keywords
      : [...new Set((queries || []).map((q) => q.text).filter(Boolean))].slice(0, 8);
  if (!keywords.length) return [];

  const location = lc.location || "Belarus";
  const pages = lc.pages ?? 1;
  const delay = lc.delayMs ?? 3000;
  const maxPerRun = lc.maxPerRun ?? 40;
  const periodSeconds = lc.periodSeconds ?? 604800; // 7 days
  const maxKeywords = lc.maxKeywordsPerRun ?? 3;

  // LinkedIn throttles hard, so rotate a few keywords per run instead of
  // trying them all at once. Over a week every keyword gets its turn.
  let batch = keywords;
  if (keywords.length > maxKeywords) {
    const dayIdx = Math.floor(Date.now() / 86400000);
    const startIdx = dayIdx % keywords.length;
    batch = Array.from(
      { length: maxKeywords },
      (_, i) => keywords[(startIdx + i) % keywords.length]
    );
  }

  const out = [];
  const seen = new Set();

  for (const keyword of batch) {
    for (let page = 0; page < pages; page++) {
      const start = page * 25;
      const url =
        "https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search" +
        `?keywords=${encodeURIComponent(keyword)}` +
        `&location=${encodeURIComponent(location)}` +
        `&f_TPR=r${periodSeconds}&start=${start}`;

      let html;
      try {
        const res = await fetch(url, {
          headers: LINKEDIN_HEADERS,
          signal: AbortSignal.timeout(30000),
        });
        if ([429, 999, 403].includes(res.status)) {
          log(`linkedin: HTTP ${res.status} — rate limited, stopping`);
          return out;
        }
        if (!res.ok) {
          log(`linkedin "${keyword}": HTTP ${res.status}`);
          break;
        }
        html = await res.text();
      } catch (e) {
        log(`linkedin "${keyword}": ERROR ${e.message}`);
        break;
      }

      const cards = parseLinkedInHtml(html);
      if (!cards.length) break;

      let kept = 0;
      for (const c of cards) {
        if (seen.has(c.id)) continue;
        seen.add(c.id);
        if (!isItTitle(c.title)) continue;

        const m = matchQuery(c.title, queries);
        out.push(
          buildExternalRecord({
            source: "linkedin",
            id: `li:${c.id}`,
            name: c.title,
            company: c.company,
            area: c.area || "LinkedIn",
            url: c.url,
            publishedAt: c.publishedAt,
            text: c.title,
            track: m?.track || "LinkedIn",
            queryId: m?.id || null,
          })
        );
        kept++;
        if (out.length >= maxPerRun) {
          log(`linkedin: reached maxPerRun=${maxPerRun}`);
          return out;
        }
      }
      log(`linkedin "${keyword}" p${page}: cards=${cards.length} kept=${kept}`);
      await sleep(delay);
    }
  }
  return out;
}
