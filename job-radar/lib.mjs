import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.dirname(fileURLToPath(import.meta.url));
export const TZ = "Europe/Minsk";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

export const BASE_HEADERS = {
  "User-Agent": UA,
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "ru-RU,ru;q=0.9,en;q=0.6",
};

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

/* ------------------------------------------------------------------ */
/* Files / config                                                      */
/* ------------------------------------------------------------------ */

export function loadConfig() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
}

export function ensureDirs() {
  for (const d of ["data", "data/daily", "data/weekly", "reports/daily", "reports/weekly"]) {
    fs.mkdirSync(path.join(ROOT, d), { recursive: true });
  }
}

export function loadStore() {
  const p = path.join(ROOT, "data", "vacancies.json");
  if (!fs.existsSync(p)) return { version: 1, updatedAt: null, vacancies: {} };
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

export function saveStore(store) {
  store.updatedAt = new Date().toISOString();
  const p = path.join(ROOT, "data", "vacancies.json");
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 1), "utf8");
  fs.renameSync(tmp, p);
}

/* ------------------------------------------------------------------ */
/* Dates                                                               */
/* ------------------------------------------------------------------ */

export function dateKey(d = new Date()) {
  return d.toLocaleDateString("sv-SE", { timeZone: TZ });
}

export function addDays(key, n) {
  const [y, m, d] = key.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

export function isoWeekKey(key = dateKey()) {
  const [y, m, d] = key.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dayNum = dt.getUTCDay() || 7;
  dt.setUTCDate(dt.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((dt - yearStart) / 86400000) + 1) / 7);
  return `${dt.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export function median(nums) {
  const a = nums.filter((n) => Number.isFinite(n)).sort((x, y) => x - y);
  if (!a.length) return null;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : Math.round((a[mid - 1] + a[mid]) / 2);
}

export function percentile(nums, p) {
  const a = nums.filter((n) => Number.isFinite(n)).sort((x, y) => x - y);
  if (!a.length) return null;
  const idx = Math.min(a.length - 1, Math.max(0, Math.round((a.length - 1) * p)));
  return a[idx];
}

/* ------------------------------------------------------------------ */
/* HTTP + parsing rabota.by (hh.ru Belarus)                            */
/* ------------------------------------------------------------------ */

let session = null;

export class CaptchaError extends Error {
  constructor(url) {
    super(`captcha at ${url}`);
    this.name = "CaptchaError";
  }
}

async function refreshSession() {
  const res = await fetch("https://rabota.by/", {
    headers: BASE_HEADERS,
    signal: AbortSignal.timeout(30000),
  });
  const cookies =
    typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  session = {
    cookie: cookies.map((c) => c.split(";")[0]).join("; "),
    at: Date.now(),
  };
  return session;
}

async function request(url, referer = "https://rabota.by/") {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const s = session ?? (await refreshSession());
      const res = await fetch(url, {
        headers: { ...BASE_HEADERS, Cookie: s.cookie, Referer: referer },
        signal: AbortSignal.timeout(35000),
      });
      if ([403, 406, 429].includes(res.status)) {
        session = null;
        lastErr = new Error(`HTTP ${res.status}`);
        await sleep(1500 + attempt * 1500);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
      const text = await res.text();
      if (/Подтвердите, что вы не робот/i.test(text)) throw new CaptchaError(url);
      return text;
    } catch (e) {
      if (e instanceof CaptchaError) throw e;
      lastErr = e;
      session = null;
      await sleep(800);
    }
  }
  throw lastErr ?? new Error(`request failed: ${url}`);
}

export function decodeEntities(s) {
  return String(s)
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

export function parseState(html) {
  const m = html.match(/id="HH-Lux-InitialState">([\s\S]*?)<\/template>/);
  if (!m) throw new Error("initial state not found");
  return JSON.parse(decodeEntities(m[1]));
}

export function stripHtml(html) {
  return decodeEntities(
    String(html)
      .replace(/<\s*br\s*\/?>/gi, "\n")
      .replace(/<\/(p|li|div|h[1-6]|tr)>/gi, "\n")
      .replace(/<li[^>]*>/gi, "• ")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

export async function searchVacancies(cfg, query) {
  const out = [];
  for (let page = 0; page < cfg.maxPages; page++) {
    const u = new URL("https://rabota.by/search/vacancy");
    if (query.text) u.searchParams.set("text", query.text);
    if (query.professionalRole) u.searchParams.set("professional_role", String(query.professionalRole));
    u.searchParams.set("area", String(cfg.area));
    u.searchParams.set("order_by", "publication_time");
    u.searchParams.set("search_period", String(cfg.searchPeriodDays));
    if (cfg.searchField) u.searchParams.set("search_field", cfg.searchField);
    u.searchParams.set("page", String(page));

    const html = await request(u.toString());
    const state = parseState(html);
    const res = state.vacancySearchResult;
    const items = res?.vacancies ?? [];
    out.push(...items);

    const pages = res?.paging?.pages ?? 1;
    if (page + 1 >= pages) break;
    await sleep(cfg.requestDelayMs);
  }
  return out;
}

export async function fetchVacancyDetails(id) {
  const html = await request(`https://rabota.by/vacancy/${id}`);
  const state = parseState(html);
  const v = state.vacancyView?.vacancyFull?.vacancy;
  if (!v) return null;
  return {
    text: stripHtml(v.description || ""),
    keySkills: Array.isArray(v.keySkills)
      ? v.keySkills.map((s) => (typeof s === "string" ? s : s?.name)).filter(Boolean)
      : [],
    workFormats: Array.isArray(v.workFormats) ? v.workFormats : [],
    experience: v.workExperience ?? null,
  };
}

