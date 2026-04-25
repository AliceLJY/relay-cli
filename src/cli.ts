#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { Command, Option } from "commander";
import { startMcpServer } from "./mcp-server.js";
import { clearTerminal, readWatchSnapshot, renderWatchFrameWithLayout } from "./watch.js";
import {
  answerLatestHumanRequest,
  clearBrake,
  latestEvents,
  readState,
  setBrake,
  withLockedState,
  writeState,
  projectRootFrom
} from "./state.js";
import {
  applyRuntimeLimits,
  cancelAgent,
  closeAllProcesses,
  closeProcess,
  getOutput,
  listRuntimes,
  resolveParentId,
  sendInput,
  stabilizeProcess,
  spawnAgent
} from "./runtime.js";
import type { RuntimeName } from "./types.js";

const VERSION = "0.1.0";
const ACTIVE_STATUSES = new Set(["running", "blocked"]);

const program = new Command();

program
  .name("duo")
  .description("Local Codex/Claude relay with an explicit human brake.")
  .version(VERSION)
  .option("-C, --cwd <path>", "project root for .duo state", process.cwd());

program.command("mcp").description("Run the duo MCP server over stdio.").action(async () => {
  const root = projectRoot();
  await startMcpServer(root);
});

program.command("status").description("Show current duo status.").action(() => {
  const root = projectRoot();
  const state = withLockedState(root, (current) => {
    const next = applyRuntimeLimits(current);
    return { state: next, result: next };
  });
  printStatus(state);
});

program
  .command("list")
  .description("List parent processes with their starting prompt (default: active parents only).")
  .option("-n, --limit <n>", "show only the most recent N entries")
  .option("--all", "include closed/aborted/timeout processes (default: only active)")
  .option("--children", "include child processes spawned by parents (default: parents only)")
  .option("--json", "emit JSON instead of a table")
  .action((options: { limit?: string; all?: boolean; children?: boolean; json?: boolean }) => {
    const root = projectRoot();
    const state = readState(root);
    printProcessList(state, {
      limit: options.limit ? Number(options.limit) : undefined,
      includeFinished: Boolean(options.all),
      includeChildren: Boolean(options.children),
      json: Boolean(options.json)
    });
  });

program
  .command("enter")
  .description("Attach to a running parent's tmux session by id prefix.")
  .argument("<prefix>", "process id or its short prefix")
  .action((prefix: string) => {
    const root = projectRoot();
    const state = readState(root);
    const matches = Object.values(state.processes).filter(
      (p) => p.id.startsWith(prefix) || p.id.startsWith(`proc_${prefix}`)
    );
    if (matches.length === 0) {
      throw new Error(`no process matches prefix: ${prefix}`);
    }
    if (matches.length > 1) {
      const lines = matches.map((p) => `  ${p.id} ${p.runtime} ${p.status} ${p.name}`).join("\n");
      throw new Error(`prefix '${prefix}' matches ${matches.length} processes:\n${lines}`);
    }
    const target = matches[0];
    if (target.status !== "running" && target.status !== "blocked") {
      throw new Error(`process ${target.id} is ${target.status}; cannot attach`);
    }
    const attached = spawnSync("tmux", ["attach-session", "-t", target.tmuxSession], {
      stdio: "inherit",
      encoding: "utf8"
    });
    if (attached.status !== 0) {
      throw new Error(`tmux attach failed: ${attached.stderr || attached.stdout}`);
    }
  });

program
  .command("brake")
  .description("Freeze new autonomous spawn/send actions without killing current panes.")
  .argument("[reason]", "why the brake is being applied", "human brake")
  .action((reason: string) => {
    withLockedState(projectRoot(), (state) => ({
      state: setBrake(state, reason, "human"),
      result: undefined
    }));
    console.log(`braked: ${reason}`);
  });

