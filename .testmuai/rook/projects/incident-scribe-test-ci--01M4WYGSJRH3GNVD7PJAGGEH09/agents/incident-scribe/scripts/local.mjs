import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

const ENV = {
  token: process.env.SCRIBE_API_TOKEN,
  workspace: process.env.ROOK_WORKSPACE,
  conversation: process.env.ROOK_CONVERSATION,
};

function requireToken() {
  if (!ENV.token) throw new Error("SCRIBE_API_TOKEN is not set");
}

function sessionId() {
  if (!ENV.conversation) throw new Error("ROOK_CONVERSATION is not set; run the open phase first");
  return ENV.conversation;
}

async function runDesk(command, session, input) {
  requireToken();
  const args = [
    "-m",
    "incident_scribe",
    command,
    "--token",
    ENV.token,
    "--session-id",
    session,
  ];

  const result = await new Promise((resolve, reject) => {
    const child = spawn("python3", args, {
      cwd: ENV.workspace || process.cwd(),
      env: { ...process.env, SCRIBE_API_TOKEN: ENV.token },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });

  let body;
  try {
    body = JSON.parse(result.stdout.trim());
  } catch {
    const detail = result.stderr.trim() || result.stdout.trim() || "no output";
    throw new Error(`incident-scribe ${command} returned invalid JSON: ${detail.slice(0, 300)}`);
  }

  if (result.code !== 0 || body.ok !== true) {
    const detail = body.message || body.error || result.stderr.trim() || `exited ${result.code}`;
    throw new Error(`incident-scribe ${command} failed: ${detail}`);
  }
  return body;
}

async function readGoal() {
  let text = "";
  process.stdin.setEncoding("utf-8");
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

async function open() {
  const conversation = `rook-${randomUUID()}`;
  const body = await runDesk("open", conversation);
  return { conversation: body.session_id };
}

async function execute() {
  const goal = await readGoal();
  const body = await runDesk("execute", sessionId(), goal);
  return {
    agent_reply: body.answer,
    conversation: sessionId(),
    calls: body.calls,
    usage: body.usage,
  };
}

async function close() {
  await runDesk("close", sessionId());
  return {};
}

async function collect() {
  const body = await runDesk("logs", sessionId());
  const calls = body.entries.flatMap((entry) => {
    if (entry.event === "tool_call" && entry.tool) {
      return [{ name: entry.tool, arguments: entry.arguments ?? {} }];
    }
    if (entry.event === "subagent_start" && entry.role) {
      return [{ name: "comms_writer_subagent", arguments: { role: entry.role } }];
    }
    return [];
  });
  return {
    calls,
    entries: body.entries,
    artifacts: body.artifacts,
    log_file: body.log_file,
  };
}

const PHASES = { open, execute, close, collect };
const fn = PHASES[process.argv[2]];
if (!fn) throw new Error(`unknown phase: ${process.argv[2]}`);
const result = await fn();
if (result) console.log(JSON.stringify(result));
