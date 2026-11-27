import fs from "node:fs";
import path from "node:path";
import {
  ROOT,
  loadConfig,
  ensureDirs,
  loadStore,
  saveStore,
  dateKey,
  addDays,
  log,
  sleep,
  searchVacancies,
  fetchVacancyDetails,
  normalizeVacancy,
  isEntry,
  isItTitle,
  detectSkills,
  detectEnglish,
  fmtSalary,
  fmtFormats,
  salaryMid,
  median,
  mdEscape,
  EXPERIENCE_LABEL,
  CaptchaError,
  TZ,
} from "../lib.mjs";
import { collectTelegram } from "../sources/telegram.mjs";
import { collectLinkedIn } from "../sources/linkedin.mjs";
import { generateExports } from "./export.mjs";

const cfg = loadConfig();
ensureDirs();

const today = dateKey();
const store = loadStore();
const startedAt = new Date();

const argSources = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const activeSources = argSources.length ? argSources : cfg.sources || ["rabota.by"];

log(
  `run start ${startedAt.toISOString()} today=${today} sources=${activeSources.join(",")}`
);

/* ------------------------------------------------------------------ */
/* Catch-up: restore daily slices for days when the PC was off        */
/* ------------------------------------------------------------------ */

function publishedDate(v) {
  if (!v.publishedAt) return null;
  const d = new Date(v.publishedAt);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("sv-SE", { timeZone: TZ });
}

function backfillDailyReports(cfg, store, todayKey) {
  const reportDir = path.join(ROOT, "reports", "daily");
  const dataDir = path.join(ROOT, "data", "daily");
  let filled = 0;

  for (let i = cfg.searchPeriodDays; i >= 1; i--) {
    const d = addDays(todayKey, -i);
    const mdPath = path.join(reportDir, `${d}.md`);
    if (fs.existsSync(mdPath)) continue; // a real daily report already exists

    const items = Object.values(store.vacancies).filter((v) => publishedDate(v) === d);
    if (!items.length) continue;
    const entry = items.filter((v) => v.entry);

    const bySource = new Map();
    for (const v of items) {
      const s = v.source || "rabota.by";
      bySource.set(s, (bySource.get(s) || 0) + 1);
    }

    const skillMap = new Map();
    for (const v of entry) for (const s of v.skills || []) skillMap.set(s, (skillMap.get(s) || 0) + 1);
    const topSkills = [...skillMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);

    const lines = [];
    lines.push(`# Job Radar — ${d} (восстановленный срез)`);
    lines.push("");
    lines.push(
      "_Ежедневный сбор за этот день не выполнялся (ПК был выключен или система ещё не работала). Срез восстановлен по дате публикации из следующего запуска._"
    );
    lines.push("");
    lines.push(
      `**Вакансий за день: ${items.length}** · entry-level: ${entry.length} · источники: ${[...bySource.entries()]
        .map(([s, n]) => `${s} ${n}`)
        .join(" · ")}`
    );
    lines.push("");

    if (entry.length) {
      lines.push("## Entry-level вакансии");
      lines.push("");
      const sorted = [...entry]
        .sort((a, b) => String(b.publishedAt || "").localeCompare(String(a.publishedAt || "")))
        .slice(0, 60);
      for (const v of sorted) {
        const bits = [
          v.company,
          v.area || null,
          fmtSalary(v),
          fmtFormats(v.workFormats) || null,
          EXPERIENCE_LABEL[v.experience] || null,
        ].filter(Boolean);
        lines.push(`- **[${v.name}](${v.url})** — ${bits.join(" · ")}`);
        const skills = (v.skills?.length ? v.skills : v.keySkills || []).slice(0, 8).join(", ");
        if (skills) lines.push(`  - технологии: ${skills}`);
      }
      lines.push("");
    }

    if (topSkills.length) {
      lines.push("## Технологии");
      lines.push("");
      lines.push(topSkills.map(([s, n]) => `${s} (${n})`).join(" · "));
      lines.push("");
    }

    fs.writeFileSync(mdPath, lines.join("\n"), "utf8");
    fs.writeFileSync(
      path.join(dataDir, `${d}.json`),
      JSON.stringify(
        {
          date: d,
          restored: true,
          generatedAt: new Date().toISOString(),
          newTotal: items.length,
          newEntry: entry.length,
          bySource: Object.fromEntries(bySource),
          topSkills: Object.fromEntries(topSkills),
          note: "restored from publication date after a missed run",
        },
        null,
        2
      ),
      "utf8"
    );
    filled++;
  }

  return filled;
}

