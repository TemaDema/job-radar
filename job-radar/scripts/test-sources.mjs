import { loadConfig, log } from "../lib.mjs";
import { collectTelegram } from "../sources/telegram.mjs";
import { collectLinkedIn } from "../sources/linkedin.mjs";

/* Quick check of external sources without writing to the store.
   Usage:
     node scripts/test-sources.mjs            # both
     node scripts/test-sources.mjs telegram
     node scripts/test-sources.mjs linkedin
*/

const cfg = loadConfig();
const args = process.argv.slice(2);
const want = (s) => !args.length || args.includes(s);

function show(source, list, ok) {
  log(`${source}: ${list.length} vacancies${ok === false ? " (source failed)" : ""}`);
  for (const v of list.slice(0, 10)) {
    console.log(
      `  - [${v.entry ? "entry" : "     "}] ${v.name} | ${v.company} | ${v.url}`
    );
  }
}

if (want("telegram")) {
  const { items, ok } = await collectTelegram(cfg, cfg.queries);
  show("telegram", items, ok);
}

if (want("linkedin")) {
  const { items, ok } = await collectLinkedIn(cfg, cfg.queries);
  show("linkedin", items, ok);
}
