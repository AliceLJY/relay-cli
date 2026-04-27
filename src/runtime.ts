import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DuoProcess, DuoState, RuntimeHealth, RuntimeInfo, RuntimeName } from "./types.js";
import {
  appendEvent,
  assertNotBraked,
  duoDir,
  maybeDowngradeBrake,
  recordFailure,
  resolveIdleTimeoutMs,
  setBrake
} from "./state.js";

export function resolveParentId(
  state: DuoState,
  options: { explicit?: string; envFallback?: boolean } = {}
): string | undefined {
  const envParent = options.envFallback ? process.env.DUO_PROCESS_ID : undefined;
  const candidate = options.explicit || envParent || undefined;
  if (!candidate) {
    return undefined;
  }
  if (state.processes[candidate]) {
    return candidate;
  }
  const source = options.explicit ? "--parent" : "DUO_PROCESS_ID";
  process.stderr.write(
    `[duo] ${source}=${candidate} is set but not found in state; spawning as orphan.\n`
  );
  return undefined;
}
import { nowIso, shortId } from "./ids.js";

const RUNTIME_COMMANDS: Record<RuntimeName, { env: string; command: string }> = {
  codex: { env: "DUO_CODEX_CMD", command: "codex" },
  claude: { env: "DUO_CLAUDE_CMD", command: "claude" }
};
const INPUT_EVENT_PREVIEW_LIMIT = 120;

export interface SpawnAgentInput {
  runtime: RuntimeName;
  name?: string;
  prompt?: string;
  parentId?: string;
  cwd?: string;
  bypassSandbox?: boolean;
}

export function listRuntimes(options: { checkAuth?: boolean } = {}): RuntimeInfo[] {
  return (Object.keys(RUNTIME_COMMANDS) as RuntimeName[]).map((name) => {
    const configured = process.env[RUNTIME_COMMANDS[name].env] || RUNTIME_COMMANDS[name].command;
    const [command, ...args] = configured.split(" ").filter(Boolean);
    const resolvedPath = resolveCommand(command);
    const info: RuntimeInfo = {
      name,
      command: resolvedPath || command,
      args,
      available: Boolean(resolvedPath),
      configuredCommand: configured,
      resolvedPath
    };
    if (options.checkAuth) {
      info.health = checkRuntimeHealth(info);
    }
    return info;
  });
}

export function spawnAgent(state: DuoState, input: SpawnAgentInput): { state: DuoState; process: DuoProcess } {
  assertNotBraked(state);
  const runtime = listRuntimes().find((candidate) => candidate.name === input.runtime);
  if (!runtime) {
    throw new Error(`unknown runtime: ${input.runtime}`);
  }
  if (!runtime.available) {
    throw new Error(`runtime not available: ${input.runtime} (${runtime.command})`);
  }

  const parent = input.parentId ? state.processes[input.parentId] : undefined;
  const depth = parent ? parent.depth + 1 : 1;
  if (depth > state.limits.maxDepth) {
    throw new Error(`spawn depth limit exceeded: ${depth} > ${state.limits.maxDepth}`);
  }

  const id = shortId("proc");
  const tmuxSession = `duo_${input.runtime}_${randomBytes(3).toString("hex")}`;
  const cwd = input.cwd || state.projectRoot;
  const initialPrompt = input.prompt ? buildAgentIntro({ id, runtime: input.runtime, depth }, input.prompt) : undefined;
  // bypassSandbox: only meaningful for codex; routes through `codex exec
  // --dangerously-bypass-approvals-and-sandbox` so the spawned codex can
  // write files and run shell commands without per-action approval. This is
  // a deliberate trust-the-prompt mode — only use it when you wrote the
  // prompt yourself or you're driving codex from another agent you trust.
  const bypassArgs =
    input.bypassSandbox && input.runtime === "codex"
      ? ["exec", "--dangerously-bypass-approvals-and-sandbox"]
      : [];
  const shellCommand = shellJoin([
    runtime.command,
    ...runtime.args,
    ...bypassArgs,
    ...(initialPrompt ? [initialPrompt] : [])
  ]);
  const started = spawnSync(
    "tmux",
    [
      "new-session",
      "-d",
      "-s",
      tmuxSession,
      "-c",
      cwd,
      "-e",
      `DUO_PROCESS_ID=${id}`,
      "-e",
      `DUO_RUNTIME=${input.runtime}`,
      "-e",
      `DUO_DEPTH=${depth}`,
      "-e",
      `DUO_DIR=${duoDir(state.projectRoot)}`,
      shellCommand
    ],
    {
      encoding: "utf8"
    }
  );

  if (started.status !== 0) {
    throw new Error(`tmux failed to start ${input.runtime}: ${started.stderr || started.stdout}`);
  }

  const now = nowIso();
  const processRecord: DuoProcess = {
    id,
    runtime: input.runtime,
    name: input.name || `${input.runtime} ${id}`,
    status: "running",
    parentId: input.parentId,
    depth,
    tmuxSession,
    cwd,
    prompt: input.prompt,
    createdAt: now,
    updatedAt: now,
    failureCount: 0
  };

  const nextState = appendEvent(
    {
      ...state,
      processes: {
        ...state.processes,
        [id]: processRecord
      }
    },
    "spawn_agent",
    `spawned ${input.runtime} as ${processRecord.name}`,
    id
  );

  return { state: nextState, process: nextState.processes[id] };
}

