#!/usr/bin/env node
import { Command } from "commander";
import { startMcpServer } from "./mcp-server.js";
import {
  answerLatestHumanRequest,
  clearBrake,
  latestEvents,
  readState,
  setBrake,
  writeState,
  projectRootFrom
} from "./state.js";
import {
  applyRuntimeLimits,
  closeAllProcesses,
  getOutput,
  listRuntimes,
  sendInput,
  spawnAgent
} from "./runtime.js";
import type { RuntimeName } from "./types.js";

const VERSION = "0.1.0";

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
  const state = applyRuntimeLimits(readState(root));
  writeState(state);
  printStatus(state);
});

program
  .command("brake")
  .description("Freeze new autonomous spawn/send actions without killing current panes.")
  .argument("[reason]", "why the brake is being applied", "human brake")
  .action((reason: string) => {
    const state = setBrake(readState(projectRoot()), reason, "human");
    writeState(state);
    console.log(`braked: ${reason}`);
  });

program
  .command("resume")
  .description("Clear the brake and optionally answer a pending need_human request.")
  .argument("[instruction...]", "direction to give agents before resuming")
  .action((instructionParts: string[]) => {
    const instruction = instructionParts.join(" ").trim() || "resume";
    const state = answerLatestHumanRequest(readState(projectRoot()), instruction);
    writeState(state);
    console.log(`resumed: ${instruction}`);
  });

program.command("abort").description("Kill running duo tmux sessions and freeze the run.").action(() => {
  const root = projectRoot();
  const closed = closeAllProcesses(readState(root), "aborted");
  const state = setBrake(closed, "aborted by human", "human");
  writeState(state);
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
  .command("spawn")
  .description("Manually spawn a Codex or Claude process.")
  .argument("<runtime>", "codex or claude")
  .argument("[prompt...]", "initial prompt")
  .option("--name <name>", "process display name")
  .action((runtime: RuntimeName, promptParts: string[], options: { name?: string }) => {
    const root = projectRoot();
    const state = applyRuntimeLimits(readState(root));
    writeState(state);
    const result = spawnAgent(state, {
      runtime,
      name: options.name,
      prompt: promptParts.join(" ").trim() || undefined,
      cwd: root,
      waitMs: 1000
    });
    console.log(JSON.stringify(result.process, null, 2));
  });

program
  .command("send")
  .description("Send input to a spawned process.")
  .argument("<processId>")
  .argument("<input...>")
  .action((processId: string, inputParts: string[]) => {
    const root = projectRoot();
    const next = sendInput(readState(root), processId, inputParts.join(" "));
    writeState(next);
    console.log(`sent: ${processId}`);
  });

program
  .command("output")
  .description("Capture recent output from a spawned process.")
  .argument("<processId>")
  .option("-n, --lines <lines>", "number of lines", "80")
  .action((processId: string, options: { lines: string }) => {
    const root = projectRoot();
    const result = getOutput(readState(root), processId, Number(options.lines));
    writeState(result.state);
    process.stdout.write(result.output);
  });

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
