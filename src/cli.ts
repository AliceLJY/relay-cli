#!/usr/bin/env node
import { Command } from "commander";
import { startMcpServer } from "./mcp-server.js";
import {
  answerLatestHumanRequest,
  latestEvents,
  readState,
  setBrake,
  withLockedState,
  writeState,
  projectRootFrom
} from "./state.js";
import {
  applyRuntimeLimits,
  closeAllProcesses,
  getOutput,
  listRuntimes,
  sendInput,
  stabilizeProcess,
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
  const state = withLockedState(root, (current) => {
    const next = applyRuntimeLimits(current);
    return { state: next, result: next };
  });
  printStatus(state);
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
  .command("spawn")
  .description("Manually spawn a Codex or Claude process.")
  .argument("<runtime>", "codex or claude")
  .argument("[prompt...]", "initial prompt")
  .option("--name <name>", "process display name")
  .action((runtime: RuntimeName, promptParts: string[], options: { name?: string }) => {
    const root = projectRoot();
    const result = withLockedState(root, (current) => {
      const state = applyRuntimeLimits(current);
      const spawned = spawnAgent(state, {
        runtime,
        name: options.name,
        prompt: promptParts.join(" ").trim() || undefined,
        cwd: root
      });
      return { state: spawned.state, result: spawned.process };
    });
    stabilizeProcess(result, 1000);
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command("send")
  .description("Send input to a spawned process.")
  .argument("<processId>")
  .argument("<input...>")
  .action((processId: string, inputParts: string[]) => {
    const root = projectRoot();
    withLockedState(root, (state) => ({
      state: sendInput(state, processId, inputParts.join(" ")),
      result: undefined
    }));
    console.log(`sent: ${processId}`);
  });

program
  .command("output")
  .description("Capture recent output from a spawned process.")
  .argument("<processId>")
  .option("-n, --lines <lines>", "number of lines", "80")
  .action((processId: string, options: { lines: string }) => {
    const root = projectRoot();
    const result = withLockedState(root, (state) => {
      const next = getOutput(state, processId, Number(options.lines));
      return { state: next.state, result: next.output };
    });
    process.stdout.write(result);
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