/* ------------------------------------------------------------------ */
/* Normalisation / classification                                      */
/* ------------------------------------------------------------------ */

const numOrNull = (x) => {
  const n = Number(x);
  return Number.isFinite(n) && n > 0 ? n : null;
};

export function normalizeVacancy(raw, query) {
  const comp = raw.compensation || {};
  return {
    id: String(raw.vacancyId),
    source: "rabota.by",
    name: raw.name || "",
    company: raw.company?.visibleName || raw.company?.name || "—",
    area: raw.area?.name || "",
    salaryFrom: numOrNull(comp.from ?? comp.perModeFrom),
    salaryTo: numOrNull(comp.to ?? comp.perModeTo),
    currency: comp.currencyCode || null,
    gross: typeof comp.gross === "boolean" ? comp.gross : null,
    salaryMode: comp.mode || null,
    experience: raw.workExperience || null,
    employment: raw.employment?.["@type"] || raw.employment?.type || null,
    workFormats: flattenWorkFormats(raw.workFormats),
    professionalRoleIds: Array.isArray(raw.professionalRoleIds) ? raw.professionalRoleIds : [],
    publishedAt:
      raw.publicationTime?.["$"] ||
      (raw.publicationTime?.["@timestamp"]
        ? new Date(raw.publicationTime["@timestamp"] * 1000).toISOString()
        : null),
    url: `https://rabota.by/vacancy/${raw.vacancyId}`,
    tracks: [query.track],
    queries: [query.id],
    firstSeen: null,
    lastSeen: null,
    entry: false,
    entryReason: null,
    skills: [],
    english: null,
    descSnippet: "",
    keySkills: [],
  };
}

const JUNIOR_RE =
  /\b(junior|trainee|intern|internship|entry[- ]level)\b|джун|стаж[её]р|стажировк|без опыта|начинающ|младший|помощник|ученик/i;

export function isEntry(v, description = "") {
  if (v.experience === "noExperience") return { entry: true, reason: "noExperience" };
  const m = `${v.name}\n${description}`.match(JUNIOR_RE);
  if (m) return { entry: true, reason: `keyword:${m[0].toLowerCase()}` };
  return { entry: false, reason: null };
}

const IT_ROLE_IDS = new Set([
  156, 160, 10, 12, 150, 25, 165, 34, 36, 73, 155, 96, 164, 104, 157, 107,
  112, 113, 148, 114, 116, 121, 124, 125, 126,
]);

