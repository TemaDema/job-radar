import {
  dateKey,
  addDays,
  median,
  percentile,
  salaryMid,
  fmtSalary,
  fmtFormats,
  EXPERIENCE_LABEL,
} from "../lib.mjs";

/* ------------------------------------------------------------------ */
/* Recommendation engine: which direction / specialty to choose       */
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

const GENERIC_TRACKS = new Set([
  "Junior",
  "Стажировки",
  "Telegram / чаты",
  "LinkedIn",
  "Разработка (общее)",
  "Backend / другое",
  "Другое",
]);

const TRACK_META = {
  "QA / Тестирование": {
    category: "qa",
    speed: 15,
    roles: "Manual QA Engineer / Тестировщик",
    note: "Самый быстрый и дешёвый вход: старт с ручного тестирования, без программирования.",
    firstSkills: ["QA", "тест-кейсы", "чек-листы", "Jira", "SQL", "Postman"],
  },
  "Поддержка / Helpdesk": {
    category: "support",
    speed: 14,
    roles: "Специалист технической поддержки / Helpdesk",
    note: "Самый быстрый старт в IT, но это трамплин: через 1–2 года уходить в QA, аналитику или администрирование.",
    firstSkills: ["Windows", "Linux", "1С", "Jira", "Английский A2"],
  },
  "Администрирование": {
    category: "infra",
    speed: 13,
    roles: "Системный администратор / Junior Sysadmin",
    note: "Стабильный вход, но меньше удалёнки и медленный рост зарплаты.",
    firstSkills: ["Linux", "Windows Server", "TCP/IP", "Bash", "Active Directory"],
  },
  "1С / ERP": {
    category: "1c",
    speed: 12,
    roles: "Программист 1С / Консультант 1С",
    note: "Много вакансий в Беларуси и быстрый вход, но узкая специализация и меньше удалёнки.",
    firstSkills: ["1С:Предприятие", "SQL", "Excel", "Бухучёт"],
  },
  "Frontend / JS": {
    category: "dev",
    speed: 11,
    roles: "Junior Frontend Developer / Верстальщик",
    note: "Понятное портфолио и много junior-вакансий; английский желательно A2–B1.",
    firstSkills: ["HTML", "CSS", "JavaScript", "React", "Git"],
  },
  "Аналитика": {
    category: "analytics",
    speed: 11,
    roles: "Бизнес-аналитик / Системный аналитик",
    note: "Хороший вход для тех, кто любит данные и процессы; нужны SQL, Excel, BPMN.",
    firstSkills: ["SQL", "Excel", "BPMN/UML", "Jira", "Power BI"],
  },
  "Backend / Python": {
    category: "dev",
    speed: 10,
    roles: "Junior Python Developer",
    note: "Стабильный спрос, но вход дольше: нужны базы, SQL и один фреймворк.",
    firstSkills: ["Python", "SQL", "Git", "Django/Flask", "API"],
  },
  "Backend / PHP": {
    category: "dev",
    speed: 10,
    roles: "Junior PHP Developer",
    note: "Быстрый вход в веб, но меньше зарплаты и вакансий, чем в Python/JS.",
    firstSkills: ["PHP", "SQL", "Git", "Laravel", "HTML"],
  },
  "Backend / Node.js": {
    category: "dev",
    speed: 10,
    roles: "Junior Node.js Developer",
    note: "Быстрый вход, если уже знаете JavaScript; иначе сначала frontend-база.",
    firstSkills: ["JavaScript", "Node.js", "SQL", "Git", "REST"],
  },
  "UI/UX дизайн": {
    category: "design",
    speed: 10,
    roles: "Junior UI/UX Designer",
    note: "Портфолио решает всё; вакансий меньше, конкуренция высокая.",
    firstSkills: ["Figma", "UX-исследования", "Прототипы", "Дизайн-системы"],
  },
  "Backend / Java": {
    category: "dev",
    speed: 9,
    roles: "Junior Java Developer",
    note: "Много корпоративных вакансий, но порог выше и обучение дольше.",
    firstSkills: ["Java", "Spring", "SQL", "Git", "Maven"],
  },
  "Backend / .NET": {
    category: "dev",
    speed: 9,
    roles: "Junior .NET Developer",
    note: "Популярно в белорусских IT-компаниях; нужны C#, SQL и ASP.NET.",
    firstSkills: ["C#", ".NET", "SQL", "Git", "ASP.NET"],
  },
  "DevOps / Cloud": {
    category: "infra",
    speed: 6,
    roles: "Junior DevOps / Cloud Engineer",
    note: "Высокие зарплаты, но сначала нужен опыт администрирования Linux и сетей.",
    firstSkills: ["Linux", "Docker", "CI/CD", "Git", "Kubernetes"],
  },
  "Data / ML": {
    category: "data",
    speed: 5,
    roles: "Data Analyst / Junior Data Scientist",
    note: "Долгий вход: нужна математика, Python и английский B1+. Лучше как второй шаг.",
    firstSkills: ["Python", "Pandas", "SQL", "Machine Learning", "Английский B1"],
  },
};

