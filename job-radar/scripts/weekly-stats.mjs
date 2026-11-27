import fs from "node:fs";
import path from "node:path";
import {
  ROOT,
  loadConfig,
  ensureDirs,
  loadStore,
  dateKey,
  addDays,
  isoWeekKey,
  median,
  percentile,
  salaryMid,
  fmtSalary,
  fmtFormats,
  mdEscape,
  EXPERIENCE_LABEL,
} from "../lib.mjs";
import { generateExports } from "./export.mjs";
import { buildRecommendation } from "./recommend.mjs";

const cfg = loadConfig();
ensureDirs();

const today = dateKey();
const days = Number(process.argv[2] || 7);
const end = today;
const start = addDays(end, -(days - 1));
const prevEnd = addDays(start, -1);
const prevStart = addDays(prevEnd, -(days - 1));
const week = isoWeekKey(end);

const store = loadStore();
const all = Object.values(store.vacancies);

const inRange = (v, a, b) => v.firstSeen && v.firstSeen >= a && v.firstSeen <= b;

const cur = all.filter((v) => inRange(v, start, end));
const prev = all.filter((v) => inRange(v, prevStart, prevEnd));
const curEntry = cur.filter((v) => v.entry);
const prevEntry = prev.filter((v) => v.entry);

const trackOrder = [
  ...new Set([
    ...cfg.queries.map((q) => q.track),
    ...cur.map((v) => v.tracks?.[0]).filter(Boolean),
  ]),
];

function trackList(list) {
  const m = new Map();
  for (const v of list) {
    const t = v.tracks?.[0] || "Другое";
    if (!m.has(t)) m.set(t, []);
    m.get(t).push(v);
  }
  return m;
}

const curByTrack = trackList(cur);
const curEntryByTrack = trackList(curEntry);
const prevEntryByTrack = trackList(prevEntry);

function salaryStats(list) {
  const sal = list
    .filter((v) => (v.currency === "BYR" || v.currency === "BYN") && salaryMid(v))
    .map(salaryMid);
  return {
    n: sal.length,
    median: median(sal),
    p25: percentile(sal, 0.25),
    p75: percentile(sal, 0.75),
    min: sal.length ? Math.min(...sal) : null,
    max: sal.length ? Math.max(...sal) : null,
  };
}