/* Strong IT markers: keep even if the title contains a non-IT word. */
const STRONG_IT_RE =
  /(разработ|программист|developer|devops|\bqa\b|quality assurance|тестировщ|тестирован|автотест|системн[а-яёa-z0-9]*\s+(администратор|аналитик|инженер|интегратор)|администратор\s+(сет|систем|баз)|техническ[а-яёa-z0-9]*\s+поддержк|поддержк[а-яёa-z0-9]*\s+пользовател|data\s+(scientist|engineer|analyst)|\b1с-?разработ|bitrix|битрикс|\bml\b|machine learning)/i;

/* Obvious non-IT jobs (only applied when there is no strong IT marker). */
const NON_IT_RE =
  /(бухгалтер|экономист|финанс|кредитн|продавец|кассир|водител|грузчик|повар|столяр|охранник|уборщ|санитар|кладовщик|логист|маркетолог|маркетинг|\bsmm\b|\bsales\b|таргетолог|копирайтер|рекрутер|подбор персонала|\bhr\b|юрист|сварщик|слесар|механик|электромонт|строител|проектировщик|флорист|педагог|учител|врач|медсестр|фармацевт|технолог|инженер по качеству|ассистент|помощник руководител|секретар|офис-менеджер|менеджер по продажам|специалист по продажам|менеджер по закупк|специалист по закупк|снабжен)/i;

const HARD_EXCLUDE_RE = /(компьютерн[а-яёa-z0-9]* клуб|преподавател|репетитор|учител)/i;

const IT_INCLUDE_RE =
  /(разработ|программист|developer|engineer|инженер-программ|devops|\bsre\b|\bqa\b|quality assurance|тестировщ|тестирован|автотест|analyst|аналитик|data\b|machine learning|\bml\b|\bai\b|\bии\b|интеллект|системн|системотехник|администратор|administrator|system admin|сетев|\bсет[ьи]\b|поддержк|helpdesk|service desk|\b1с\b|\b1c\b|\berp\b|\bcrm\b|\bsap\b|bitrix|битрикс|\bsql\b|баз данных|\bdba\b|информационн|защит[а-яёa-z0-9]* информац|кибербезопасн|security|дизайнер интерфейс|\bui\b|\bux\b|веб-?дизайн|продуктов[а-яёa-z0-9]* дизайн|мобильн|android|\bios\b|flutter|unity|gamedev|геймдев|game designer|level designer|геймдизайн|tech artist|техническ[а-яёa-z0-9]* художник|техническ[а-яёa-z0-9]* писател|архитектор|тимлид|team ?lead|product (manager|owner)|продукт[а-яёa-z0-9]* менеджер|проектн[а-яёa-z0-9]* менеджер|project manager|delivery manager|scrum|agile|\bbi\b|power bi|tableau|верстальщик|frontend|backend|fullstack|full-stack)/i;

export function isItTitle(name) {
  const t = String(name || "");
  if (HARD_EXCLUDE_RE.test(t)) return false;
  if (NON_IT_RE.test(t) && !STRONG_IT_RE.test(t)) return false;
  return IT_INCLUDE_RE.test(t);
}

/* Free-form posts (Telegram) are longer than a title, so the non-IT guard
   would produce false negatives. For them we only require an IT marker. */
export function hasItMarker(text) {
  return IT_INCLUDE_RE.test(String(text || ""));
}

export function isItRelated(raw) {
  const hay = `${raw.name || ""} ${raw.company?.name || ""}`;
  if (IT_INCLUDE_RE.test(hay)) return true;
  const roles = Array.isArray(raw.professionalRoleIds) ? raw.professionalRoleIds : [];
  return roles.some((id) => IT_ROLE_IDS.has(Number(id)));
}

export function flattenWorkFormats(wf) {
  if (!Array.isArray(wf)) return [];
  const out = new Set();
  for (const item of wf) {
    if (typeof item === "string") {
      out.add(item);
    } else if (item && typeof item === "object") {
      for (const v of Object.values(item)) {
        if (Array.isArray(v)) {
          for (const x of v) if (typeof x === "string") out.add(x);
        } else if (typeof v === "string") {
          out.add(v);
        }
      }
    }
  }
  return [...out];
}

/* ------------------------------------------------------------------ */
/* Skills                                                              */
/* ------------------------------------------------------------------ */

