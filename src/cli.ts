#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join as pathJoin } from "node:path";
import { Command, Option } from "commander";
import { startMcpServer } from "./mcp-server.js";
import { clearTerminal, readWatchSnapshot, renderWatchFrameWithLayout } from "./watch.js";
import {
  clearBrake,
  readState,
  resolveIdleTimeoutMs,
  withLockedState,
  projectRootFrom
} from "./state.js";
import {
  applyRuntimeLimits,
  closeProcess,
  stabilizeProcess,
  spawnAgent
} from "./runtime.js";
import type { RuntimeName } from "./types.js";

const VERSION = "0.1.0";
const ACTIVE_STATUSES = new Set(["running", "blocked"]);

const program = new Command();

program
  .name("duo")
  .description("Local Codex/Claude parent-child relay.")
  .version(VERSION)
  .addHelpCommand(false)
  .addOption(new Option("-C, --cwd <path>", "project root for .duo state").default(process.cwd()).hideHelp());

program.command("mcp", { hidden: true }).description("Run the duo MCP server over stdio.").action(async () => {
  const root = projectRoot();
  await startMcpServer(root);
});

program
  .command("start")
  .description("Start one chosen parent runtime and attach to its tmux session.")
  .addOption(new Option("--parent <runtime>", "codex or claude").choices(["codex", "claude"]).makeOptionMandatory())
  .argument("[prompt...]", "initial parent task")
  .action((promptParts: string[], options: { parent: RuntimeName }) => {
    const root = projectRoot();
    withLockedState(root, (state) => {
      let next = state.brake?.active ? clearBrake(state, "start: fresh") : state;
      // start = 新开 parent。把 idle 超时的 running/blocked stale process 一并关掉，
      // 否则 spawnManagedProcess 里的 applyRuntimeLimits 会因这些幽灵进程立刻
      // 重新 setBrake，spawnAgent 抛 "duo is braked: process timeout: ..."，
      // 即使前一步刚清了 brake 也救不回。
      const idleTimeoutMs = resolveIdleTimeoutMs(next);
      const now = Date.now();
      for (const proc of Object.values(next.processes)) {
        if (proc.status !== "running" && proc.status !== "blocked") continue;
        const observedAt = Date.parse(proc.lastOutputAt || proc.createdAt);
        if (now - observedAt <= idleTimeoutMs) continue;
        next = closeProcess(next, proc.id);
      }
      return { state: next, result: undefined };
    });
    const parent = spawnManagedProcess(
      root,
      options.parent,
      promptParts.join(" ").trim() || undefined,
      `parent-${options.parent}`
    );

    attachToProcess(parent);
  });

program
  .command("list")
  .description("List active parent agents.")
  .action(() => {
    const root = projectRoot();
    const state = readState(root);
    printProcessList(state);
  });

program
  .command("show")
  .description("Show the chat log of a duo claude process by id prefix.")
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
    const proc = matches[0];
    if (proc.runtime !== "claude") {
      throw new Error(`only claude processes have chat logs (this is ${proc.runtime})`);
    }

    const encoded = "-" + proc.cwd.split("/").filter(Boolean).join("-");
    const projectDir = pathJoin(homedir(), ".claude", "projects", encoded);
    if (!existsSync(projectDir)) {
      throw new Error(`claude project dir not found: ${projectDir}`);
    }

    const targetMs = Date.parse(proc.createdAt);
    const searchWindowSeconds = 120;
    const windowMs = searchWindowSeconds * 1000;
    const candidates = readdirSync(projectDir)
      .filter((n) => n.endsWith(".jsonl"))
      .map((n) => {
        const stat = statSync(pathJoin(projectDir, n));
        return { name: n, birth: stat.birthtimeMs, mtime: stat.mtimeMs };
      })
      .filter((f) => Math.abs(f.birth - targetMs) <= windowMs)
      .sort((a, b) => Math.abs(a.birth - targetMs) - Math.abs(b.birth - targetMs));

    if (candidates.length === 0) {
      throw new Error(
        `no chat log found within ${searchWindowSeconds}s of ${proc.createdAt} in ${projectDir}`
      );
    }

    const jsonlPath = pathJoin(projectDir, candidates[0].name);

    console.log(`# duo chat log: ${proc.id} (${proc.name})\n`);
    console.log(`> source: ${jsonlPath}`);
    console.log(`> proc: ${proc.runtime} started at ${proc.createdAt}, status ${proc.status}\n`);

    const content = readFileSync(jsonlPath, "utf8");
    for (const line of content.split("\n")) {
      if (!line) continue;
      let evt: { type?: string; timestamp?: string; message?: { content?: unknown } };
      try {
        evt = JSON.parse(line);
      } catch {
        continue;
      }
      if (evt.type !== "user" && evt.type !== "assistant") continue;
      const text = extractText(evt.message?.content);
      if (!text) continue;
      const ts = evt.timestamp ? evt.timestamp.replace("T", " ").slice(0, 19) : "";
      console.log(`---\n## ${evt.type === "user" ? "User" : "Assistant"}  ${ts}\n`);
      console.log(text);
      console.log();
    }
  });

program
  .command("watch")
  .description("Watch multiple duo-controlled agent outputs in one terminal.")
  .action(async () => {
    await runWatchLoop(projectRoot());
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error((error as Error).message);
  process.exitCode = 1;
});

function projectRoot(): string {
  if (hasExplicitCwdArg(process.argv.slice(2))) {
    delete process.env.DUO_DIR;
  }
  return projectRootFrom(program.opts<{ cwd: string }>().cwd);
}

function hasExplicitCwdArg(argv: string[]): boolean {
  return argv.some(
    (arg) =>
      arg === "-C" ||
      arg === "--cwd" ||
      arg.startsWith("--cwd=") ||
      (arg.startsWith("-C") && arg.length > 2)
  );
}

function printProcessList(state: ReturnType<typeof readState>): void {
  const all = Object.values(state.processes).sort((a, b) =>
    a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0
  );
  const visible = all.filter((p) => ACTIVE_STATUSES.has(p.status) && p.depth === 1);

  if (visible.length === 0) {
    console.log("no active parent agents");
    return;
  }

  for (const p of visible) {
    const when = p.createdAt.replace("T", " ").slice(0, 19);
    const subject = summarizePrompt(p.prompt);
    console.log(`${p.id}  ${p.runtime.padEnd(6)} ${p.status.padEnd(8)} ${when}  ${p.name}  ${subject}`);
  }
}

function extractText(content: unknown): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (block && typeof block === "object") {
        const b = block as { type?: string; text?: string };
        if (b.type === "text" && b.text) parts.push(b.text);
      }
    }
    return parts.join("\n");
  }
  return "";
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
  name?: string
) {
  const result = withLockedState(root, (current) => {
    const state = applyRuntimeLimits(current);
    const spawned = spawnAgent(state, {
      runtime,
      name,
      prompt,
      cwd: root
    });
    return { state: spawned.state, result: spawned.process };
  });
  stabilizeProcess(result, 1000);
  return result;
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

async function runWatchLoop(root: string): Promise<void> {
  const lines = 30;
  const interval = 1500;
  const recentWindowMs = 120 * 1000;

  do {
    const snapshot = readWatchSnapshot(root, {
      lines,
      recentWindowMs
    });
    if (process.stdout.isTTY) {
      clearTerminal();
    }
    process.stdout.write(
      renderWatchFrameWithLayout(snapshot, {
        layout: "columns",
        terminalWidth: process.stdout.columns || 160
      })
    );
    await sleep(interval);
  } while (true);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
