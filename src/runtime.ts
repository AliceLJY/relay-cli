import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { DuoProcess, DuoState, RuntimeInfo, RuntimeName } from "./types.js";
import { appendEvent, assertNotBraked, recordFailure, setBrake, writeState } from "./state.js";
import { nowIso, shortId } from "./ids.js";

const RUNTIME_COMMANDS: Record<RuntimeName, { env: string; command: string }> = {
  codex: { env: "DUO_CODEX_CMD", command: "codex" },
  claude: { env: "DUO_CLAUDE_CMD", command: "claude" }
};

export interface SpawnAgentInput {
  runtime: RuntimeName;
  name?: string;
  prompt?: string;
  parentId?: string;
  cwd?: string;
  waitMs?: number;
}

export function listRuntimes(): RuntimeInfo[] {
  return (Object.keys(RUNTIME_COMMANDS) as RuntimeName[]).map((name) => {
    const configured = process.env[RUNTIME_COMMANDS[name].env] || RUNTIME_COMMANDS[name].command;
    const [command, ...args] = configured.split(" ").filter(Boolean);
    const resolvedPath = resolveCommand(command);
    return {
      name,
      command,
      args,
      available: Boolean(resolvedPath),
      resolvedPath
    };
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
  const shellCommand = shellJoin([runtime.command, ...runtime.args]);
  const started = spawnSync("tmux", ["new-session", "-d", "-s", tmuxSession, "-c", cwd, shellCommand], {
    encoding: "utf8"
  });

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
    createdAt: now,
    updatedAt: now,
    failureCount: 0
  };

  let nextState = appendEvent(
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

  if (input.prompt) {
    const intro = buildAgentIntro(processRecord, input.prompt);
    sendInputToTmux(processRecord.tmuxSession, intro);
    const updated = { ...processRecord, lastOutputAt: nowIso(), updatedAt: nowIso() };
    nextState = {
      ...nextState,
      processes: {
        ...nextState.processes,
        [id]: updated
      }
    };
  }

  writeState(nextState);

  if (input.waitMs && input.waitMs > 0) {
    wait(input.waitMs);
  }

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

  sendInputToTmux(processRecord.tmuxSession, input);
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
    "sent input",
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
  spawnSync("tmux", ["send-keys", "-t", processRecord.tmuxSession, "C-c"], { encoding: "utf8" });
  return markProcess(state, processId, "cancelled");
}

export function closeProcess(state: DuoState, processId: string): DuoState {
  const processRecord = state.processes[processId];
  if (!processRecord) {
    throw new Error(`unknown process: ${processId}`);
  }
  spawnSync("tmux", ["kill-session", "-t", processRecord.tmuxSession], { encoding: "utf8" });
  return markProcess(state, processId, "closed");
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
  const now = Date.now();
  for (const processRecord of Object.values(state.processes)) {
    if (processRecord.status !== "running") {
      continue;
    }
    const observedAt = Date.parse(processRecord.lastOutputAt || processRecord.createdAt);
    if (now - observedAt > state.limits.spawnTimeoutMs) {
      const blocked = markProcess(state, processRecord.id, "blocked");
      return setBrake(blocked, `process timeout: ${processRecord.name}`, "system");
    }
  }
  return state;
}

export function safeToolCall<T>(state: DuoState, fn: () => T): { state: DuoState; result?: T; error?: Error } {
  try {
    return { state, result: fn() };
  } catch (error) {
    const next = recordFailure(state, (error as Error).message);
    writeState(next);
    return { state: next, error: error as Error };
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

function resolveCommand(command: string): string | undefined {
  const result = spawnSync("which", [command], { encoding: "utf8" });
  if (result.status === 0) {
    return result.stdout.trim();
  }
  return undefined;
}

function sendInputToTmux(tmuxSession: string, input: string): void {
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
}

function buildAgentIntro(processRecord: DuoProcess, prompt: string): string {
  return [
    "[DUO ORCHESTRATION CONTEXT]",
    `DUO_PROCESS_ID=${processRecord.id}`,
    `DUO_RUNTIME=${processRecord.runtime}`,
    `DUO_DEPTH=${processRecord.depth}`,
    "",
    "You are running inside duo, a local Codex/Claude relay.",
    "If MCP tools are configured, use duo tools for status, spawning, output reads, and human checkpoints.",
    "Respect Alice's brake: stop autonomous action when duo is braked or when need_human is required.",
    "",
    "[USER TASK]",
    prompt
  ].join("\n");
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