function readStatus() {
  const p = path.join(ROOT, "data", "status.json");
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return {};
  }
}

function writeStatus(status) {
  fs.writeFileSync(
    path.join(ROOT, "data", "status.json"),
    JSON.stringify(status, null, 2),
    "utf8"
  );
}

/* ------------------------------------------------------------------ */
/* 1. Search                                                           */
/* ------------------------------------------------------------------ */

const found = new Map();
let searchErrors = 0;
let captchaHit = false;

if (activeSources.includes("rabota.by")) {
for (const q of cfg.queries) {
  try {
    const items = await searchVacancies(cfg, q);
    let kept = 0;
    for (const raw of items) {
      if (!isItTitle(raw.name)) continue;
      const id = String(raw.vacancyId);
      let e = found.get(id);
      if (!e) {
        e = { raw, tracks: new Set(), queries: new Set() };
        found.set(id, e);
      }
      e.tracks.add(q.track);
      e.queries.add(q.id);
      kept++;
    }
    log(`search ${q.id}: fetched=${items.length} kept=${kept}`);
  } catch (e) {
    if (e instanceof CaptchaError) {
      captchaHit = true;
      log(`search ${q.id}: CAPTCHA — aborting searches`);
      break;
    }
    searchErrors++;
    log(`search ${q.id}: ERROR ${e.message}`);
  }
  await sleep(cfg.requestDelayMs);
}
}
log(`search done: unique=${found.size} errors=${searchErrors}`);

/* ------------------------------------------------------------------ */
/* 2. Merge into store                                                 */
/* ------------------------------------------------------------------ */

let newCount = 0;

for (const [id, e] of found) {
  const existing = store.vacancies[id];
  const n = normalizeVacancy(e.raw, {
    id: [...e.queries][0],
    track: [...e.tracks][0],
  });
  n.tracks = [...e.tracks];
  n.queries = [...e.queries];

  if (existing) {
    existing.lastSeen = today;
    existing.name = n.name || existing.name;
    existing.company = n.company || existing.company;
    existing.area = n.area || existing.area;
    existing.salaryFrom = n.salaryFrom ?? existing.salaryFrom;
    existing.salaryTo = n.salaryTo ?? existing.salaryTo;
    existing.currency = n.currency ?? existing.currency;
    existing.gross = n.gross ?? existing.gross;
    existing.experience = n.experience ?? existing.experience;
    existing.employment = n.employment ?? existing.employment;
    existing.workFormats = n.workFormats?.length ? n.workFormats : existing.workFormats;
    existing.publishedAt = n.publishedAt ?? existing.publishedAt;
    existing.tracks = [...new Set([...(existing.tracks || []), ...n.tracks])];
    existing.queries = [...new Set([...(existing.queries || []), ...n.queries])];
  } else {
    n.firstSeen = today;
    n.lastSeen = today;
    const verdict = isEntry(n, "");
    n.entry = verdict.entry;
    n.entryReason = verdict.reason;
    store.vacancies[id] = n;
    newCount++;
  }
}

log(`merge done: new=${newCount} total=${Object.keys(store.vacancies).length}`);

/* ------------------------------------------------------------------ */
/* 2b. External sources: Telegram + LinkedIn                           */
/* ------------------------------------------------------------------ */

const external = [];
if (activeSources.includes("telegram")) {
  try {
    const list = await collectTelegram(cfg, cfg.queries);
    external.push(...list);
    log(`telegram: collected=${list.length}`);
  } catch (e) {
    log(`telegram: ERROR ${e.message}`);
  }
}
if (activeSources.includes("linkedin")) {
  try {
    const list = await collectLinkedIn(cfg, cfg.queries);
    external.push(...list);
    log(`linkedin: collected=${list.length}`);
  } catch (e) {
    log(`linkedin: ERROR ${e.message}`);
  }
}