const CATEGORY_BONUS = {
  qa: 6,
  dev: 5,
  analytics: 4,
  support: 4,
  design: 3,
  "1c": 3,
  infra: 2,
  data: 2,
};

function speedLabel(speed) {
  if (speed >= 14) return "3–6 месяцев";
  if (speed >= 11) return "6–9 месяцев";
  if (speed >= 8) return "9–12 месяцев";
  return "12+ месяцев";
}

export function inferTrack(v) {
  const hay = `${v.name || ""} ${(v.skills || []).join(" ")} ${(v.keySkills || []).join(" ")}`.toLowerCase();
  // Management roles first: "QA" can appear in a PM description and must not hijack the track.
  if (/project manager|product manager|delivery manager|менеджер проект|продакт|project owner/.test(hay)) {
    return "Аналитика";
  }
  if (/\bqa\b|тестировщ|тестирован|quality assurance|test engineer|тест-кейс/.test(hay)) {
    return "QA / Тестирование";
  }
  if (/javascript|typescript|react|vue|angular|html|css|frontend|верст/.test(hay)) return "Frontend / JS";
  if (/python|django|flask|fastapi/.test(hay)) return "Backend / Python";
  if (/\bjava\b|spring/.test(hay)) return "Backend / Java";
  if (/c#|\.net|dotnet|asp\.net/.test(hay)) return "Backend / .NET";
  if (/php|laravel|symfony/.test(hay)) return "Backend / PHP";
  if (/node\.?js|nestjs/.test(hay)) return "Backend / Node.js";
  if (/devops|docker|kubernetes|terraform|ci\/cd/.test(hay)) return "DevOps / Cloud";
  if (/data scientist|machine learning|pytorch|tensorflow|pandas|\bml\b/.test(hay)) return "Data / ML";
  if (/1с|1c|\berp\b/.test(hay)) return "1С / ERP";
  if (/\bsql\b|power bi|tableau|excel|аналитик/.test(hay)) return "Аналитика";
  if (/figma|\bux\b|\bui\b|дизайн/.test(hay)) return "UI/UX дизайн";
  if (/поддержк|helpdesk|service desk/.test(hay)) return "Поддержка / Helpdesk";
  if (/администратор|sysadmin|linux|windows server/.test(hay)) return "Администрирование";
  return null;
}

export function trackOf(v) {
  const raw = v.tracks?.[0] || "Другое";
  if (GENERIC_TRACKS.has(raw)) return inferTrack(v);
  return raw;
}

function aggregate(track, list) {
  const entry = list.filter((v) => v.entry);
  const strict = entry.filter((v) => v.experience === "noExperience");
  const remote = entry.filter((v) => v.workFormats?.includes("REMOTE"));
  const sal = entry
    .filter((v) => (v.currency === "BYR" || v.currency === "BYN") && salaryMid(v))
    .map(salaryMid);

  const skillMap = new Map();
  for (const v of entry) {
    for (const s of v.skills || []) skillMap.set(s, (skillMap.get(s) || 0) + 1);
  }
  const skills = [...skillMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);

  const englishA = entry.filter((v) => v.english && /^A/.test(v.english)).length;
  const englishB = entry.filter((v) => v.english && /^[BC]/.test(v.english)).length;

  return {
    track,
    total: list.length,
    entry: entry.length,
    strict: strict.length,
    remote: remote.length,
    withSalary: sal.length,
    salaryMedian: median(sal),
    salaryP25: percentile(sal, 0.25),
    salaryP75: percentile(sal, 0.75),
    skills,
    englishA,
    englishB,
    entryList: entry,
  };
}

export function buildRecommendation(cfg, all, days) {
  const today = dateKey();
  const windowDays = days || cfg.recommendDays || 14;
  const start = addDays(today, -(windowDays - 1));
  const cur = all.filter((v) => v.firstSeen && v.firstSeen >= start && v.firstSeen <= today);

  const buckets = new Map();
  for (const v of cur) {
    const t = trackOf(v);
    if (!t) continue;
    if (!buckets.has(t)) buckets.set(t, []);
    buckets.get(t).push(v);
  }

  const stats = [...buckets.entries()]
    .map(([t, list]) => aggregate(t, list))
    .filter((s) => s.entry > 0);

  const maxEntry = Math.max(1, ...stats.map((s) => s.entry));
  const medians = stats.map((s) => s.salaryMedian).filter((n) => n != null);
  const minM = medians.length ? Math.min(...medians) : null;
  const maxM = medians.length ? Math.max(...medians) : null;

  const ranked = stats
    .map((s) => {
      const meta = TRACK_META[s.track] || {
        category: "dev",
        speed: 8,
        roles: s.track,
        note: "Направление из базы; оценивайте по навыкам и вакансиям.",
        firstSkills: [],
      };

      const volume = 30 * (s.entry / maxEntry);
      const strictShare = 15 * (s.strict / s.entry);
      const remoteShare = 15 * (s.remote / s.entry);

      let salaryScore = 5;
      if (s.salaryMedian != null) {
        const confidence = s.withSalary >= 5 ? 1 : s.withSalary >= 3 ? 0.8 : 0.5;
        salaryScore =
          (minM != null && maxM != null && maxM > minM
            ? 15 * ((s.salaryMedian - minM) / (maxM - minM))
            : 15) * confidence;
      }

      const engTotal = s.englishA + s.englishB;
      const englishScore = engTotal ? 10 * (s.englishA / engTotal) : 5;
      const profileBonus = CATEGORY_BONUS[meta.category] || 0;

      const score =
        volume + strictShare + remoteShare + salaryScore + meta.speed + englishScore + profileBonus;

      const dataSkills = s.skills.map(([name]) => name);
      const learnSkills = [...new Set([...meta.firstSkills, ...dataSkills])].slice(0, 6);
      const remotePct = Math.round((s.remote / s.entry) * 100);

      const reasons = [
        `${s.entry} entry-level вакансий за ${windowDays} дн.`,
        `${s.strict} строго «без опыта»`,
        `удалёнка в ${remotePct}%`,
      ];
      if (s.salaryMedian != null) {
        reasons.push(`медиана ${nf(s.salaryMedian)} BYN (n=${s.withSalary})`);
      }
      reasons.push(`типичный срок входа: ${speedLabel(meta.speed)}`);

      return {
        track: s.track,
        score: Math.round(score * 10) / 10,
        roles: meta.roles,
        note: meta.note,
        speedLabel: speedLabel(meta.speed),
        category: meta.category,
        entry: s.entry,
        strict: s.strict,
        total: s.total,
        remote: s.remote,
        remotePct,
        withSalary: s.withSalary,
        salaryMedian: s.salaryMedian,
        salaryP25: s.salaryP25,
        salaryP75: s.salaryP75,
        learnSkills,
        reasons,
        vacancies: [...s.entryList]
          .sort((a, b) => {
            const scoreOf = (v) =>
              (v.experience === "noExperience" ? 4 : 0) +
              (v.workFormats?.includes("REMOTE") ? 2 : 0) +
              (v.salaryFrom || v.salaryTo ? 1 : 0);
            const d = scoreOf(b) - scoreOf(a);
            if (d) return d;
            return String(b.publishedAt || "").localeCompare(String(a.publishedAt || ""));
          })
          .slice(0, 3)
          .map((v) => ({
            name: v.name,
            company: v.company,
            area: v.area,
            salary: fmtSalary(v),
            formats: fmtFormats(v.workFormats),
            url: v.url,
            experience: EXPERIENCE_LABEL[v.experience] || v.experience || "",
          })),
      };
    })
    .sort((a, b) => b.score - a.score);

  const top = ranked[0] || null;
  const second = ranked[1] || null;
  const third = ranked[2] || null;

  const plan = top
    ? [
        `Неделя 1 — база: ${top.learnSkills.slice(0, 3).join(", ")}. 1–2 небольших практических кейса.`,
        `Неделя 2 — практика: ${top.learnSkills.slice(3, 5).join(", ") || "закрепление навыков"}. Собрать мини-портфолио.`,
        `Неделя 3 — упаковка: резюме под «${top.roles}», 10 целевых откликов, разбор фидбека.`,
        `Неделя 4 — выход на рынок: ещё 20 откликов, 2–3 собеседования, корректировка резюме по отказам.`,
      ]
    : [];

  return {
    generatedAt: new Date().toISOString(),
    window: { start, end: today, days: windowDays },
    sample: cur.length,
    top,
    second,
    third,
    ranked,
    plan,
    notes: [
      "Оценка построена на вакансиях за окно наблюдения; при малой выборке это ориентир, а не гарантия.",
      "Баллы учитывают количество entry-level вакансий, долю «без опыта», удалёнку, вилку, скорость входа и ваш профиль (QA/разработка, удалёнка, английский A1–A2).",
      "Senior-вакансии в рейтинг не входят: учитываются только entry-level.",
    ],
  };
}

/* ------------------------------------------------------------------ */
/* Markdown                                                           */
/* ------------------------------------------------------------------ */

export function recommendationMarkdown(rec) {
  const L = [];
  L.push("# Job Radar — итог: какое направление выбрать");
  L.push("");
  L.push(
    `Окно: ${rec.window.start} — ${rec.window.end} · вакансий в выборке: ${rec.sample} · обновлено ${new Date(
      rec.generatedAt
    ).toLocaleString("ru-RU")}`
  );
  L.push("");

  if (!rec.top) {
    L.push("## Короткий ответ");
    L.push("");
    L.push("Пока недостаточно entry-level вакансий для уверенного вывода. Нужен ещё один-два запуска сбора.");
    L.push("");
    return L.join("\n");
  }

  L.push("## Короткий ответ");
  L.push("");
  L.push(
    `**Направление: ${rec.top.track}** · специальность: **${rec.top.roles}** · оценка ${rec.top.score}/100.`
  );
  L.push("");
  L.push(rec.top.note);
  L.push("");
  L.push("**Почему именно оно:**");
  for (const r of rec.top.reasons) L.push(`- ${r}`);
  L.push("");
  L.push(`**Что учить в первую очередь:** ${rec.top.learnSkills.join(", ")}.`);
  L.push("");

  L.push("## Рейтинг направлений");
  L.push("");
  L.push("| # | Направление | Балл | Entry | Без опыта | Удалёнка | Медиана, BYN | Вход |");
  L.push("|---:|---|---:|---:|---:|---:|---:|---|");
  rec.ranked.slice(0, 8).forEach((r, i) => {
    L.push(
      `| ${i + 1} | ${r.track} | ${r.score} | ${r.entry} | ${r.strict} | ${r.remotePct}% | ${
        r.salaryMedian != null ? nf(r.salaryMedian) : "—"
      } | ${r.speedLabel} |`
    );
  });
  L.push("");

  L.push("## План на 4 недели");
  L.push("");
  rec.plan.forEach((p) => L.push(`- ${p}`));
  L.push("");

  if (rec.top.vacancies.length) {
    L.push("## Куда откликаться сейчас");
    L.push("");
    for (const v of rec.top.vacancies) {
      L.push(
        `- **[${v.name}](${v.url})** — ${v.company} · ${v.area || "—"} · ${v.salary}${
          v.formats ? " · " + v.formats : ""
        }`
      );
    }
    L.push("");
  }

  if (rec.second) {
    L.push("## Второй вариант");
    L.push("");
    L.push(
      `**${rec.second.track}** (${rec.second.score}/100) — ${rec.second.roles}. ${rec.second.note}`
    );
    L.push("");
  }

  L.push("## Ограничения");
  L.push("");
  for (const n of rec.notes) L.push(`- ${n}`);
  L.push("");

  return L.join("\n");
}

/* ------------------------------------------------------------------ */
/* HTML block for the dashboard                                       */
/* ------------------------------------------------------------------ */

export function recommendationHtml(rec) {
  if (!rec.top) {
    return `<section><h2>Итог: что выбрать</h2><p class="muted">Пока недостаточно данных для вывода — нужен ещё один запуск сбора.</p></section>`;
  }

  const medal = ["1", "2", "3"];
  const cards = rec.ranked
    .slice(0, 3)
    .map(
      (r, i) => `<div class="reco-card${i === 0 ? " best" : ""}">
        <div class="reco-place">${medal[i]} место</div>
        <div class="reco-track">${esc(r.track)}</div>
        <div class="reco-roles">${esc(r.roles)}</div>
        <div class="reco-score"><b>${r.score}</b><span>/100</span></div>
        <div class="reco-bar"><span style="width:${Math.min(100, r.score)}%"></span></div>
        <div class="reco-reasons">${r.reasons.map((x) => `<span>${esc(x)}</span>`).join("")}</div>
        <div class="reco-skills">${r.learnSkills
          .slice(0, 5)
          .map((s) => `<span class="pill">${esc(s)}</span>`)
          .join("")}</div>
      </div>`
    )
    .join("");

  const plan = rec.plan.map((p) => `<li>${esc(p)}</li>`).join("");
  const vacancies = rec.top.vacancies
    .map(
      (v) =>
        `<li><a href="${esc(v.url)}" target="_blank" rel="noreferrer">${esc(v.name)}</a> <span class="muted">— ${esc(
          v.company
        )} · ${esc(v.area || "—")} · ${esc(v.salary)}</span></li>`
    )
    .join("");

  return `<section class="reco">
    <h2>Итог: что выбрать</h2>
    <div class="reco-answer">
      <div>
        <div class="reco-label">Рекомендуемое направление</div>
        <div class="reco-main">${esc(rec.top.track)}</div>
        <div class="reco-sub">Специальность: <b>${esc(rec.top.roles)}</b> · оценка ${rec.top.score}/100</div>
        <p class="reco-note">${esc(rec.top.note)}</p>
        <div class="reco-skills">${rec.top.learnSkills
          .map((s) => `<span class="pill">${esc(s)}</span>`)
          .join("")}</div>
      </div>
    </div>
    <div class="reco-grid">${cards}</div>
    <h3>План на 4 недели</h3>
    <ol class="reco-plan">${plan}</ol>
    ${
      vacancies
        ? `<h3>Куда откликаться сейчас</h3><ul class="reco-vacancies">${vacancies}</ul>`
        : ""
    }
    <p class="note">${esc(rec.notes[0])}</p>
  </section>`;
}