program
  .command("resume")
  .description("Clear the brake and optionally answer a pending need_human request.")
  .argument("[instruction...]", "direction to give agents before resuming")
  .action((instructionParts: string[]) => {
    const instruction = instructionParts.join(" ").trim() || "resume";
    withLockedState(projectRoot(), (state) => ({
      state: answerLatestHumanRequest(state, instruction),
      result: undefined
    }));
    console.log(`resumed: ${instruction}`);
  });

program.command("abort").description("Kill running duo tmux sessions and freeze the run.").action(() => {
  const root = projectRoot();
  withLockedState(root, (state) => {
    const closed = closeAllProcesses(state, "aborted");
    return {
      state: setBrake(closed, "aborted by human", "human"),
      result: undefined
    };
  });
  console.log("aborted: running duo processes were closed");
});

program
  .command("runtimes")
  .description("List configured Codex/Claude runtimes.")
  .option("--check-auth", "also run a health/auth probe")
  .action((options: { checkAuth?: boolean }) => {
    console.log(JSON.stringify(listRuntimes({ checkAuth: options.checkAuth }), null, 2));
  });

program
  .command("start")
  .description("Start one chosen parent runtime and attach to its tmux session.")
  .addOption(new Option("--parent <runtime>", "codex or claude").choices(["codex", "claude"]).default("claude"))
  .argument("[prompt...]", "initial parent task")
  .option("--name <name>", "process display name")
  .option("--no-attach", "return after spawning instead of attaching to the parent session")
  .action((promptParts: string[], options: { parent: RuntimeName; name?: string; attach?: boolean }) => {
    const root = projectRoot();
    withLockedState(root, (state) => ({
      state: state.brake?.active ? clearBrake(state, "start: fresh") : state,
      result: undefined
    }));
    const parent = spawnManagedProcess(
      root,
      options.parent,
      promptParts.join(" ").trim() || undefined,
      options.name || `parent-${options.parent}`
    );

    if (options.attach === false) {
      console.log(JSON.stringify(parent, null, 2));
      return;
    }

    attachToProcess(parent);
  });