let externalNew = 0;
for (const v of external) {
  const existing = store.vacancies[v.id];
  if (existing) {
    existing.lastSeen = today;
    existing.name = v.name || existing.name;
    existing.company = v.company || existing.company;
    existing.area = v.area || existing.area;
    existing.salaryFrom = v.salaryFrom ?? existing.salaryFrom;
    existing.salaryTo = v.salaryTo ?? existing.salaryTo;
    existing.currency = v.currency ?? existing.currency;
    existing.workFormats = v.workFormats?.length ? v.workFormats : existing.workFormats;
    existing.publishedAt = v.publishedAt ?? existing.publishedAt;
    existing.entry = existing.entry || v.entry;
    existing.entryReason = existing.entryReason || v.entryReason;
    existing.skills = [...new Set([...(existing.skills || []), ...(v.skills || [])])].sort();
    existing.tracks = [...new Set([...(existing.tracks || []), ...v.tracks])];
    existing.queries = [...new Set([...(existing.queries || []), ...v.queries])];
  } else {
    v.firstSeen = today;
    v.lastSeen = today;
    store.vacancies[v.id] = v;
    externalNew++;
  }
}
log(
  `external merge done: new=${externalNew} total=${Object.keys(store.vacancies).length}`
);

/* ------------------------------------------------------------------ */
/* 3. Descriptions for fresh vacancies (fills skills + entry flags)    */
/* ------------------------------------------------------------------ */

const weekAgo = addDays(today, -6);
const needDetails = Object.values(store.vacancies)
  .filter(
    (v) =>
      v.entry &&
      (!v.source || v.source === "rabota.by") &&
      !v.detailsFetchedAt &&
      !v.detailsAttemptedAt &&
      v.firstSeen &&
      v.firstSeen >= weekAgo
  )
  .sort((a, b) => {
    const aToday = a.firstSeen === today ? 1 : 0;
    const bToday = b.firstSeen === today ? 1 : 0;
    if (aToday !== bToday) return bToday - aToday;
    return String(b.publishedAt || "").localeCompare(String(a.publishedAt || ""));
  });

let detailsFetched = 0;
for (const v of needDetails) {
  if (detailsFetched >= cfg.maxDescriptionsPerRun) break;
  try {
    const d = await fetchVacancyDetails(v.id);
    if (!d) {
      v.detailsAttemptedAt = new Date().toISOString();
    } else {
      const verdict = isEntry(v, d.text);
      if (verdict.entry) {
        v.entry = true;
        v.entryReason = v.entryReason || verdict.reason;
      }
      v.skills = [
        ...new Set([...detectSkills(d.text), ...detectSkills(v.name)]),
      ].sort();
      v.keySkills = [...new Set(d.keySkills || [])].sort();
      v.english = detectEnglish(d.text);
      v.descSnippet = d.text.replace(/\s+/g, " ").slice(0, 400);
      if (!v.experience) v.experience = d.experience;
      if (!v.workFormats?.length && d.workFormats?.length) v.workFormats = d.workFormats;
      v.detailsFetchedAt = new Date().toISOString();
      detailsFetched++;
    }
  } catch (e) {
    if (e instanceof CaptchaError) {
      captchaHit = true;
      log("details: CAPTCHA — stopping description fetch");
      break;
    }
    log(`details ${v.id}: ERROR ${e.message}`);
  }
  await sleep(cfg.descriptionDelayMs);
}

log(
  `details done: fetched=${detailsFetched} candidates=${needDetails.length}` +
    (captchaHit ? " (captcha)" : "")
);

saveStore(store);

/* ------------------------------------------------------------------ */
/* 4. Daily report                                                     */
/* ------------------------------------------------------------------ */

const todays = Object.values(store.vacancies).filter((v) => v.firstSeen === today);
const todaysEntry = todays.filter((v) => v.entry);

const SOURCE_LABEL = {
  "rabota.by": "rabota.by",
  telegram: "Telegram",
  linkedin: "LinkedIn",
};

const sourceCounts = new Map();
for (const v of todays) {
  const s = v.source || "rabota.by";
  sourceCounts.set(s, (sourceCounts.get(s) || 0) + 1);
}
const sourceSummary = [...sourceCounts.entries()]
  .sort((a, b) => b[1] - a[1])
  .map(([s, n]) => `${SOURCE_LABEL[s] || s} ${n}`)
  .join(" · ");

const trackOrder = [
  ...new Set([
    ...cfg.queries.map((q) => q.track),
    ...todays.map((v) => v.tracks?.[0]).filter(Boolean),
  ]),
];

const byTrack = new Map();
for (const v of todaysEntry) {
  const track = v.tracks?.[0] || "Другое";
  if (!byTrack.has(track)) byTrack.set(track, []);
  byTrack.get(track).push(v);
}

