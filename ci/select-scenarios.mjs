#!/usr/bin/env node
// Picks which gated Rook scenarios a change can affect.
//
//   node ci/select-scenarios.mjs --base <sha> --head <sha>
//
// Reads the committed Rook suite for ROOK_PROJECT_ID / ROOK_AGENT_ID (each scenario's
// feature_id, each feature's `sources`), adds ci/scenario-map.json, maps the diff to the
// symbols it touches, and narrows the gate list in ROOK_SCENARIO_IDS to the scenarios of the
// features those symbols belong to. Anything changed that nothing maps runs the whole gate
// list: a missing mapping costs credits, never coverage.
//
// Prints the chosen IDs (comma-separated, possibly empty) on stdout; the reasoning goes to
// stderr, and to $GITHUB_OUTPUT (ids, mode) and $GITHUB_STEP_SUMMARY when they are set.

import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, arg, i, all) => {
    if (arg.startsWith("--")) pairs.push([arg.slice(2), all[i + 1]]);
    return pairs;
  }, []),
);
const { base, head } = args;
const pool = (process.env.ROOK_SCENARIO_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const projectId = process.env.ROOK_PROJECT_ID;
const agentId = process.env.ROOK_AGENT_ID;
if (!base || !head) die("usage: select-scenarios.mjs --base <sha> --head <sha>");
if (!pool.length) die("ROOK_SCENARIO_IDS (the gate list) is empty");
if (!projectId || !agentId) die("ROOK_PROJECT_ID and ROOK_AGENT_ID are required");

function die(message) {
  process.stderr.write(`select-scenarios: ${message}\n`);
  process.exit(2);
}

function git(...argv) {
  return execFileSync("git", argv, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function fileAt(sha, path) {
  try {
    return git("show", `${sha}:${path}`);
  } catch {
    return ""; // added or deleted on this side
  }
}

// ── the suite: scenario -> feature, feature -> sources ───────────────────────────────

const projectsDir = ".testmuai/rook/projects";
const projectDir = readdirSync(projectsDir).find((d) => d === projectId || d.endsWith(`--${projectId}`));
if (!projectDir) die(`no committed project folder for ${projectId}`);
const agentDir = join(projectsDir, projectDir, "agents", agentId);
if (!existsSync(agentDir)) die(`no committed agent folder ${agentDir}`);
const agentPrefix = `${agentDir.replaceAll("\\", "/")}/`;

// Rook writes these files; the two fields read here are plain top-level keys and a list.
function yamlScalar(text, key) {
  return text.match(new RegExp(`^${key}:\\s*(.+)$`, "m"))?.[1].trim().replace(/^['"]|['"]$/g, "");
}
function yamlList(text, key) {
  const block = text.match(new RegExp(`^${key}:\\s*\\n((?:\\s+-.*\\n?)*)`, "m"))?.[1] ?? "";
  return [...block.matchAll(/^\s+-\s*(.+)$/gm)].map((m) => m[1].trim().replace(/^['"]|['"]$/g, ""));
}

const featureOf = new Map(); // SC-001 -> F-001
for (const file of readdirSync(join(agentDir, "scenarios")).filter((f) => f.endsWith(".yaml"))) {
  const text = readFileSync(join(agentDir, "scenarios", file), "utf8");
  featureOf.set(yamlScalar(text, "local_id") ?? file.replace(/\.yaml$/, ""), yamlScalar(text, "feature_id"));
}
const sourcesOf = new Map(); // F-001 -> ["incident_scribe/agent.py:run_turn", ...]
for (const file of readdirSync(join(agentDir, "features")).filter((f) => f.endsWith(".yaml"))) {
  const text = readFileSync(join(agentDir, "features", file), "utf8");
  sourcesOf.set(yamlScalar(text, "local_id") ?? file.replace(/\.yaml$/, ""), yamlList(text, "sources"));
}

const map = JSON.parse(readFileSync("ci/scenario-map.json", "utf8"));
for (const [feature, extra] of Object.entries(map.extra_sources ?? {})) {
  if (feature.startsWith("_")) continue;
  sourcesOf.set(feature, [...(sourcesOf.get(feature) ?? []), ...extra]);
}

// ── matching ──────────────────────────────────────────────────────────────────────────

function globToRegExp(glob) {
  const body = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0000/g, ".*");
  return new RegExp(`^${body}$`);
}

// `entry` is "path-glob" or "path-glob:Symbol". A file-level entry matches every symbol in
// the file; Symbol matches itself, its members (OPERATIONS matches OPERATIONS.lookup_service)
// and its container (a change to OPERATIONS as a whole touches each member).
function matches(entry, file, symbol) {
  const at = entry.lastIndexOf(":");
  const hasSymbol = at > 0 && !/^[A-Za-z]:[\\/]/.test(entry);
  const path = hasSymbol ? entry.slice(0, at) : entry;
  if (!globToRegExp(path).test(file)) return false;
  if (!hasSymbol || symbol === null) return true;
  const wanted = entry.slice(at + 1);
  return symbol === wanted || symbol.startsWith(`${wanted}.`) || wanted.startsWith(`${symbol}.`);
}

// ── diff -> (file, symbol) ───────────────────────────────────────────────────────────

const PY_TOP = /^(?:async\s+def|def|class)\s+([A-Za-z_]\w*)|^([A-Za-z_]\w*)\s*(?::[^=]*)?=(?!=)/;
const JS_TOP = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/;
const JS_MEMBER = /^ {2}([A-Za-z_$][\w$]*)\s*:/;

function isTrivial(line, kind) {
  const t = line.trim();
  if (t === "") return true;
  if (kind === "py") return t.startsWith("#");
  if (kind === "js") return t.startsWith("//") || t.startsWith("/*") || t.startsWith("*");
  return false;
}

// The top-level symbol a 1-based line belongs to, or "<module>" for imports and loose code.
function symbolAt(lines, lineNo, kind) {
  for (let i = lineNo - 1; i >= 0; i--) {
    const line = lines[i];
    if (kind === "py") {
      if (/^\s/.test(line) || line.trim() === "") continue;
      if (line.startsWith("@")) {
        // Decorator: it belongs to the def below it.
        for (let j = i + 1; j < lines.length; j++) {
          const m = lines[j].match(PY_TOP);
          if (m) return m[1] ?? m[2];
        }
      }
      const m = line.match(PY_TOP);
      if (m) return m[1] ?? m[2];
      if (/^(import|from)\s/.test(line) || line.startsWith("if __name__")) return "<module>";
      continue;
    }
    // js: the nearest top-level declaration; inside a top-level object, its 2-space key.
    const top = line.match(JS_TOP);
    if (top) {
      for (let k = lineNo - 1; k > i; k--) {
        const member = lines[k].match(JS_MEMBER);
        if (member) return `${top[1]}.${member[1]}`;
      }
      return top[1];
    }
    if (/^import\s/.test(line)) return "<module>";
  }
  return "<module>";
}

function kindOf(file) {
  if (file.endsWith(".py")) return "py";
  if (/\.(mjs|cjs|js|ts)$/.test(file)) return "js";
  return null;
}

const changes = []; // { file, symbol }  symbol === null means "the file as a whole"
const changedFiles = git("diff", "--name-only", "--no-renames", `${base}...${head}`).split("\n").filter(Boolean);
for (const file of changedFiles) {
  const kind = kindOf(file);
  if (!kind) {
    changes.push({ file, symbol: null });
    continue;
  }
  const before = fileAt(base, file).split("\n");
  const after = fileAt(head, file).split("\n");
  const symbols = new Set();
  const diff = git("diff", "--unified=0", "--no-renames", `${base}...${head}`, "--", file);
  for (const hunk of diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
    const [oldStart, oldCount, newStart, newCount] = [hunk[1], hunk[2] ?? "1", hunk[3], hunk[4] ?? "1"].map(Number);
    for (let n = oldStart; n < oldStart + oldCount; n++) {
      if (!isTrivial(before[n - 1] ?? "", kind)) symbols.add(symbolAt(before, n, kind));
    }
    for (let n = newStart; n < newStart + newCount; n++) {
      if (!isTrivial(after[n - 1] ?? "", kind)) symbols.add(symbolAt(after, n, kind));
    }
  }
  for (const symbol of symbols) changes.push({ file, symbol });
  // Only comments/blank lines changed: nothing that can alter behaviour.
}

// ── decide ────────────────────────────────────────────────────────────────────────────

const ignorePaths = map.ignore?.paths ?? [];
const ignoreSymbols = map.ignore?.symbols ?? [];
const fullRun = map.full_run_on?.sources ?? [];
const selected = new Set();
const rows = [];
let full = null;

for (const { file, symbol } of changes) {
  const label = symbol ? `${file}:${symbol}` : file;
  if (ignorePaths.some((g) => globToRegExp(g).test(file)) || (symbol && ignoreSymbols.some((e) => matches(e, file, symbol)))) {
    rows.push([label, "ignored", "not reached by the gated execute turns"]);
    continue;
  }
  // The suite itself: a changed scenario runs itself; a changed feature runs its scenarios.
  if (file.startsWith(agentPrefix)) {
    const scenario = file.match(/\/scenarios\/(SC-[\w-]+)\.yaml$/);
    const feature = file.match(/\/features\/(F-[\w-]+)\.yaml$/);
    if (scenario) {
      selected.add(scenario[1]);
      rows.push([label, scenario[1], "scenario definition changed"]);
      continue;
    }
    if (feature) {
      const ids = [...featureOf].filter(([, f]) => f === feature[1]).map(([id]) => id);
      ids.forEach((id) => selected.add(id));
      rows.push([label, ids.join(", ") || "-", `feature ${feature[1]} changed`]);
      continue;
    }
  } else if (file.startsWith(".testmuai/rook/projects/")) {
    rows.push([label, "ignored", "another project or agent"]);
    continue;
  }
  if (fullRun.some((e) => matches(e, file, symbol))) {
    full ??= `${label} is shared by every turn`;
    rows.push([label, "ALL", "listed in full_run_on"]);
    continue;
  }
  const features = [...sourcesOf].filter(([, sources]) => sources.some((e) => matches(e, file, symbol))).map(([f]) => f);
  if (!features.length) {
    full ??= `${label} is not mapped to any feature`;
    rows.push([label, "ALL", "unmapped: fail-safe"]);
    continue;
  }
  const ids = [...featureOf].filter(([, f]) => features.includes(f)).map(([id]) => id);
  ids.forEach((id) => selected.add(id));
  rows.push([label, ids.join(", ") || "-", `features ${features.join(", ")}`]);
}

const ids = full ? pool : pool.filter((id) => selected.has(id));
const mode = full ? "all" : ids.length ? "affected" : "none";
const why =
  mode === "all" ? `whole gate list: ${full}`
  : mode === "affected" ? `${ids.length} of ${pool.length} gated scenarios cover what changed`
  : "no gated scenario covers what changed";

process.stderr.write(`changes (${base.slice(0, 7)}...${head.slice(0, 7)}):\n`);
for (const [what, runs, reason] of rows) process.stderr.write(`  ${what}  ->  ${runs}  (${reason})\n`);
if (!rows.length) process.stderr.write("  (nothing that can change behaviour)\n");
process.stderr.write(`gate list: ${pool.join(",")}\nselected:  ${ids.join(",") || "(none)"}  [${mode}: ${why}]\n`);
process.stdout.write(`${ids.join(",")}\n`);

if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `ids=${ids.join(",")}\nmode=${mode}\n`);
}
if (process.env.GITHUB_STEP_SUMMARY) {
  const table = rows.map(([what, runs, reason]) => `| \`${what}\` | ${runs} | ${reason} |`).join("\n");
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `### Rook scenario selection: ${mode}\n\n${why}.\n\n` +
      `**Gate list:** \`${pool.join(",")}\`  \n**Running:** \`${ids.join(",") || "nothing"}\`\n\n` +
      (rows.length ? `| Changed | Scenarios | Why |\n|---|---|---|\n${table}\n` : "_Nothing that can change behaviour._\n"),
  );
}