program
  .command("spawn")
  .description("Manually spawn a Codex or Claude process. Inherits parent from DUO_PROCESS_ID env when set.")
  .argument("<runtime>", "codex or claude")
  .argument("[prompt...]", "initial prompt")
  .option("--name <name>", "process display name")
  .option("--parent <processId>", "explicit parent process id; overrides DUO_PROCESS_ID env")
  .action((runtime: RuntimeName, promptParts: string[], options: { name?: string; parent?: string }) => {
    const root = projectRoot();
    const result = spawnManagedProcess(
      root,
      runtime,
      promptParts.join(" ").trim() || undefined,
      options.name,
      { inheritEnvParent: true, parentId: options.parent }
    );
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command("pair")
  .description("Spawn a Codex/Claude pair from one shared instruction.")
  .argument("[prompt...]", "shared task to send to both runtimes")
  .option("--no-watch", "return after spawning instead of entering duo watch")
  .option("-n, --lines <lines>", "lines per process pane", "30")
  .option("-i, --interval <ms>", "refresh interval in milliseconds", "1500")
  .option("--recent-seconds <seconds>", "also show recently finished processes for this many seconds", "120")
  .option("--layout <layout>", "stack or columns", "columns")
  .action(
    async (promptParts: string[], options: {
      watch?: boolean;
      lines: string;
      interval: string;
      recentSeconds: string;
      layout: "stack" | "columns";
    }) => {
      const root = projectRoot();
      const prompt = promptParts.join(" ").trim() || undefined;
      const started: Array<{ id: string }> = [];

      try {
        const codex = spawnManagedProcess(root, "codex", prompt, "pair-codex");
        started.push({ id: codex.id });
        const claude = spawnManagedProcess(root, "claude", prompt, "pair-claude");
        started.push({ id: claude.id });

        if (options.watch !== false) {
          await runWatchLoop(root, {
            lines: options.lines,
            interval: options.interval,
            recentSeconds: options.recentSeconds,
            layout: options.layout
          });
          return;
        }

        console.log(JSON.stringify({ codex, claude }, null, 2));
      } catch (error) {
        if (started.length > 0) {
          cleanupSpawnedProcesses(root, started.map((processRecord) => processRecord.id));
        }
        throw error;
      }
    }
  );

program
  .command("send")
  .description("Send input to a spawned process.")
  .argument("<processId>")
  .argument("<input...>")
  .action((processId: string, inputParts: string[]) => {
    const root = projectRoot();
    withLockedState(root, (current) => {
      const state = applyRuntimeLimits(current);
      return {
        state: sendInput(state, processId, inputParts.join(" ")),
        result: undefined
      };
    });
    console.log(`sent: ${processId}`);
  });

program
  .command("output")
  .description("Capture recent output from a spawned process.")
  .argument("<processId>")
  .option("-n, --lines <lines>", "number of lines", "80")
  .action((processId: string, options: { lines: string }) => {
    const root = projectRoot();
    const result = withLockedState(root, (current) => {
      const state = applyRuntimeLimits(current);
      const next = getOutput(state, processId, Number(options.lines));
      return { state: next.state, result: next.output };
    });
    process.stdout.write(result);
  });

program
  .command("cancel")
  .description("Send Ctrl-C to a running process and mark it cancelled (pane stays).")
  .argument("<processId>")
  .action((processId: string) => {
    const root = projectRoot();
    withLockedState(root, (current) => {
      const state = applyRuntimeLimits(current);
      return {
        state: cancelAgent(state, processId),
        result: undefined
      };
    });
    console.log(`cancelled: ${processId}`);
  });

program
  .command("close")
  .description("Kill the tmux session for a process and mark it closed.")
  .argument("<processId>")
  .action((processId: string) => {
    const root = projectRoot();
    withLockedState(root, (current) => {
      const state = applyRuntimeLimits(current);
      return {
        state: closeProcess(state, processId),
        result: undefined
      };
    });
    console.log(`closed: ${processId}`);
  });

program
  .command("watch")
  .description("Watch multiple duo-controlled agent outputs in one terminal.")
  .option("-n, --lines <lines>", "lines per process pane", "30")
  .option("-i, --interval <ms>", "refresh interval in milliseconds", "1500")
  .option("--recent-seconds <seconds>", "also show recently finished processes for this many seconds", "120")
  .option("--layout <layout>", "stack or columns", "columns")
  .option("--all", "include inactive processes")
  .option("--once", "render one snapshot and exit")
  .action(
    async (options: {
      lines: string;
      interval: string;
      recentSeconds: string;
      layout: "stack" | "columns";
      all?: boolean;
      once?: boolean;
    }) => {
      await runWatchLoop(projectRoot(), options);
    }
  );

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error((error as Error).message);
  process.exitCode = 1;
});

function projectRoot(): string {
  return projectRootFrom(program.opts<{ cwd: string }>().cwd);
}

function printStatus(state: ReturnType<typeof readState>): void {
  const processes = Object.values(state.processes);
  const pendingRequests = Object.values(state.humanRequests).filter((request) => request.status === "pending");
  console.log(`project: ${state.projectRoot}`);
  console.log(`brake: ${state.brake?.active ? state.brake.reason : "off"}`);
  console.log(`processes: ${processes.length}`);
  for (const processRecord of processes) {
    console.log(
      `- ${processRecord.id} ${processRecord.runtime} ${processRecord.status} depth=${processRecord.depth} name="${processRecord.name}"`
    );
  }
  console.log(`pending_human_requests: ${pendingRequests.length}`);
  for (const request of pendingRequests) {
    console.log(`- ${request.id} [${request.urgency}] ${request.question}`);
  }
  console.log("recent_events:");
  for (const event of latestEvents(state, 5)) {
    console.log(`- ${event.createdAt} ${event.type}: ${event.message}`);
  }
}