const SKILL_DEFS = [
  ["Python", ["python"]],
  ["JavaScript", ["javascript", "js"]],
  ["TypeScript", ["typescript"]],
  ["React", ["react"]],
  ["Vue", ["vue"]],
  ["Angular", ["angular"]],
  ["Node.js", ["node.js", "nodejs", "node js"]],
  ["Next.js", ["next.js", "nextjs"]],
  ["HTML", ["html"]],
  ["CSS", ["css", "sass", "scss"]],
  ["Java", ["java"]],
  ["Spring", ["spring"]],
  ["Kotlin", ["kotlin"]],
  ["Swift", ["swift"]],
  ["C#", ["c#"]],
  [".NET", [".net", "asp.net", "dotnet"]],
  ["PHP", ["php"]],
  ["Laravel", ["laravel"]],
  ["Symfony", ["symfony"]],
  ["Go", ["golang", "go-разработчик", "go developer"]],
  ["C++", ["c++"]],
  ["SQL", ["sql"]],
  ["PostgreSQL", ["postgresql", "postgres"]],
  ["MySQL", ["mysql"]],
  ["Oracle", ["oracle"]],
  ["MongoDB", ["mongodb", "mongo"]],
  ["Redis", ["redis"]],
  ["Git", ["git"]],
  ["Docker", ["docker"]],
  ["Kubernetes", ["kubernetes", "k8s"]],
  ["Linux", ["linux", "ubuntu", "debian"]],
  ["Windows Server", ["windows server", "active directory"]],
  ["CI/CD", ["ci/cd", "cicd"]],
  ["Jenkins", ["jenkins"]],
  ["GitLab CI", ["gitlab"]],
  ["Terraform", ["terraform"]],
  ["AWS", ["aws", "amazon web services"]],
  ["Azure", ["azure"]],
  ["GCP", ["gcp", "google cloud"]],
  ["REST", ["rest", "restful"]],
  ["GraphQL", ["graphql"]],
  ["Microservices", ["микросервис", "microservice"]],
  ["Selenium", ["selenium"]],
  ["Playwright", ["playwright"]],
  ["Cypress", ["cypress"]],
  ["Postman", ["postman"]],
  ["API", ["api"]],
  ["SOAP", ["soap"]],
  ["Test case", ["test case", "тест-кейс", "тест кейс"]],
  ["Check-list", ["check-list", "checklist", "чек-лист"]],
  ["Unit Testing", ["unit test", "юнит-тест"]],
  ["Функциональное тестирование", ["функциональное тестирование"]],
  ["Регрессионное тестирование", ["регрессионное тестирование"]],
  ["Бизнес-анализ", ["бизнес-анализ", "business analysis"]],
  ["Моделирование процессов", ["моделирование бизнес-процессов", "описание бизнес-процессов"]],
  ["Swagger", ["swagger", "openapi"]],
  ["JSON", ["json"]],
  ["HTTP", ["http"]],
  ["Jira", ["jira"]],
  ["Confluence", ["confluence"]],
  ["Agile", ["agile"]],
  ["Scrum", ["scrum"]],
  ["Kanban", ["kanban"]],
  ["Figma", ["figma"]],
  ["Sketch", ["sketch"]],
  ["Photoshop", ["photoshop"]],
  ["Illustrator", ["illustrator"]],
  ["Power BI", ["power bi", "powerbi"]],
  ["Tableau", ["tableau"]],
  ["Excel", ["excel"]],
  ["1С", ["1с", "1c"]],
  ["SAP", ["sap"]],
  ["Bitrix", ["bitrix", "битрикс"]],
  ["Django", ["django"]],
  ["Flask", ["flask"]],
  ["FastAPI", ["fastapi"]],
  ["Pandas", ["pandas"]],
  ["NumPy", ["numpy"]],
  ["PyTorch", ["pytorch"]],
  ["TensorFlow", ["tensorflow"]],
  ["Machine Learning", ["machine learning", "машинное обучение"]],
  ["NLP", ["nlp", "обработка естественного языка"]],
  ["Computer Vision", ["computer vision", "компьютерное зрение"]],
  ["Airflow", ["airflow"]],
  ["Spark", ["spark"]],
  ["Kafka", ["kafka"]],
  ["RabbitMQ", ["rabbitmq"]],
  ["Elasticsearch", ["elasticsearch", "elastic search"]],
  ["Nginx", ["nginx"]],
  ["Bash", ["bash"]],
  ["PowerShell", ["powershell"]],
  ["TCP/IP", ["tcp/ip", "tcp ip"]],
  ["VPN", ["vpn"]],
  ["Zabbix", ["zabbix"]],
  ["Grafana", ["grafana"]],
  ["Prometheus", ["prometheus"]],
  ["Ansible", ["ansible"]],
  ["Unity", ["unity"]],
  ["Unreal Engine", ["unreal engine", "unreal"]],
  ["Flutter", ["flutter"]],
  ["React Native", ["react native"]],
  ["Android", ["android"]],
  ["iOS", ["ios"]],
  ["SEO", ["seo"]],
  ["Google Analytics", ["google analytics"]],
  ["UML", ["uml"]],
  ["BPMN", ["bpmn"]],
  ["SQL Server", ["sql server", "mssql"]],
  ["QA", ["тестирован", "тестировщ", "qa", "quality assurance"]],
  ["Manual QA", ["ручное тестирование", "manual qa"]],
  ["Autotests", ["автотест", "automation qa", "автоматизац"]],
  ["Jmeter", ["jmeter"]],
  ["SoapUI", ["soapui"]],
  ["Fiddler", ["fiddler"]],
  ["DevTools", ["devtools", "dev tools"]],
];

