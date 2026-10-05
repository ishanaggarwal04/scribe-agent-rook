import { createHash, randomBytes } from "node:crypto";
import { access, appendFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const ENV = {
  token: process.env.SCRIBE_API_TOKEN,
  stateDir: process.env.ROOK_STATE_DIR,
  conversation: process.env.ROOK_CONVERSATION,
};

// docs/invoking.md calls 120 s "stuck", but GLM turns were observed at 112 s, and
// two scenarios were cut off at 120 s before the agent answered. The execute hook's
// own 600 s budget still bounds a whole multi-turn scenario.
const COMMAND_TIMEOUT_MS = 240_000;

async function isWorkspaceRoot(path) {
  try {
    await access(join(path, "incident_scribe", "__main__.py"));
    await access(join(path, "services", "ops-directory.mjs"));
    return true;
  } catch {
    return false;
  }
}

async function findWorkspaceRoot() {
  const starts = [process.cwd(), dirname(fileURLToPath(import.meta.url))];
  for (const start of starts) {
    let current = start;
    while (true) {
      if (await isWorkspaceRoot(current)) return current;
      const parent = dirname(current);
      if (parent === current || current === parse(current).root) break;
      current = parent;
    }
  }
  throw new Error("workspace root not found (expected incident_scribe/ and services/)");
}

function runProcess(command, args, { cwd, input = "", timeoutMs = 10_000, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
    // A command that never reads stdin (`--version`, `open`) can exit before the
    // write lands. On Linux that is EPIPE on child.stdin, which, unhandled, killed
    // this script before the agent ran. The exit code and output still decide.
    child.stdin.on("error", (error) => {
      if (error?.code !== "EPIPE") process.stderr.write(`stdin to ${command}: ${error.message}\n`);
    });
    if (input) child.stdin.end(input);
    else child.stdin.end();
  });
}