function trackStats(list) {
  const sal = list
    .filter((v) => (v.currency === "BYR" || v.currency === "BYN") && salaryMid(v))
    .map(salaryMid);
  return {
    count: list.length,
    strict: list.filter((v) => v.experience === "noExperience").length,
    salaryMedian: median(sal),
    withSalary: sal.length,
  };
}

const skillCounts = new Map();
for (const v of todaysEntry) {
  for (const s of v.skills || []) skillCounts.set(s, (skillCounts.get(s) || 0) + 1);
}
const topSkills = [...skillCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);

const remoteCount = todaysEntry.filter((v) => v.workFormats?.includes("REMOTE")).length;
const withSalary = todaysEntry.filter((v) => v.salaryFrom || v.salaryTo).length;

/* --- markdown ----------------------------------------------------- */

const lines = [];
lines.push(`# Job Radar — ${today}`);
lines.push("");
const reportedSources = [
  ...new Set([...activeSources, ...sourceCounts.keys()]),
];
lines.push(
  `Источники: ${reportedSources.map((s) => SOURCE_LABEL[s] || s).join(" · ")} · окно поиска: последние ${cfg.searchPeriodDays} дн. · запуск: ${startedAt.toISOString()}`
);
lines.push("");
lines.push(
  `**Новых вакансий: ${todays.length}** · entry-level (без опыта / junior): **${todaysEntry.length}**` +
    (searchErrors ? ` · ошибок поиска: ${searchErrors}` : "")
);
if (sourceSummary) {
  lines.push("");
  lines.push(`По источникам: ${sourceSummary}`);
}
lines.push("");

if (byTrack.size) {
  lines.push("## По направлениям");
  lines.push("");
  lines.push("| Направление | Новых | Без опыта | Медианная вилка, BYN |");
  lines.push("|---|---:|---:|---:|");
  for (const track of trackOrder) {
    const list = byTrack.get(track);
    if (!list?.length) continue;
    const s = trackStats(list);
    lines.push(
      `| ${mdEscape(track)} | ${s.count} | ${s.strict} | ${
        s.salaryMedian ? s.salaryMedian.toLocaleString("ru-RU") : "—"
      } |`
    );
  }
  lines.push("");
}

lines.push("## Новые entry-level вакансии");
lines.push("");

let shown = 0;
const MAX_SHOWN = 100;
for (const track of trackOrder) {
  const list = byTrack.get(track);
  if (!list?.length) continue;
  list.sort((a, b) => String(b.publishedAt || "").localeCompare(String(a.publishedAt || "")));
  lines.push(`### ${track} (${list.length})`);
  lines.push("");
  for (const v of list) {
    if (shown >= MAX_SHOWN) break;
    const bits = [
      v.company,
      v.area || null,
      fmtSalary(v),
      fmtFormats(v.workFormats) || null,
      EXPERIENCE_LABEL[v.experience] || null,
    ].filter(Boolean);
    const skills = (v.skills?.length ? v.skills : v.keySkills || []).slice(0, 8).join(", ");
    lines.push(`- **[${v.name}](${v.url})** — ${bits.join(" · ")}`);
    if (skills) lines.push(`  - технологии: ${skills}`);
    shown++;
  }
  lines.push("");
  if (shown >= MAX_SHOWN) break;
}
if (todaysEntry.length > MAX_SHOWN) {
  lines.push(`_Показаны первые ${MAX_SHOWN} из ${todaysEntry.length}. Полный список — в data/vacancies.json._`);
  lines.push("");
}

const externalToday = todays.filter((v) => v.source && v.source !== "rabota.by");
const externalNotEntry = externalToday.filter((v) => !v.entry);
if (externalNotEntry.length) {
  lines.push("## Внешние источники — прочие вакансии (Telegram / LinkedIn)");
  lines.push("");
  lines.push(
    `_${externalNotEntry.length} шт. без явного entry-маркера — просмотрите вручную, часть может подойти._`
  );
  lines.push("");
  const MAX_EXT = 40;
  for (const v of externalNotEntry.slice(0, MAX_EXT)) {
    const badge = v.source === "telegram" ? "TG" : "LI";
    const bits = [
      v.company,
      v.area || null,
      fmtSalary(v),
      fmtFormats(v.workFormats) || null,
    ].filter(Boolean);
    lines.push(`- **[${v.name}](${v.url})** \`${badge}\` — ${bits.join(" · ")}`);
  }
  if (externalNotEntry.length > MAX_EXT) {
    lines.push("");
    lines.push(`_Показаны первые ${MAX_EXT} из ${externalNotEntry.length}._`);
  }
  lines.push("");
}