export function sendInput(state: DuoState, processId: string, input: string): DuoState {
  assertNotBraked(state);
  const processRecord = state.processes[processId];
  if (!processRecord) {
    throw new Error(`unknown process: ${processId}`);
  }
  if (processRecord.status !== "running" && processRecord.status !== "blocked") {
    throw new Error(`process is not input-ready: ${processRecord.status}`);
  }

  sendInputToTmux(processRecord.tmuxSession, input, processRecord.runtime);
  const updated = {
    ...processRecord,
    status: "running" as const,
    updatedAt: nowIso()
  };
  return appendEvent(
    {
      ...state,
      processes: {
        ...state.processes,
        [processId]: updated
      }
    },
    "send_input",
    `sent input: ${previewInputForEvent(input)}`,
    processId
  );
}

export function getOutput(state: DuoState, processId: string, lines = 80): { state: DuoState; output: string } {
  const processRecord = state.processes[processId];
  if (!processRecord) {
    throw new Error(`unknown process: ${processId}`);
  }

  const captured = spawnSync("tmux", ["capture-pane", "-t", processRecord.tmuxSession, "-p", "-S", `-${lines}`], {
    encoding: "utf8"
  });

  if (captured.status !== 0) {
    const next = markProcess(state, processId, "failed");
    throw new Error(`tmux capture failed: ${captured.stderr || captured.stdout}`);
  }

  const updated = {
    ...processRecord,
    lastOutputAt: nowIso(),
    updatedAt: nowIso()
  };
  const nextState = {
    ...state,
    processes: {
      ...state.processes,
      [processId]: updated
    }
  };
  return { state: nextState, output: captured.stdout };
}

export function cancelAgent(state: DuoState, processId: string): DuoState {
  const processRecord = state.processes[processId];
  if (!processRecord) {
    throw new Error(`unknown process: ${processId}`);
  }
  const result = spawnSync("tmux", ["send-keys", "-t", processRecord.tmuxSession, "C-c"], {
    encoding: "utf8"
  });
  let next = state;
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "unknown tmux error").trim();
    process.stderr.write(
      `[duo] tmux cancel send-keys failed for ${processRecord.tmuxSession}: ${detail}\n`
    );
    next = appendEvent(
      next,
      "tmux_cancel_failed",
      `tmux send-keys C-c failed for ${processRecord.tmuxSession}: ${detail}`,
      processId
    );
  }
  return markProcess(next, processId, "cancelled");
}

export function closeProcess(state: DuoState, processId: string): DuoState {
  const processRecord = state.processes[processId];
  if (!processRecord) {
    throw new Error(`unknown process: ${processId}`);
  }
  const result = spawnSync("tmux", ["kill-session", "-t", processRecord.tmuxSession], {
    encoding: "utf8"
  });
  let next = state;
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "unknown tmux error").trim();
    process.stderr.write(
      `[duo] tmux kill-session failed for ${processRecord.tmuxSession}: ${detail}\n`
    );
    next = appendEvent(
      next,
      "tmux_close_failed",
      `tmux kill-session failed for ${processRecord.tmuxSession}: ${detail}`,
      processId
    );
  }
  return markProcess(next, processId, "closed");
}

export function closeAllProcesses(state: DuoState, status: DuoProcess["status"] = "aborted"): DuoState {
  let next = state;
  for (const processId of Object.keys(next.processes)) {
    const processRecord = next.processes[processId];
    if (processRecord.status === "running" || processRecord.status === "blocked") {
      spawnSync("tmux", ["kill-session", "-t", processRecord.tmuxSession], { encoding: "utf8" });
      next = markProcess(next, processId, status);
    }
  }
  return next;
}

