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

function show(source, list) {
  log(`${source}: ${list.length} vacancies`);
  for (const v of list.slice(0, 10)) {
    console.log(
      `  - [${v.entry ? "entry" : "     "}] ${v.name} | ${v.company} | ${v.url}`
    );
  }
}

if (want("telegram")) {
  const list = await collectTelegram(cfg, cfg.queries);
  show("telegram", list);
}

if (want("linkedin")) {
  const list = await collectLinkedIn(cfg, cfg.queries);
  show("linkedin", list);
}
