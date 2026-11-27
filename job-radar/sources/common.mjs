import { stripHtml, isEntry, detectSkills, detectEnglish } from "../lib.mjs";

/* ------------------------------------------------------------------ */
/* Shared helpers for external sources (Telegram, LinkedIn)            */
/* ------------------------------------------------------------------ */

/* Pick the most specific search query mentioned in a free-form text.
   Generic queries (junior/intern) only win when nothing else matches. */
const GENERIC_QUERY_IDS = new Set(["junior", "intern", "dev-role"]);

export function matchQuery(text, queries) {
  const lower = String(text || "").toLowerCase().replace(/ё/g, "е");
  let best = null;
  for (const q of queries || []) {
    if (!q.text) continue;
    const needle = String(q.text)
      .replace(/^"|"$/g, "")
      .toLowerCase()
      .replace(/ё/g, "е")
      .trim();
    if (needle.length < 2) continue;
    if (!lower.includes(needle)) continue;
    const score = needle.length - (GENERIC_QUERY_IDS.has(q.id) ? 100 : 0);
    if (!best || score > best.score) {
      best = { id: q.id, track: q.track, score };
    }
  }
  return best ? { id: best.id, track: best.track } : null;
}

/* First meaningful line of a Telegram post, cleaned up. */
export function pickTitle(text) {
  const lines = String(text || "")
    .split("\n")
    .map((l) => l.replace(/^[\s•·\-–—*#>]+/, "").trim())
    .filter(Boolean);
  for (const line of lines.slice(0, 4)) {
    if (line.length >= 6 && line.length <= 140) return tidyTitle(line);
  }
  return tidyTitle((lines[0] || "").slice(0, 140));
}

export function tidyTitle(line) {
  let s = String(line || "");
  // Drop marketing lead-ins like "Мы в поиске …" / "Ищем в команду …".
  s = s.replace(
    /^(?:кое-что новое:\s*)?(?:мы\s+)?(?:в поиске|ищем(?: в команду)?)\s+/i,
    ""
  );
  // Strip emoji and pictographs.
  s = s.replace(
    /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2B00}-\u{2BFF}\u{1F1E6}-\u{1F1FF}]/gu,
    ""
  );
  s = s.replace(/\s+/g, " ").replace(/^[\s.,:;!–—-]+/, "").trim();
  if (!s) return s;
  // Capitalize plain lowercase starts, but keep camelCase brands like iOS.
  const first = s.charAt(0);
  const firstWord = s.split(/\s/)[0];
  if (
    /[а-яё]/.test(first) ||
    (/[a-z]/.test(first) && firstWord === firstWord.toLowerCase())
  ) {
    s = first.toUpperCase() + s.slice(1);
  }
  return s;
}

/* Titles that are clearly announcements, not vacancies. */
export function isNonJobTitle(title) {
  const t = String(title || "").trim();
  if (
    /^(регистрац|анонс|вебинар|митап|конференц|опрос|розыгрыш|подкаст|дайджест|новост)/i.test(
      t
    )
  ) {
    return true;
  }
  return /приглашаем на (?:ctf|митап|вебинар|конференц|хакатон|встреч|лекц|курс|мероприят)|\bctf\b|хакатон/i.test(
    t
  );
}

const CURRENCY_MAP = {
  byn: "BYN",
  руб: "BYN",
  "р.": "BYN",
  usd: "USD",
  $: "USD",
  eur: "EUR",
  "€": "EUR",
};

/* Best-effort salary extraction from free-form text. */
export function parseSalary(text) {
  const t = String(text || "").replace(/\u00a0/g, " ");
  const num = "(\\d[\\d\\s]{0,8}\\d|\\d)";
  const re = new RegExp(
    `(от|до)?\\s*${num}\\s*(?:[-–—]\\s*${num})?\\s*(BYN|руб\\.?|р\\.|USD|\\$|EUR|€)`,
    "i"
  );
  const m = t.match(re);
  if (!m) return {};
  const toNum = (s) => Number(String(s).replace(/\s/g, ""));
  const prefix = m[1];
  const first = toNum(m[2]);
  const second = m[3] ? toNum(m[3]) : null;
  const currency = CURRENCY_MAP[m[4].toLowerCase()] || null;

  let from = null;
  let to = null;
  if (second) {
    from = first;
    to = second;
  } else if (prefix === "до") {
    to = first;
  } else if (prefix === "от") {
    from = first;
  } else {
    from = first;
  }
  return { from, to, currency };
}

/* Work format detection from free-form text. */
export function detectFormats(text) {
  const t = String(text || "").toLowerCase();
  const out = new Set();
  if (/удал[её]н|remote|дистанц/.test(t)) out.add("REMOTE");
  if (/гибрид|hybrid/.test(t)) out.add("HYBRID");
  if (/офис|office|на месте|в офис/.test(t)) out.add("ON_SITE");
  return [...out];
}

/* Build a store-ready record for a non-rabota.by vacancy. */
export function buildExternalRecord({
  source,
  id,
  name,
  company,
  area,
  url,
  publishedAt,
  text,
  track,
  queryId,
}) {
  const verdict = isEntry({ name, experience: null }, text);
  const sal = parseSalary(text);
  return {
    id,
    source,
    name,
    company: company || "—",
    area: area || "",
    salaryFrom: sal.from ?? null,
    salaryTo: sal.to ?? null,
    currency: sal.currency ?? null,
    gross: null,
    salaryMode: null,
    experience: null,
    employment: null,
    workFormats: detectFormats(text),
    professionalRoleIds: [],
    publishedAt: publishedAt || null,
    url,
    tracks: [track],
    queries: queryId ? [queryId] : [],
    firstSeen: null,
    lastSeen: null,
    entry: verdict.entry,
    entryReason: verdict.reason,
    skills: [...new Set([...detectSkills(text), ...detectSkills(name)])].sort(),
    english: detectEnglish(text),
    descSnippet: String(text || "").replace(/\s+/g, " ").slice(0, 400),
    keySkills: [],
  };
}

export function cleanText(html) {
  return stripHtml(html || "").replace(/\s+/g, " ").trim();
}