export function applyRuntimeLimits(state: DuoState): DuoState {
  let next = maybeDowngradeBrake(state);
  const now = Date.now();
  const idleTimeoutMs = resolveIdleTimeoutMs(next);
  const hasPendingHumanRequest = Object.values(next.humanRequests).some(
    (request) => request.status === "pending"
  );
  const activeChildrenByParent = new Map<string, number>();
  const latestChildObservationByParent = new Map<string, number>();
  for (const processRecord of Object.values(next.processes)) {
    if (!processRecord.parentId) {
      continue;
    }
    const childObservedAt = observedTimestamp(processRecord);
    const childIsActive = processRecord.status === "running" || processRecord.status === "blocked";
    const childIsRecent = Number.isFinite(childObservedAt) && now - childObservedAt <= idleTimeoutMs;
    if (childIsActive || childIsRecent) {
      const visitedParents = new Set<string>();
      for (
        let parentId: string | undefined = processRecord.parentId;
        parentId && !visitedParents.has(parentId);
        parentId = next.processes[parentId]?.parentId
      ) {
        visitedParents.add(parentId);
        latestChildObservationByParent.set(
          parentId,
          Math.max(latestChildObservationByParent.get(parentId) || 0, childObservedAt)
        );
      }
    }
    if (!childIsActive) {
      continue;
    }
    activeChildrenByParent.set(
      processRecord.parentId,
      (activeChildrenByParent.get(processRecord.parentId) || 0) + 1
    );
  }
  for (const processRecord of Object.values(next.processes)) {
    if (processRecord.status !== "running") {
      continue;
    }
    const observedAt = Math.max(
      observedTimestamp(processRecord),
      latestChildObservationByParent.get(processRecord.id) || 0
    );
    if (now - observedAt <= idleTimeoutMs) {
      continue;
    }
    if ((activeChildrenByParent.get(processRecord.id) || 0) > 0) {
      continue;
    }
    if (hasPendingHumanRequest) {
      continue;
    }
    const blocked = markProcess(next, processRecord.id, "blocked");
    return setBrake(blocked, `process timeout: ${processRecord.name}`, "system");
  }
  return next;
}

export function safeToolCall<T>(state: DuoState, fn: () => T): { state: DuoState; result?: T; error?: Error } {
  try {
    return { state, result: fn() };
  } catch (error) {
    const next = recordFailure(state, (error as Error).message);
    return { state: next, error: error as Error };
  }
}

export function stabilizeProcess(processRecord: DuoProcess, waitMs = 1000): void {
  if (processRecord.runtime === "codex") {
    autoAdvanceCodexTrust(processRecord.tmuxSession);
  }
  if (waitMs > 0) {
    wait(waitMs);
  }
}

function markProcess(state: DuoState, processId: string, status: DuoProcess["status"]): DuoState {
  const processRecord = state.processes[processId];
  if (!processRecord) {
    return state;
  }
  return appendEvent(
    {
      ...state,
      processes: {
        ...state.processes,
        [processId]: {
          ...processRecord,
          status,
          updatedAt: nowIso()
        }
      }
    },
    status,
    `process ${status}`,
    processId
  );
}