async function selectPython(cwd) {
  const candidates = process.platform === "win32" ? ["python", "python3"] : ["python3", "python"];
  for (const command of candidates) {
    try {
      const result = await runProcess(command, ["--version"], { cwd });
      const versionText = `${result.stdout}\n${result.stderr}`;
      const match = /Python\s+(\d+)\.(\d+)/i.exec(versionText);
      if (result.code === 0 && match && (Number(match[1]) > 3 || (Number(match[1]) === 3 && Number(match[2]) >= 9))) {
        return command;
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  throw new Error("no working Python 3.9+ interpreter found (tried python3 and python)");
}

// One short root per scenario, inside the workspace (.scribe-sessions/ is gitignored)
// so rook's judge can list and read the desk's real session folder with its own
// workspace tools. ROOK_STATE_DIR is stable across a scenario's open/execute/collect,
// but it is too deep under the run folder for Windows paths, so it only keys the folder.
async function scenarioRoot() {
  // profile test does not set ROOK_STATE_DIR.
  const stateKey = createHash("sha256").update(ENV.stateDir || "rook-scribe-default").digest("hex").slice(0, 16);
  const root = join(await findWorkspaceRoot(), ".scribe-sessions", "rook", stateKey);
  await mkdir(join(root, "sessions"), { recursive: true });
  return root;
}

// Read the desk's artifacts folder straight from disk. The desk creates it empty on
// open and writes every artifact into it (Session.write_artifact), so an empty or
// missing folder means it has written no artifact in this session.
async function listArtifacts(root, conversation) {
  const artifactsDir = resolve(root, "sessions", conversation, "artifacts");
  let files = [];
  try {
    files = (await readdir(artifactsDir)).map((name) => resolve(artifactsDir, name));
  } catch {
    // Not created: nothing written.
  }
  return { artifactsDir, files };
}

async function isolatedEnvironment() {
  if (!ENV.token) throw new Error("SCRIBE_API_TOKEN is not set");
  const root = await scenarioRoot();
  return {
    ...process.env,
    SCRIBE_STATE_DIR: join(root, "sessions"),
    OPS_LEARNED_FILE: join(root, "learned.json"),
  };
}

function lastDiagnostic(result) {
  return result.stderr.trim().split(/\r?\n/).filter(Boolean).at(-1) || "";
}

function parseReply(result, commandName) {
  if (result.timedOut) throw new Error(`${commandName} exceeded ${COMMAND_TIMEOUT_MS / 1000} seconds and was stopped`);
  const output = result.stdout.trim();
  let body;
  try {
    body = JSON.parse(output);
  } catch {
    const detail = lastDiagnostic(result) || (output ? output.slice(0, 300) : "empty stdout");
    throw new Error(`${commandName} ${result.code === 0 ? "returned invalid JSON" : `exited ${result.code}`}: ${detail}`);
  }
  if (result.code !== 0) {
    const detail = body.message || body.error || lastDiagnostic(result) || `exit ${result.code}`;
    throw new Error(`${commandName} failed: ${detail}`);
  }
  if (!body || body.ok !== true) {
    throw new Error(`${commandName} failed: ${body?.message || body?.error || "unknown error"}`);
  }
  return body;
}

async function invoke(commandName, sessionId, input = "") {
  const cwd = await findWorkspaceRoot();
  const python = await selectPython(cwd);
  const env = await isolatedEnvironment();
  const result = await runProcess(
    python,
    ["-m", "incident_scribe", commandName, "--token", ENV.token, "--session-id", sessionId],
    { cwd, input, timeoutMs: COMMAND_TIMEOUT_MS, env },
  );
  return parseReply(result, commandName);
}

async function readStdin() {
  process.stdin.setEncoding("utf8");
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

async function open() {
  const conversation = `RK-${randomBytes(8).toString("hex")}`;
  const body = await invoke("open", conversation);
  if (body.session_id !== conversation) throw new Error("open returned an unexpected session id");
  await writeFile(join(await scenarioRoot(), "session.txt"), conversation);
  return { conversation };
}

async function execute() {
  const goal = await readStdin();
  const conversation = ENV.conversation;
  if (!conversation) throw new Error("ROOK_CONVERSATION is not set; run open before execute");
  const body = await invoke("execute", conversation, goal);
  const root = await scenarioRoot();
  // Every turn's full reply, for collect to hand the judge.
  await appendFile(join(root, "turns.jsonl"), `${JSON.stringify(body)}\n`);
  const onDisk = await listArtifacts(root, conversation);

  let agentReply;
  if (body.status === "completed") agentReply = body.answer;
  else if (body.status === "needs_input") agentReply = body.answer || body.assessment || body.question || body.message;
  else if (body.ok === false) agentReply = body.error || body.message;
  else throw new Error(`execute returned unsupported status: ${body.status ?? "missing"}`);
  if (typeof agentReply !== "string" || !agentReply) {
    throw new Error(`execute did not return a usable reply for status ${body.status}`);
  }

  return {
    agent_reply: agentReply,
    conversation,
    calls: Array.isArray(body.calls) ? body.calls.map(({ name, arguments: args }) => ({ name, ...(args === undefined ? {} : { arguments: args }) })) : [],
    ...(body.usage && Number.isFinite(body.usage.input) && Number.isFinite(body.usage.output)
      ? { usage: { input: body.usage.input, output: body.usage.output } }
      : {}),
    // Not the agent's claim: the profile read this folder from disk itself after the turn.
    observed_on_disk_by_profile: {
      what:
        "After this turn the rook profile listed the desk's session artifacts folder directly " +
        "from disk. The desk writes every artifact (customer note, incident record) into this " +
        "folder and nowhere else, so this is the complete set it has written in this session. " +
        "The folder is inside the workspace and can be listed again with list_files.",
      artifacts_folder: onDisk.artifactsDir,
      artifact_files_on_disk: onDisk.files,
      artifact_count_on_disk: onDisk.files.length,
    },
    evidence: body,
  };
}

async function readJsonLines(path) {
  try {
    return (await readFile(path, "utf8")).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

function parseMaybeJson(text) {
  if (typeof text !== "string") return text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// Pair each tool call in the agent's transcript with the result it got back.
// Handles both transcript shapes the provider adapters write: Anthropic-style
// `tool_use` blocks and Responses-style `function_call` items, answered by
// `function_call_output` items with the same id.
function toolExchanges(transcript) {
  if (!Array.isArray(transcript)) return [];
  const requested = [];
  const results = new Map();
  for (const item of transcript) {
    if (item?.type === "function_call") {
      requested.push({ id: item.call_id ?? item.id, name: item.name, arguments: parseMaybeJson(item.arguments) });
    } else if (item?.type === "function_call_output") {
      results.set(item.call_id, parseMaybeJson(item.output));
    }
    for (const block of Array.isArray(item?.content) ? item.content : []) {
      if (block?.type === "tool_use") requested.push({ id: block.id, name: block.name, arguments: block.input });
      else if (block?.type === "tool_result") results.set(block.tool_use_id, parseMaybeJson(block.content));
    }
  }
  return requested.map(({ id, name, arguments: args }) => ({
    name,
    arguments: args,
    result: results.has(id) ? results.get(id) : "(no result recorded in the transcript)",
  }));
}

// After the conversation: gather what the desk actually did and wrote, as files
// rook copies into the scenario's artifacts and the judge can open.
async function collect() {
  const root = await scenarioRoot();
  let conversation = ENV.conversation;
  if (!conversation) {
    try {
      conversation = (await readFile(join(root, "session.txt"), "utf8")).trim();
    } catch {
      throw new Error("no conversation to collect: ROOK_CONVERSATION is unset and open recorded none");
    }
  }
  const sessionDir = join(root, "sessions", conversation);
  const { artifactsDir, files: written } = await listArtifacts(root, conversation);
  const log = await readJsonLines(join(sessionDir, "session.jsonl"));
  const turns = await readJsonLines(join(root, "turns.jsonl"));
  const exchanges = toolExchanges(await readJson(join(sessionDir, "conversation.json")));

  const evidence = {
    what_this_is:
      "Collected by the rook profile after the conversation, from the desk's own session folder " +
      "(the folder its SCRIBE_STATE_DIR points at). The artifacts folder was read from disk in " +
      "full, so artifacts_written is the complete list of artifacts the desk wrote in this session.",
    session_id: conversation,
    session_folder: resolve(sessionDir),
    artifacts_folder: artifactsDir,
    artifacts_written: written,
    artifact_count: written.length,
    execute_replies: turns,
    tool_calls_with_results: exchanges,
    session_log: log,
  };
  const evidenceFile = resolve(root, `evidence-${conversation}.json`);
  await writeFile(evidenceFile, JSON.stringify(evidence, null, 2));

  const lastTurn = turns.at(-1) ?? {};
  const images = [lastTurn.status_board_image, lastTurn.severity_matrix_image].filter(
    (url) => typeof url === "string" && /^https?:\/\//.test(url),
  );
  return {
    conversation,
    evidence_file: evidenceFile,
    artifacts_written: written,
    images,
    calls: log
      .filter((entry) => entry.event === "tool_call" || entry.event === "subagent_start")
      .map((entry) =>
        entry.event === "tool_call"
          ? { name: entry.tool, ...(entry.arguments ? { arguments: entry.arguments } : {}) }
          : { name: "comms_writer_subagent", arguments: { role: entry.role } },
      ),
  };
}

const PHASES = { open, execute, collect };

try {
  const fn = PHASES[process.argv[2]];
  if (!fn) throw new Error(`unknown phase: ${process.argv[2]}`);
  const result = await fn();
  if (result) console.log(JSON.stringify(result));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