function buildPattern(p) {
  const esc = p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pre = /^[A-Za-zА-Яа-я0-9]/.test(p) ? "(?<![A-Za-zА-Яа-я0-9])" : "";
  const post = /[A-Za-zА-Яа-я0-9]$/.test(p) ? "(?![A-Za-zА-Яа-я0-9])" : "";
  return new RegExp(pre + esc + post, "i");
}

const COMPILED_SKILLS = SKILL_DEFS.map(([name, pats]) => [
  name,
  pats.map(buildPattern),
]);

export function detectSkills(text) {
  if (!text) return [];
  const found = new Set();
  for (const [name, regs] of COMPILED_SKILLS) {
    if (regs.some((re) => re.test(text))) found.add(name);
  }
  return [...found];
}

export function detectEnglish(text) {
  const m = String(text).match(
    /(?:английск[а-яёa-z0-9]*|english)[^.\n]{0,80}?\b(A1|A2|B1|B2|C1|C2)\b/i
  );
  return m ? m[1].toUpperCase() : null;
}

/* ------------------------------------------------------------------ */
/* Formatting                                                          */
/* ------------------------------------------------------------------ */

export const CURRENCY_LABEL = { BYR: "BYN", BYN: "BYN", USD: "USD", EUR: "EUR" };

export function fmtSalary(v) {
  const cur = CURRENCY_LABEL[v.currency] || v.currency || "";
  const n = (x) => x.toLocaleString("ru-RU");
  if (v.salaryFrom && v.salaryTo) return `${n(v.salaryFrom)}–${n(v.salaryTo)} ${cur}`.trim();
  if (v.salaryFrom) return `от ${n(v.salaryFrom)} ${cur}`.trim();
  if (v.salaryTo) return `до ${n(v.salaryTo)} ${cur}`.trim();
  return "з/п не указана";
}

export function salaryMid(v) {
  if (v.salaryFrom && v.salaryTo) return (v.salaryFrom + v.salaryTo) / 2;
  return v.salaryFrom || v.salaryTo || null;
}

export const FORMAT_LABEL = {
  REMOTE: "удалённо",
  ON_SITE: "офис",
  HYBRID: "гибрид",
  FIELD_WORK: "разъездная",
};

export const EXPERIENCE_LABEL = {
  noExperience: "без опыта",
  between1And3: "1–3 года",
  between3And6: "3–6 лет",
  moreThan6: "6+ лет",
};

export function fmtFormats(formats) {
  const list = flattenWorkFormats(formats);
  if (!list.length) return "";
  return list.map((f) => FORMAT_LABEL[f] || f).join(" / ");
}

export function mdEscape(s) {
  return String(s).replace(/\|/g, "\\|").replace(/\n/g, " ");
}