if (topSkills.length) {
  lines.push("## Что чаще всего требуют (среди новых entry-level)");
  lines.push("");
  lines.push(topSkills.map(([s, c]) => `${s} (${c})`).join(" · "));
  lines.push("");
}

lines.push("## Наблюдения");
lines.push("");
if (!todaysEntry.length) {
  lines.push("- Сегодня новых entry-level вакансий не найдено.");
} else {
  const topTrack = [...byTrack.entries()].sort((a, b) => b[1].length - a[1].length)[0];
  lines.push(
    `- Больше всего новых entry-level вакансий: **${topTrack[0]}** (${topTrack[1].length}).`
  );
  lines.push(
    `- Удалёнка доступна в ${remoteCount} из ${todaysEntry.length} (${Math.round(
      (remoteCount / todaysEntry.length) * 100
    )}%).`
  );
  lines.push(
    `- Вилка указана в ${withSalary} из ${todaysEntry.length} (${Math.round(
      (withSalary / todaysEntry.length) * 100
    )}%).`
  );
  if (topSkills.length) {
    lines.push(`- Самые частые технологии: ${topSkills.slice(0, 5).map(([s]) => s).join(", ")}.`);
  }
}
lines.push("");

const reportDir = path.join(ROOT, "reports", "daily");
fs.mkdirSync(reportDir, { recursive: true });
const reportPath = path.join(reportDir, `${today}.md`);
fs.writeFileSync(reportPath, lines.join("\n"), "utf8");

/* --- daily json --------------------------------------------------- */

const dailyJson = {
  date: today,
  generatedAt: new Date().toISOString(),
  sources: activeSources,
  newTotal: todays.length,
  newEntry: todaysEntry.length,
  searchErrors,
  remoteEntry: remoteCount,
  withSalary,
  bySource: Object.fromEntries(sourceCounts),
  byTrack: Object.fromEntries(
    [...byTrack.entries()].map(([t, list]) => [t, trackStats(list)])
  ),
  topSkills: Object.fromEntries(topSkills),
  topCompanies: (() => {
    const c = new Map();
    for (const v of todaysEntry) c.set(v.company, (c.get(v.company) || 0) + 1);
    return Object.fromEntries([...c.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10));
  })(),
};

fs.writeFileSync(
  path.join(ROOT, "data", "daily", `${today}.json`),
  JSON.stringify(dailyJson, null, 2),
  "utf8"
);

log(
  `report written: reports/daily/${today}.md (new=${todays.length} entry=${todaysEntry.length})`
);

const backfilled = backfillDailyReports(cfg, store, today);
if (backfilled) log(`backfill: restored ${backfilled} daily slice(s) for missed days`);

try {
  const out = generateExports();
  log(
    `exports written: ${out.dashboard} · ${out.recommendationMd} · ${out.vacanciesCsv} · ${out.statsCsv}` +
      (out.recommendation ? ` · выбор: ${out.recommendation.track}` : "")
  );
} catch (e) {
  log(`exports: ERROR ${e.message}`);
}

try {
  const prev = readStatus();
  const prevSuccess = prev.lastSuccessAt ? new Date(prev.lastSuccessAt) : null;
  const missedFullDays = prevSuccess
    ? Math.max(0, Math.floor((startedAt.getTime() - prevSuccess.getTime()) / 86400000) - 1)
    : 0;
  const history = [
    ...(prev.history || []),
    {
      at: new Date().toISOString(),
      today,
      newTotal: todays.length,
      newEntry: todaysEntry.length,
      sources: activeSources,
    },
  ].slice(-60);

  writeStatus({
    lastRunAt: startedAt.toISOString(),
    lastSuccessAt: new Date().toISOString(),
    today,
    sources: activeSources,
    newTotal: todays.length,
    newEntry: todaysEntry.length,
    searchErrors,
    captcha: captchaHit,
    backfilled,
    missedFullDays,
    history,
  });
  log(`status updated (missed full days before run: ${missedFullDays})`);
} catch (e) {
  log(`status: ERROR ${e.message}`);
}