export function resolveCommand(command: string, fallbackDirs = defaultFallbackDirs()): string | undefined {
  if (command.includes("/")) {
    return isExecutable(command) ? command : undefined;
  }

  const result = spawnSync("which", [command], { encoding: "utf8" });
  if (result.status === 0) {
    return result.stdout.trim();
  }

  for (const dir of fallbackDirs) {
    const candidate = join(dir, command);
    if (isExecutable(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

export function checkRuntimeHealth(runtime: RuntimeInfo): RuntimeHealth {
  if (!runtime.available) {
    return {
      checkedAt: nowIso(),
      ok: false,
      message: "binary not found"
    };
  }

  if (runtime.name === "claude") {
    const result = spawnSync(runtime.command, ["auth", "status"], {
      encoding: "utf8",
      timeout: 5000
    });
    const output = `${result.stdout || ""}${result.stderr || ""}`.trim();
    const authStatus = parseClaudeAuthStatus(output);
    if (authStatus?.loggedIn === false) {
      return {
        checkedAt: nowIso(),
        ok: false,
        message: `Claude Code CLI is installed but not logged in; run \`${runtime.command} auth login --claudeai\` from the MacBook.`
      };
    }
    if (authStatus?.loggedIn === true) {
      return {
        checkedAt: nowIso(),
        ok: true,
        message: "ok"
      };
    }
    if (result.error) {
      return {
        checkedAt: nowIso(),
        ok: false,
        message: result.error.message
      };
    }
    return {
      checkedAt: nowIso(),
      ok: result.status === 0,
      message: result.status === 0 ? "ok" : output || `exited with status ${result.status}`
    };
  }

  const result = spawnSync(runtime.command, ["--version"], {
    encoding: "utf8",
    timeout: 5000
  });
  const output = `${result.stdout || ""}${result.stderr || ""}`.trim();
  return {
    checkedAt: nowIso(),
    ok: result.status === 0,
    message: result.status === 0 ? output || "ok" : output || `exited with status ${result.status}`
  };
}

export function parseClaudeAuthStatus(output: string): { loggedIn: boolean } | undefined {
  try {
    const parsed = JSON.parse(output) as { loggedIn?: unknown };
    if (typeof parsed.loggedIn === "boolean") {
      return { loggedIn: parsed.loggedIn };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export function previewInputForEvent(input: string, maxLength = INPUT_EVENT_PREVIEW_LIMIT): string {
  const collapsed = input.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) {
    return "[empty input]";
  }
  if (collapsed.length <= maxLength) {
    return collapsed;
  }
  if (maxLength <= 3) {
    return ".".repeat(Math.max(0, maxLength));
  }
  return `${collapsed.slice(0, maxLength - 3)}...`;
}

function observedTimestamp(processRecord: DuoProcess): number {
  return Date.parse(processRecord.lastOutputAt || processRecord.updatedAt || processRecord.createdAt);
}

function defaultFallbackDirs(): string[] {
  return [join(homedir(), ".local/bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"];
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function sendInputToTmux(tmuxSession: string, input: string, runtime?: RuntimeName): void {
  const sent = spawnSync("tmux", ["send-keys", "-t", tmuxSession, "-l", input], {
    encoding: "utf8"
  });
  if (sent.status !== 0) {
    throw new Error(`tmux send-keys failed: ${sent.stderr || sent.stdout}`);
  }
  const enter = spawnSync("tmux", ["send-keys", "-t", tmuxSession, "Enter"], {
    encoding: "utf8"
  });
  if (enter.status !== 0) {
    throw new Error(`tmux enter failed: ${enter.stderr || enter.stdout}`);
  }
  if (runtime === "codex") {
    wait(150);
    const secondEnter = spawnSync("tmux", ["send-keys", "-t", tmuxSession, "Enter"], {
      encoding: "utf8"
    });
    if (secondEnter.status !== 0) {
      throw new Error(`tmux second enter failed: ${secondEnter.stderr || secondEnter.stdout}`);
    }
  }
}

function buildAgentIntro(
  processRecord: Pick<DuoProcess, "id" | "runtime" | "depth">,
  prompt: string
): string {
  const compactPrompt = prompt.replace(/\s+/g, " ").trim();
  const roleLines =
    processRecord.depth === 1
      ? [
          "You are the parent agent inside duo, a local Codex/Claude parent-child relay.",
          "At each meaningful action checkpoint, actively duo the other runtime for a scoped review, diagnosis, or implementation slice; do not wait for Alice to mention or route another agent.",
          "For non-trivial work, make child delegation a routine part of the loop: spawn the other runtime, read its output, and integrate the decision yourself.",
          "Keep each child task scoped; do not hand off the entire parent task."
        ]
      : [
          "You are a scoped child agent inside duo, a local Codex/Claude parent-child relay.",
          "Do the assigned slice only, report the result back to the parent agent, and do not spawn further child agents.",
          "Do not expand the task into a shared room workflow or take over the parent task."
        ];
  return [
    `DUO_PROCESS_ID=${processRecord.id}.`,
    `DUO_RUNTIME=${processRecord.runtime}.`,
    `DUO_DEPTH=${processRecord.depth}.`,
    ...roleLines,
    "This is not a shared chat room: do not mirror every message or build a room transcript.",
    "If duo MCP tools are configured, use them for status, spawning, output reads, and human checkpoints.",
    "Respect Alice's brake and stop when need_human is required.",
    `Task: ${compactPrompt}`
  ].join(" ");
}

function autoAdvanceCodexTrust(tmuxSession: string): void {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const pane = capturePane(tmuxSession, 80);
    if (!pane) {
      return;
    }
    if (pane.includes("Do you trust the contents of this directory?") || pane.includes("Press enter to continue")) {
      spawnSync("tmux", ["send-keys", "-t", tmuxSession, "Enter"], {
        encoding: "utf8"
      });
      wait(500);
      continue;
    }
    if (pane.includes("You are in ") || pane.includes("codex")) {
      return;
    }
    wait(250);
  }
}

function capturePane(tmuxSession: string, lines: number): string | undefined {
  const captured = spawnSync("tmux", ["capture-pane", "-t", tmuxSession, "-p", "-S", `-${lines}`], {
    encoding: "utf8"
  });
  if (captured.status !== 0) {
    return undefined;
  }
  return captured.stdout;
}

function shellJoin(parts: string[]): string {
  return parts.map(shellEscape).join(" ");
}

function shellEscape(value: string): string {
  if (/^[a-zA-Z0-9_/:=.,@%+-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function wait(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
