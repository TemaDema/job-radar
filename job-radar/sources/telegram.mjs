import {
  BASE_HEADERS,
  sleep,
  log,
  stripHtml,
  isItTitle,
} from "../lib.mjs";
import { matchQuery, pickTitle, buildExternalRecord, isNonJobTitle } from "./common.mjs";

/* ------------------------------------------------------------------ */
/* Telegram public channels (https://t.me/s/<channel>)                 */
/* No auth needed: we read the public web preview of a channel.        */
/* ------------------------------------------------------------------ */

const TG_HEADERS = {
  ...BASE_HEADERS,
  Referer: "https://t.me/",
};

async function fetchChannelHtml(channel) {
  const res = await fetch(`https://t.me/s/${encodeURIComponent(channel)}`, {
    headers: TG_HEADERS,
    signal: AbortSignal.timeout(30000),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

export function parseTelegramHtml(html) {
  const posts = [];
  // Every message carries data-post="channel/123". Splitting on it gives
  // us self-contained chunks so a post without text cannot swallow the next.
  const chunks = String(html || "").split(/data-post="/).slice(1);
  for (const chunk of chunks) {
    const idEnd = chunk.indexOf('"');
    if (idEnd < 0) continue;
    const dataPost = chunk.slice(0, idEnd);
    const [channel, messageId] = dataPost.split("/");
    if (!channel || !messageId) continue;

    const rest = chunk.slice(idEnd);
    const textM = rest.match(
      /<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/
    );
    if (!textM) continue;
    const text = stripHtml(textM[1]).trim();
    if (!text) continue;

    const timeM = rest.match(/<time[^>]*datetime="([^"]+)"/);
    posts.push({
      channel,
      messageId,
      text,
      publishedAt: timeM ? timeM[1] : null,
    });
  }

  const seen = new Set();
  return posts.filter((p) => {
    const key = `${p.channel}/${p.messageId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function collectTelegram(cfg, queries) {
  const tc = cfg.telegram || {};
  const channels = tc.channels || [];
  if (!channels.length) return [];

  const maxPosts = tc.maxPostsPerChannel ?? 40;
  const delay = tc.delayMs ?? 2000;
  const maxPerRun = tc.maxPerRun ?? 150;

  const out = [];
  for (const channel of channels) {
    try {
      const html = await fetchChannelHtml(channel);
      if (!html) {
        log(`telegram @${channel}: channel not found (404)`);
        continue;
      }
      const posts = parseTelegramHtml(html).slice(-maxPosts);
      let kept = 0;
      for (const p of posts) {
        const name = pickTitle(p.text);
        if (!name) continue;
        if (isNonJobTitle(name)) continue;
        // The headline must name an IT role, and the post must read like a vacancy.
        if (!isItTitle(name)) continue;
        const looksLikeJob =
          /(ваканси|ищем|ищет|ищу|требует|набираем|в поиске|открыт[аы]? (?:позици|ваканси|роль|набор)|hiring|vacancy|job opening|apply|зарплат|вилк|резюме|собеседован|обязанности|требования|опыт работы|стажировк|набор на)/i.test(
            p.text
          );
        if (!looksLikeJob) continue;

        const m = matchQuery(name, queries);
        out.push(
          buildExternalRecord({
            source: "telegram",
            id: `tg:${p.channel}:${p.messageId}`,
            name,
            company: `@${p.channel}`,
            area: "Telegram",
            url: `https://t.me/${p.channel}/${p.messageId}`,
            publishedAt: p.publishedAt,
            text: p.text,
            track: m?.track || "Telegram / чаты",
            queryId: m?.id || null,
          })
        );
        kept++;
        if (out.length >= maxPerRun) {
          log(`telegram: reached maxPerRun=${maxPerRun}`);
          return out;
        }
      }
      log(`telegram @${channel}: posts=${posts.length} kept=${kept}`);
    } catch (e) {
      log(`telegram @${channel}: ERROR ${e.message}`);
    }
    await sleep(delay);
  }
  return out;
}