function countBy(list, fn) {
  const m = new Map();
  for (const v of list) {
    const k = fn(v);
    if (!k) continue;
    m.set(k, (m.get(k) || 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

const skillMap = new Map();
for (const v of curEntry) for (const s of v.skills || []) skillMap.set(s, (skillMap.get(s) || 0) + 1);
const topSkills = [...skillMap.entries()].sort((a, b) => b[1] - a[1]);

const skillMapPrev = new Map();
for (const v of prevEntry) for (const s of v.skills || []) skillMapPrev.set(s, (skillMapPrev.get(s) || 0) + 1);

const topCompanies = countBy(curEntry, (v) => v.company).slice(0, 12);
const formatCounts = new Map();
for (const v of curEntry) {
  for (const f of v.workFormats || []) formatCounts.set(f, (formatCounts.get(f) || 0) + 1);
}
const formats = [...formatCounts.entries()].sort((a, b) => b[1] - a[1]);
const experienceDist = countBy(curEntry, (v) => EXPERIENCE_LABEL[v.experience] || v.experience);
const strictNoExp = curEntry.filter((v) => v.experience === "noExperience").length;
const remote = curEntry.filter((v) => v.workFormats?.includes("REMOTE")).length;

const withSalary = curEntry.filter((v) => v.salaryFrom || v.salaryTo).length;

const SOURCE_LABEL = {
  "rabota.by": "rabota.by",
  telegram: "Telegram",
  linkedin: "LinkedIn",
};
const bySource = countBy(cur, (v) => v.source || "rabota.by");
const sourceText = bySource
  .map(([s, n]) => `${SOURCE_LABEL[s] || s} ${n}`)
  .join(" · ");

const topVacancies = [...curEntry]
  .filter((v) => (v.currency === "BYR" || v.currency === "BYN") && salaryMid(v))
  .sort((a, b) => salaryMid(b) - salaryMid(a))
  .slice(0, 20);

/* ------------------------------------------------------------------ */
/* JSON                                                                */
/* ------------------------------------------------------------------ */

const stats = {
  week,
  window: { start, end, days, prevStart, prevEnd },
  totals: {
    newAll: cur.length,
    newEntry: curEntry.length,
    prevAll: prev.length,
    prevEntry: prevEntry.length,
    strictNoExperience: strictNoExp,
    remote,
    withSalary,
    marketEntryShare: cur.length ? Math.round((curEntry.length / cur.length) * 100) : 0,
    bySource: Object.fromEntries(bySource),
  },
  byTrack: Object.fromEntries(
    trackOrder
      .filter((t) => curEntryByTrack.has(t) || curByTrack.has(t))
      .map((t) => {
        const entry = curEntryByTrack.get(t) || [];
        const prevT = prevEntryByTrack.get(t) || [];
        return [
          t,
          {
            newAll: (curByTrack.get(t) || []).length,
            newEntry: entry.length,
            prevEntry: prevT.length,
            salary: salaryStats(entry),
          },
        ];
      })
  ),
  topSkills: topSkills.slice(0, 30).map(([name, count]) => ({
    name,
    count,
    prev: skillMapPrev.get(name) || 0,
  })),
  topCompanies,
  formats,
  experienceDist,
  topVacancies: topVacancies.map((v) => ({
    id: v.id,
    name: v.name,
    company: v.company,
    area: v.area,
    salary: fmtSalary(v),
    salaryMid: salaryMid(v),
    url: v.url,
    skills: (v.skills || []).slice(0, 10),
    formats: v.workFormats,
    experience: v.experience,
    publishedAt: v.publishedAt,
  })),
};

const dataDir = path.join(ROOT, "data", "weekly");
fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(path.join(dataDir, `${week}.json`), JSON.stringify(stats, null, 2), "utf8");

/* ------------------------------------------------------------------ */
/* Markdown draft                                                      */
/* ------------------------------------------------------------------ */

const L = [];
L.push(`# Job Radar — неделя ${week}`);
L.push("");
L.push(
  `Окно: ${start} — ${end} · источники: ${(cfg.sources || ["rabota.by"])
    .map((s) => SOURCE_LABEL[s] || s)
    .join(" · ")} · сравнение с ${prevStart} — ${prevEnd}`
);
L.push("");
if (sourceText) {
  L.push(`По источникам: ${sourceText}`);
  L.push("");
}
L.push("## Сводка");
L.push("");
L.push(`- Новых вакансий всего: **${cur.length}** (неделей ранее: ${prev.length})`);
L.push(
  `- Новых entry-level: **${curEntry.length}** (неделей ранее: ${prevEntry.length}) · строго «без опыта»: ${strictNoExp}`
);
L.push(
  `- Доля entry-level среди всех новых IT-вакансий: ${stats.totals.marketEntryShare}%`
);
L.push(
  `- Удалёнка: ${remote} из ${curEntry.length} (${curEntry.length ? Math.round((remote / curEntry.length) * 100) : 0}%)`
);
L.push(
  `- Указана вилка: ${withSalary} из ${curEntry.length} (${curEntry.length ? Math.round((withSalary / curEntry.length) * 100) : 0}%)`
);
L.push("");

L.push("## Направления (entry-level)");
L.push("");
L.push("| Направление | Новых | Пред. неделя | Δ | Медиана, BYN | p25–p75 |");
L.push("|---|---:|---:|---:|---:|---:|");
for (const t of trackOrder) {
  const s = stats.byTrack[t];
  if (!s || (!s.newEntry && !s.prevEntry)) continue;
  const delta = s.newEntry - s.prevEntry;
  L.push(
    `| ${mdEscape(t)} | ${s.newEntry} | ${s.prevEntry} | ${delta > 0 ? "+" : ""}${delta} | ${
      s.salary.median ? s.salary.median.toLocaleString("ru-RU") : "—"
    } | ${
      s.salary.p25 && s.salary.p75
        ? `${s.salary.p25.toLocaleString("ru-RU")}–${s.salary.p75.toLocaleString("ru-RU")}`
        : "—"
    } |`
  );
}
L.push("");

L.push("## Топ технологий (entry-level)");
L.push("");
L.push("| Технология | Упоминаний | Пред. неделя |");
L.push("|---|---:|---:|");
for (const s of stats.topSkills.slice(0, 20)) {
  L.push(`| ${s.name} | ${s.count} | ${s.prev} |`);
}
L.push("");

L.push("## Компании");
L.push("");
L.push(topCompanies.map(([c, n]) => `${c} (${n})`).join(" · ") || "—");
L.push("");

L.push("## Формат работы");
L.push("");
L.push(formats.map(([f, n]) => `${f} (${n})`).join(" · ") || "—");
L.push("");

L.push("## Опыт");
L.push("");
L.push(experienceDist.map(([f, n]) => `${f} (${n})`).join(" · ") || "—");
L.push("");

L.push("## Топ вакансий по вилке");
L.push("");
for (const v of stats.topVacancies) {
  L.push(
    `- **[${v.name}](${v.url})** — ${v.company} · ${v.area} · ${v.salary} · ${
      fmtFormats(v.formats) || "—"
    }`
  );
  if (v.skills.length) L.push(`  - ${v.skills.join(", ")}`);
}
L.push("");

const reportDir = path.join(ROOT, "reports", "weekly");
fs.mkdirSync(reportDir, { recursive: true });
const draftPath = path.join(reportDir, `${week}-stats.md`);

const rec = buildRecommendation(cfg, all, cfg.recommendDays || 14);
L.push("## Итог: что выбрать");
L.push("");
if (rec.top) {
  L.push(
    `**${rec.top.track}** — ${rec.top.roles} · оценка ${rec.top.score}/100. ${rec.top.note}`
  );
  L.push("");
  L.push("Почему:");
  for (const r of rec.top.reasons) L.push(`- ${r}`);
  L.push("");
  L.push(`Учить в первую очередь: ${rec.top.learnSkills.join(", ")}.`);
  L.push("");
  L.push("План на 4 недели:");
  for (const p of rec.plan) L.push(`- ${p}`);
  if (rec.second) {
    L.push("");
    L.push(`Второй вариант: **${rec.second.track}** (${rec.second.score}/100) — ${rec.second.roles}.`);
  }
} else {
  L.push("Пока недостаточно entry-level вакансий для уверенного вывода.");
}
L.push("");

fs.writeFileSync(draftPath, L.join("\n"), "utf8");

let exportsInfo = null;
try {
  exportsInfo = generateExports();
} catch (e) {
  console.error(`exports: ERROR ${e.message}`);
}

console.log(
  JSON.stringify(
    {
      week,
      window: stats.window,
      totals: stats.totals,
      draft: `reports/weekly/${week}-stats.md`,
      json: `data/weekly/${week}.json`,
      dashboard: exportsInfo?.dashboard || null,
      recommendation: exportsInfo?.recommendationMd || null,
      vacanciesCsv: exportsInfo?.vacanciesCsv || null,
      statsCsv: exportsInfo?.statsCsv || null,
    },
    null,
    2
  )
);