function printProcessList(
  state: ReturnType<typeof readState>,
  options: { limit?: number; includeFinished: boolean; includeChildren: boolean; json: boolean }
): void {
  const all = Object.values(state.processes).sort((a, b) =>
    a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0
  );
  const byStatus = options.includeFinished ? all : all.filter((p) => ACTIVE_STATUSES.has(p.status));
  const filtered = options.includeChildren ? byStatus : byStatus.filter((p) => p.depth === 1);
  const sliced = options.limit ? filtered.slice(0, options.limit) : filtered;

  if (options.json) {
    console.log(JSON.stringify(sliced, null, 2));
    return;
  }

  if (sliced.length === 0) {
    if (options.includeFinished && options.includeChildren) {
      console.log("no processes");
    } else if (options.includeFinished) {
      console.log("no parent processes (use --children to include child agents)");
    } else {
      console.log("no active parent processes (use --all to include finished, --children for children)");
    }
    return;
  }

  for (const p of sliced) {
    const when = p.createdAt.replace("T", " ").slice(0, 19);
    const subject = summarizePrompt(p.prompt);
    const depthMark = p.depth === 1 ? "  " : `→${p.depth}`;
    console.log(`${depthMark} ${p.id}  ${p.runtime.padEnd(6)} ${p.status.padEnd(8)} ${when}  ${p.name}  ${subject}`);
  }
}

function summarizePrompt(prompt: string | undefined): string {
  if (!prompt) {
    return "(no prompt)";
  }
  const compact = prompt.replace(/\s+/g, " ").trim();
  return compact.length > 80 ? `${compact.slice(0, 77)}...` : compact;
}

function spawnManagedProcess(
  root: string,
  runtime: RuntimeName,
  prompt?: string,
  name?: string,
  options: { inheritEnvParent?: boolean; parentId?: string } = {}
) {
  const result = withLockedState(root, (current) => {
    const state = applyRuntimeLimits(current);
    const parentId = resolveParentId(state, {
      explicit: options.parentId,
      envFallback: options.inheritEnvParent
    });
    const spawned = spawnAgent(state, {
      runtime,
      name,
      prompt,
      cwd: root,
      parentId
    });
    return { state: spawned.state, result: spawned.process };
  });
  stabilizeProcess(result, 1000);
  return result;
}

function cleanupSpawnedProcesses(root: string, processIds: string[]): void {
  try {
    withLockedState(root, (state) => {
      let next = state;
      for (const processId of processIds) {
        next = closeProcess(next, processId);
      }
      return { state: next, result: undefined };
    });
  } catch {
    // Best-effort cleanup only; preserve the original spawn error.
  }
}

function attachToProcess(processRecord: ReturnType<typeof spawnManagedProcess>): void {
  const attached = spawnSync("tmux", ["attach-session", "-t", processRecord.tmuxSession], {
    stdio: "inherit",
    encoding: "utf8"
  });
  if (attached.status !== 0) {
    throw new Error(`tmux attach failed: ${attached.stderr || attached.stdout}`);
  }
}

async function runWatchLoop(
  root: string,
  options: {
    lines: string;
    interval: string;
    recentSeconds: string;
    layout: "stack" | "columns";
    all?: boolean;
    once?: boolean;
  }
): Promise<void> {
  const lines = Number(options.lines);
  const interval = Number(options.interval);
  const recentWindowMs = Number(options.recentSeconds) * 1000;

  do {
    const snapshot = readWatchSnapshot(root, {
      lines,
      includeAll: options.all,
      recentWindowMs
    });
    if (process.stdout.isTTY) {
      clearTerminal();
    }
    process.stdout.write(
      renderWatchFrameWithLayout(snapshot, {
        layout: options.layout,
        terminalWidth: process.stdout.columns || 160
      })
    );
    if (options.once) {
      return;
    }
    await sleep(interval);
  } while (true);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
