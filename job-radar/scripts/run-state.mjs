import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { ROOT } from "../lib.mjs";

/* ------------------------------------------------------------------ */
/* Shared run journal: prevents local and cloud runs from duplicating  */
/* ------------------------------------------------------------------ */

export const REPO_ROOT = path.dirname(ROOT);

export const runEnv = () =>
  process.env.GITHUB_ACTIONS === "true" ? "ci" : "local";

const rel = (p) => path.relative(REPO_ROOT, p).split(path.sep).join("/");

export function runsFile(date) {
  return path.join(ROOT, "data", "runs", `${date}.json`);
}

export function readRunState(date) {
  const p = runsFile(date);
  if (!fs.existsSync(p)) return { date, runs: [] };
  try {
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    return { date, runs: Array.isArray(j.runs) ? j.runs : [] };
  } catch {
    return { date, runs: [] };
  }
}

export function writeRunState(state) {
  const p = runsFile(state.date);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(state, null, 2), "utf8");
}

export function mergeStates(...states) {
  const map = new Map();
  for (const st of states) {
    for (const r of st?.runs || []) {
      if (!r || !r.env) continue;
      const prev = map.get(r.env);
      if (!prev || String(r.at || "") > String(prev.at || "")) map.set(r.env, r);
    }
  }
  const date = states.find((s) => s?.date)?.date;
  return { date, runs: [...map.values()] };
}

export function readRemoteRunState(date) {
  if (runEnv() === "ci") return null;
  try {
    execFileSync("git", ["fetch", "origin", "main", "--quiet"], {
      cwd: REPO_ROOT,
      timeout: 20000,
      stdio: "pipe",
    });
    const out = execFileSync(
      "git",
      ["show", `origin/main:${rel(runsFile(date))}`],
      { cwd: REPO_ROOT, timeout: 10000, stdio: "pipe" }
    );
    return JSON.parse(out.toString("utf8"));
  } catch {
    return null;
  }
}

export function completedSources(state) {
  const set = new Set();
  for (const r of state?.runs || []) {
    for (const s of r.sourcesOk || []) set.add(s);
  }
  return set;
}

export function appendRun(state, entry) {
  const runs = (state.runs || []).filter((r) => r.env !== entry.env);
  runs.push(entry);
  return { date: state.date, runs };
}

export function pullLatest() {
  if (runEnv() === "ci") return false;
  try {
    execFileSync(
      "git",
      ["-c", "rebase.autoStash=true", "pull", "--rebase", "origin", "main"],
      { cwd: REPO_ROOT, timeout: 60000, stdio: "pipe" }
    );
    return true;
  } catch {
    return false;
  }
}

export function publishLocal(date, message) {
  if (runEnv() === "ci") return { published: false, reason: "ci" };
  if (process.env.JOB_RADAR_AUTO_PUSH === "0") {
    return { published: false, reason: "disabled" };
  }
  try {
    execFileSync("git", ["remote", "get-url", "origin"], {
      cwd: REPO_ROOT,
      timeout: 10000,
      stdio: "pipe",
    });
  } catch {
    return { published: false, reason: "no-remote" };
  }

  const paths = [rel(path.join(ROOT, "data")), rel(path.join(ROOT, "reports"))];
  try {
    execFileSync("git", ["add", ...paths], {
      cwd: REPO_ROOT,
      timeout: 30000,
      stdio: "pipe",
    });

    let hasChanges = true;
    try {
      execFileSync("git", ["diff", "--cached", "--quiet", "--", ...paths], {
        cwd: REPO_ROOT,
        stdio: "pipe",
      });
      hasChanges = false;
    } catch {
      hasChanges = true;
    }
    if (!hasChanges) return { published: false, reason: "no-changes" };

    execFileSync(
      "git",
      ["commit", "-m", message || `job-radar(local): ${date}`, "--", ...paths],
      { cwd: REPO_ROOT, timeout: 30000, stdio: "pipe" }
    );

    try {
      execFileSync(
        "git",
        ["-c", "rebase.autoStash=true", "pull", "--rebase", "origin", "main"],
        { cwd: REPO_ROOT, timeout: 60000, stdio: "pipe" }
      );
    } catch {
      // remote may be behind/unavailable; push will report the real problem
    }

    execFileSync("git", ["push", "origin", "main"], {
      cwd: REPO_ROOT,
      timeout: 60000,
      stdio: "pipe",
    });
    return { published: true };
  } catch (e) {
    return { published: false, reason: e.message };
  }
}
