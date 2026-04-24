import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { waitForHumanResponse } from "./human.js";
import {
  addHumanRequest,
  answerLatestHumanRequest,
  clearBrake,
  readState,
  setBrake,
  withLockedState,
  writeState,
  projectRootFrom
} from "./state.js";
import {
  applyRuntimeLimits,
  cancelAgent,
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

export async function startMcpServer(projectRoot = projectRootFrom()): Promise<void> {
  const server = new McpServer({
    name: "relay-cli",
    version: VERSION
  });

  server.tool("whoami", "Return the current duo process identity and brake state.", {}, async () => {
    const state = readState(projectRoot);
    return textResult({
      duo_process_id: process.env.DUO_PROCESS_ID,
      projectRoot,
      brake: state.brake,
      limits: state.limits
    });
  });

  server.tool("list_runtimes", "List available local agent runtimes.", {}, async () => {
    return textResult(listRuntimes());
  });

  server.tool(
    "spawn_agent",
    "Spawn a Codex or Claude child agent in a tmux-backed PTY.",
    {
      runtime: z.enum(["codex", "claude"]),
      name: z.string().optional(),
      prompt: z.string().optional(),
      parentId: z.string().optional(),
      waitMs: z.number().int().min(0).max(10000).optional()
    },
    async (input) => {
      const result = withLockedState(projectRoot, (current) => {
        const state = applyRuntimeLimits(current);
        const parentId = resolveParentId(state, {
          explicit: input.parentId,
          envFallback: true
        });
        const spawned = spawnAgent(state, {
          runtime: input.runtime as RuntimeName,
          name: input.name,
          prompt: input.prompt,
          parentId,
          cwd: projectRoot
        });
        return { state: spawned.state, result: spawned.process };
      });
      stabilizeProcess(result, input.waitMs || 0);
      return textResult(result);
    }
  );

  server.tool(
    "send_input",
    "Send literal input to a spawned process.",
    {
      processId: z.string(),
      input: z.string()
    },
    async (input) => {
      withLockedState(projectRoot, (current) => {
        const state = applyRuntimeLimits(current);
        return {
          state: sendInput(state, input.processId, input.input),
          result: undefined
        };
      });
      return textResult({ ok: true, processId: input.processId });
    }
  );

  server.tool(
    "get_output",
    "Read recent terminal output from a spawned process.",
    {
      processId: z.string(),
      lines: z.number().int().min(1).max(500).optional()
    },
    async (input) => {
      const result = withLockedState(projectRoot, (state) => {
        const next = getOutput(state, input.processId, input.lines || 80);
        return { state: next.state, result: next.output };
      });
      return textResult({ processId: input.processId, output: result });
    }
  );

  server.tool("get_status", "Return current duo status, processes, and pending human requests.", {}, async () => {
    const state = withLockedState(projectRoot, (current) => {
      const next = applyRuntimeLimits(current);
      return { state: next, result: next };
    });
    return textResult(state);
  });

  server.tool(
    "cancel_agent",
    "Send Ctrl-C to a spawned process and mark it cancelled.",
    {
      processId: z.string()
    },
    async (input) => {
      withLockedState(projectRoot, (state) => ({
        state: cancelAgent(state, input.processId),
        result: undefined
      }));
      return textResult({ ok: true, processId: input.processId });
    }
  );

  server.tool(
    "close_process",
    "Kill the tmux session for a spawned process and mark it closed.",
    {
      processId: z.string()
    },
    async (input) => {
      withLockedState(projectRoot, (state) => ({
        state: closeProcess(state, input.processId),
        result: undefined
      }));
      return textResult({ ok: true, processId: input.processId });
    }
  );

  server.tool(
    "need_human",
    "Block and ask Alice for direction before continuing.",
    {
      reason: z.string(),
      question: z.string(),
      urgency: z.enum(["low", "normal", "high"]).default("normal"),
      options: z.array(z.string()).default([]),
      recommended: z.string().optional(),
      timeoutSeconds: z.number().int().min(30).max(3600).default(1800)
    },
    async (input) => {
      const request = withLockedState(projectRoot, (current) => {
        const next = addHumanRequest(current, {
          reason: input.reason,
          question: input.question,
          urgency: input.urgency,
          options: input.options,
          recommended: input.recommended
        });
        return { state: next.state, result: next.request };
      });
      const response = await waitForHumanResponse(projectRoot, request.id, input.timeoutSeconds);
      return textResult({ requestId: request.id, response });
    }
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

function textResult(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: typeof value === "string" ? value : JSON.stringify(value, null, 2)
      }
    ]
  };
}
