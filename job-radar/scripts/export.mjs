import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  ROOT,
  loadConfig,
  loadStore,
  dateKey,
  addDays,
  median,
  percentile,
  salaryMid,
  fmtSalary,
  fmtFormats,
  EXPERIENCE_LABEL,
  FORMAT_LABEL,
} from "../lib.mjs";
import {
  buildRecommendation,
  recommendationMarkdown,
  recommendationHtml,
} from "./recommend.mjs";

/* ------------------------------------------------------------------ */
/* Human-readable exports: HTML dashboard + CSV for Excel             */
/* ------------------------------------------------------------------ */

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[c]);

const nf = (n) => (n == null ? "—" : Number(n).toLocaleString("ru-RU"));

function salaryStats(list) {
  const sal = list
    .filter((v) => (v.currency === "BYR" || v.currency === "BYN") && salaryMid(v))
    .map(salaryMid);
  return {
    n: sal.length,
    median: median(sal),
    p25: percentile(sal, 0.25),
    p75: percentile(sal, 0.75),
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

const SOURCE_LABEL = {
  "rabota.by": "rabota.by",
  telegram: "Telegram",
  linkedin: "LinkedIn",
};

function readDailySeries(limit = 14) {
  const dir = path.join(ROOT, "data", "daily");
  if (!fs.existsSync(dir)) return [];
  const files = fs
    .readdirSync(dir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort();
  return files.slice(-limit).map((f) => {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      return {
        date: j.date || f.replace(".json", ""),
        newTotal: j.newTotal ?? 0,
        newEntry: j.newEntry ?? 0,
        remoteEntry: j.remoteEntry ?? 0,
        withSalary: j.withSalary ?? 0,
        bySource: j.bySource || { "rabota.by": j.newTotal || 0 },
      };
    } catch {
      return null;
    }
  }).filter(Boolean);
}

function readStatus() {
  const p = path.join(ROOT, "data", "status.json");
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function bar(value, max, color) {
  const w = max > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0;
  return `<div class="bar"><span style="width:${w}%;background:${color}"></span></div>`;
}

function buildHtml({ cfg, today, start, all, cur, curEntry, daily, rec, status }) {
  const bySource = countBy(cur, (v) => v.source || "rabota.by");
  const byTrack = new Map();
  for (const v of curEntry) {
    const t = v.tracks?.[0] || "Другое";
    if (!byTrack.has(t)) byTrack.set(t, []);
    byTrack.get(t).push(v);
  }
  const trackOrder = [
    ...new Set([
      ...cfg.queries.map((q) => q.track),
      ...cur.map((v) => v.tracks?.[0]).filter(Boolean),
    ]),
  ];

  const skillMap = new Map();
  for (const v of curEntry) for (const s of v.skills || []) skillMap.set(s, (skillMap.get(s) || 0) + 1);
  const topSkills = [...skillMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);

  const formats = countBy(curEntry, (v) => (v.workFormats || [])[0]).map(([f, n]) => [
    FORMAT_LABEL[f] || f,
    n,
  ]);
  const expDist = countBy(curEntry, (v) => EXPERIENCE_LABEL[v.experience] || v.experience);

  const remote = curEntry.filter((v) => v.workFormats?.includes("REMOTE")).length;
  const strict = curEntry.filter((v) => v.experience === "noExperience").length;
  const withSalary = curEntry.filter((v) => v.salaryFrom || v.salaryTo).length;

  const topVacancies = [...curEntry]
    .filter((v) => (v.currency === "BYR" || v.currency === "BYN") && salaryMid(v))
    .sort((a, b) => salaryMid(b) - salaryMid(a))
    .slice(0, 12);

  const maxDaily = Math.max(1, ...daily.map((d) => d.newTotal));
  const maxSkill = Math.max(1, ...topSkills.map(([, n]) => n));

  const sourceCards = bySource
    .map(
      ([s, n]) =>
        `<span class="pill"><b>${esc(SOURCE_LABEL[s] || s)}</b> ${nf(n)}</span>`
    )
    .join("");

  const trackRows = trackOrder
    .map((t) => {
      const list = byTrack.get(t) || [];
      if (!list.length) return "";
      const s = salaryStats(list);
      return `<tr>
        <td>${esc(t)}</td>
        <td class="num">${list.length}</td>
        <td class="num">${list.filter((v) => v.experience === "noExperience").length}</td>
        <td class="num">${nf(s.median)}</td>
        <td class="num">${s.p25 && s.p75 ? `${nf(s.p25)}–${nf(s.p75)}` : "—"}</td>
      </tr>`;
    })
    .join("");

  const skillRows = topSkills
    .map(
      ([name, n]) =>
        `<div class="skill"><div class="skill-head"><span>${esc(name)}</span><b>${n}</b></div>${bar(
          n,
          maxSkill,
          "#5b8def"
        )}</div>`
    )
    .join("");

  const dailyRows = daily
    .map(
      (d) =>
        `<div class="day"><span class="day-date">${esc(d.date)}</span>${bar(
          d.newTotal,
          maxDaily,
          "#8fb3ff"
        )}<b>${d.newTotal}</b><span class="day-entry">entry ${d.newEntry}</span></div>`
    )
    .join("");

  const vacancyItems = topVacancies
    .map(
      (v) =>
        `<li><a href="${esc(v.url)}" target="_blank" rel="noreferrer">${esc(v.name)}</a>
        <span class="muted">— ${esc(v.company)} · ${esc(v.area || "—")} · ${esc(fmtSalary(v))}${
          v.workFormats?.length ? " · " + esc(fmtFormats(v.workFormats)) : ""
        }</span></li>`
    )
    .join("");

  const sourceRows = bySource
    .map(
      ([s, n]) =>
        `<div class="src-row"><span>${esc(SOURCE_LABEL[s] || s)}</span>${bar(
          n,
          Math.max(1, ...bySource.map(([, x]) => x)),
          "#34a853"
        )}<b>${n}</b></div>`
    )
    .join("");

  const formatPills = formats.map(([f, n]) => `<span class="pill">${esc(f)} · ${n}</span>`).join("");
  const expPills = expDist.map(([f, n]) => `<span class="pill">${esc(f)} · ${n}</span>`).join("");

  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Job Radar — статистика ${esc(today)}</title>
<style>
  :root { --bg:#f5f7fb; --card:#fff; --ink:#1c2430; --muted:#68727f; --line:#e4e8ef; --accent:#3f6fe0; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:15px/1.5 "Segoe UI", system-ui, -apple-system, sans-serif; }
  .wrap { max-width:1120px; margin:0 auto; padding:28px 20px 60px; }
  header h1 { margin:0 0 6px; font-size:28px; }
  header p { margin:0; color:var(--muted); }
  .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:12px; margin:22px 0; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:16px; }
  .card .num { font-size:30px; font-weight:700; line-height:1.1; }
  .card .lbl { color:var(--muted); font-size:13px; margin-top:4px; }
  section { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:20px; margin:16px 0; }
  h2 { margin:0 0 14px; font-size:19px; }
  h3 { margin:18px 0 8px; font-size:15px; color:var(--muted); font-weight:600; }
  table { width:100%; border-collapse:collapse; }
  th, td { padding:9px 8px; border-bottom:1px solid var(--line); text-align:left; }
  th { font-size:13px; color:var(--muted); font-weight:600; }
  td.num, th.num { text-align:right; }
  tr:last-child td { border-bottom:0; }
  .pill { display:inline-block; background:#eef2fb; border-radius:999px; padding:5px 11px; margin:3px 6px 3px 0; font-size:13px; }
  .bar { height:8px; background:#edf1f7; border-radius:999px; overflow:hidden; flex:1; }
  .bar span { display:block; height:100%; border-radius:999px; }
  .skill { margin:10px 0; }
  .skill-head { display:flex; justify-content:space-between; font-size:14px; margin-bottom:4px; }
  .day { display:grid; grid-template-columns:110px 1fr 34px 74px; align-items:center; gap:10px; margin:7px 0; font-size:13px; }
  .day-date { color:var(--muted); }
  .day-entry { color:var(--muted); text-align:right; }
  .src-row { display:grid; grid-template-columns:120px 1fr 40px; align-items:center; gap:10px; margin:8px 0; }
  .muted { color:var(--muted); }
  ul { margin:0; padding-left:20px; }
  li { margin:7px 0; }
  a { color:var(--accent); text-decoration:none; }
  a:hover { text-decoration:underline; }
  .note { color:var(--muted); font-size:13px; margin-top:10px; }
  .files { display:flex; gap:10px; flex-wrap:wrap; margin-top:8px; }
  .files a { background:#eef2fb; padding:8px 12px; border-radius:9px; font-size:14px; }
  .reco-answer { background:linear-gradient(135deg,#eef4ff,#f7f9ff); border:1px solid #d7e2fb; border-radius:14px; padding:18px; }
  .reco-label { color:var(--muted); font-size:13px; text-transform:uppercase; letter-spacing:.04em; }
  .reco-main { font-size:30px; font-weight:700; margin:4px 0; }
  .reco-sub { color:var(--muted); }
  .reco-note { margin:10px 0; }
  .reco-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(240px,1fr)); gap:12px; margin:16px 0; }
  .reco-card { border:1px solid var(--line); border-radius:12px; padding:14px; background:#fbfcfe; }
  .reco-card.best { border-color:#9db9f5; background:#f4f8ff; }
  .reco-place { font-size:12px; color:var(--muted); text-transform:uppercase; letter-spacing:.04em; }
  .reco-track { font-weight:700; font-size:17px; margin-top:2px; }
  .reco-roles { color:var(--muted); font-size:13px; }
  .reco-score { margin:8px 0 4px; font-size:20px; }
  .reco-score span { color:var(--muted); font-size:13px; }
  .reco-bar { height:7px; background:#e6ecf7; border-radius:999px; overflow:hidden; margin-bottom:10px; }
  .reco-bar span { display:block; height:100%; background:#3f6fe0; }
  .reco-reasons { display:flex; flex-direction:column; gap:2px; font-size:12.5px; color:var(--muted); margin-bottom:8px; }
  .reco-plan { margin:0; padding-left:22px; }
  .reco-plan li { margin:8px 0; }
  .reco-vacancies { margin-top:0; }
  .warn { background:#fff7e6; border:1px solid #f3d19b; color:#7a5200; border-radius:12px; padding:12px 14px; margin:14px 0; font-size:14px; }
  .table-wrap { overflow-x:auto; -webkit-overflow-scrolling:touch; }
  @media (max-width:640px) {
    .wrap { padding:18px 12px 40px; }
    header h1 { font-size:23px; }
    .cards { grid-template-columns:repeat(2,1fr); }
    .card .num { font-size:24px; }
    .day { grid-template-columns:88px 1fr 28px; }
    .day-entry { display:none; }
    .src-row { grid-template-columns:90px 1fr 34px; }
    th, td { padding:7px 5px; font-size:13px; }
    .reco-main { font-size:24px; }
    .reco-grid { grid-template-columns:1fr; }
    .files a { width:100%; }
  }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>Job Radar — статистика</h1>
    <p>Окно: ${esc(start)} — ${esc(today)} · обновлено ${esc(new Date().toLocaleString("ru-RU"))} · источники: ${esc(
      (cfg.sources || []).map((s) => SOURCE_LABEL[s] || s).join(", ")
    )}${status?.lastSuccessAt ? ` · последний сбор: ${esc(new Date(status.lastSuccessAt).toLocaleString("ru-RU"))}` : ""}</p>
  </header>

  ${
    status?.missedFullDays
      ? `<div class="warn">ПК был выключен ${status.missedFullDays} дн. Пропущенные дневные срезы восстановлены по дате публикации (${status.backfilled || 0} шт.). Следующий сбор догонит окно за 7 дней.</div>`
      : ""
  }

  <div class="cards">
    <div class="card"><div class="num">${nf(all.length)}</div><div class="lbl">вакансий в базе</div></div>
    <div class="card"><div class="num">${nf(cur.length)}</div><div class="lbl">новых за ${Math.round((new Date(today) - new Date(start)) / 86400000) + 1} дн.</div></div>
    <div class="card"><div class="num">${nf(curEntry.length)}</div><div class="lbl">entry-level</div></div>
    <div class="card"><div class="num">${nf(strict)}</div><div class="lbl">строго «без опыта»</div></div>
    <div class="card"><div class="num">${curEntry.length ? Math.round((remote / curEntry.length) * 100) : 0}%</div><div class="lbl">удалёнка (${remote})</div></div>
    <div class="card"><div class="num">${curEntry.length ? Math.round((withSalary / curEntry.length) * 100) : 0}%</div><div class="lbl">с вилкой (${withSalary})</div></div>
  </div>

  ${recommendationHtml(rec)}

  <section>
    <h2>По источникам</h2>
    ${sourceCards || '<span class="muted">Нет данных</span>'}
    <div style="margin-top:14px">${sourceRows}</div>
  </section>

  <section>
    <h2>Направления (entry-level)</h2>
    <div class="table-wrap">
    <table>
      <thead><tr><th>Направление</th><th class="num">Новых</th><th class="num">Без опыта</th><th class="num">Медиана, BYN</th><th class="num">p25–p75</th></tr></thead>
      <tbody>${trackRows || '<tr><td colspan="5" class="muted">Нет данных</td></tr>'}</tbody>
    </table>
    </div>
  </section>

  <section>
    <h2>Динамика по дням</h2>
    ${dailyRows || '<span class="muted">Нет данных</span>'}
    <p class="note">Светлая полоса — все новые IT-вакансии за день, справа — сколько из них entry-level.</p>
  </section>

  <section>
    <h2>Топ технологий (entry-level)</h2>
    ${skillRows || '<span class="muted">Нет данных</span>'}
  </section>

  <section>
    <h2>Формат работы и опыт</h2>
    <h3>Формат</h3>
    <div>${formatPills || '<span class="muted">Нет данных</span>'}</div>
    <h3>Опыт</h3>
    <div>${expPills || '<span class="muted">Нет данных</span>'}</div>
  </section>

  <section>
    <h2>Топ вакансий по вилке</h2>
    ${vacancyItems ? `<ul>${vacancyItems}</ul>` : '<span class="muted">Нет вакансий с указанной вилкой</span>'}
  </section>

  <section>
    <h2>Файлы</h2>
    <p class="muted">Эти файлы обновляются автоматически при каждом сборе.</p>
    <div class="files">
      <a href="vacancies.csv">vacancies.csv — все вакансии для Excel</a>
      <a href="stats.csv">stats.csv — статистика по дням</a>
      <a href="stats.json">stats.json — сводка в JSON</a>
    </div>
  </section>
</div>
</body>
</html>`;
}

/* ------------------------------------------------------------------ */
/* CSV                                                                */
/* ------------------------------------------------------------------ */

function csvCell(v) {
  const s = String(v ?? "");
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows) {
  return "\uFEFF" + rows.map((r) => r.map(csvCell).join(";")).join("\r\n");
}

function vacancyRows(all) {
  const header = [
    "Источник",
    "Название",
    "Компания",
    "Город",
    "Зарплата от",
    "Зарплата до",
    "Валюта",
    "Опыт",
    "Формат",
    "Entry-level",
    "Направления",
    "Технологии",
    "Опубликована",
    "Впервые найдена",
    "Ссылка",
  ];
  const rows = [...all]
    .sort((a, b) => String(b.firstSeen || "").localeCompare(String(a.firstSeen || "")))
    .map((v) => [
      SOURCE_LABEL[v.source] || v.source || "rabota.by",
      v.name,
      v.company,
      v.area,
      v.salaryFrom ?? "",
      v.salaryTo ?? "",
      v.currency ?? "",
      EXPERIENCE_LABEL[v.experience] || v.experience || "",
      fmtFormats(v.workFormats),
      v.entry ? "да" : "нет",
      (v.tracks || []).join(", "),
      (v.skills || v.keySkills || []).join(", "),
      v.publishedAt || "",
      v.firstSeen || "",
      v.url,
    ]);
  return [header, ...rows];
}

function dailyRowsCsv(daily) {
  const header = [
    "Дата",
    "Новых всего",
    "Entry-level",
    "Удалёнка",
    "С вилкой",
    "rabota.by",
    "Telegram",
    "LinkedIn",
  ];
  const rows = daily.map((d) => [
    d.date,
    d.newTotal,
    d.newEntry,
    d.remoteEntry,
    d.withSalary,
    d.bySource?.["rabota.by"] ?? 0,
    d.bySource?.telegram ?? 0,
    d.bySource?.linkedin ?? 0,
  ]);
  return [header, ...rows];
}

/* ------------------------------------------------------------------ */
/* Entry point                                                        */
/* ------------------------------------------------------------------ */

export function generateExports() {
  const cfg = loadConfig();
  const today = dateKey();
  const days = Number(cfg.exportDays || 7);
  const start = addDays(today, -(days - 1));

  const store = loadStore();
  const all = Object.values(store.vacancies || {});
  const cur = all.filter((v) => v.firstSeen && v.firstSeen >= start && v.firstSeen <= today);
  const curEntry = cur.filter((v) => v.entry);
  const daily = readDailySeries(14);
  const rec = buildRecommendation(cfg, all, cfg.recommendDays || 14);
  const status = readStatus();

  const dir = path.join(ROOT, "reports");
  fs.mkdirSync(dir, { recursive: true });

  const html = buildHtml({ cfg, today, start, all, cur, curEntry, daily, rec, status });
  fs.writeFileSync(path.join(dir, "dashboard.html"), html, "utf8");
  fs.writeFileSync(path.join(dir, "vacancies.csv"), toCsv(vacancyRows(all)), "utf8");
  fs.writeFileSync(path.join(dir, "stats.csv"), toCsv(dailyRowsCsv(daily)), "utf8");

  const summary = {
    generatedAt: new Date().toISOString(),
    lastRun: status?.lastSuccessAt || null,
    missedFullDays: status?.missedFullDays ?? null,
    backfilled: status?.backfilled ?? null,
    window: { start, end: today, days },
    totalInStore: all.length,
    newAll: cur.length,
    newEntry: curEntry.length,
    strictNoExperience: curEntry.filter((v) => v.experience === "noExperience").length,
    remote: curEntry.filter((v) => v.workFormats?.includes("REMOTE")).length,
    withSalary: curEntry.filter((v) => v.salaryFrom || v.salaryTo).length,
    bySource: Object.fromEntries(countBy(cur, (v) => v.source || "rabota.by")),
    topSkills: Object.fromEntries(
      [...(() => {
        const m = new Map();
        for (const v of curEntry) for (const s of v.skills || []) m.set(s, (m.get(s) || 0) + 1);
        return m.entries();
      })()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20)
    ),
  };
  fs.writeFileSync(
    path.join(dir, "stats.json"),
    JSON.stringify(summary, null, 2),
    "utf8"
  );

  fs.writeFileSync(
    path.join(dir, "recommendation.md"),
    recommendationMarkdown(rec),
    "utf8"
  );
  fs.writeFileSync(
    path.join(dir, "recommendation.json"),
    JSON.stringify(rec, null, 2),
    "utf8"
  );

  return {
    dashboard: "reports/dashboard.html",
    vacanciesCsv: "reports/vacancies.csv",
    statsCsv: "reports/stats.csv",
    statsJson: "reports/stats.json",
    recommendationMd: "reports/recommendation.md",
    recommendationJson: "reports/recommendation.json",
    summary,
    recommendation: rec.top
      ? {
          track: rec.top.track,
          roles: rec.top.roles,
          score: rec.top.score,
        }
      : null,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const out = generateExports();
  console.log(
    `dashboard: ${out.dashboard} · vacancies: ${out.vacanciesCsv} · stats: ${out.statsCsv}`
  );
}
