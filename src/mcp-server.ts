import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { waitForHumanResponse } from "./human.js";
import {
  addHumanRequest,
  answerLatestHumanRequest,
  clearBrake,
  readState,
  recordFailure,
  setBrake,
  withLockedState,
  writeState,
  projectRootFrom
} from "./state.js";
import type { DuoProcess, DuoState } from "./types.js";
import {
  applyRuntimeLimitsWithReconcile,
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
    "Spawn a Codex or Claude child agent in a tmux-backed PTY. Requires parentId or DUO_PROCESS_ID. Set bypassSandbox=true (codex only) to launch the interactive codex with --dangerously-bypass-approvals-and-sandbox so the parent can keep talking to it without per-action approval.",
    {
      runtime: z.enum(["codex", "claude"]),
      name: z.string().optional(),
      prompt: z.string().optional(),
      parentId: z.string().optional(),
      bypassSandbox: z.boolean().optional(),
      waitMs: z.number().int().min(0).max(10000).optional()
    },
    async (input) => {
      const result = runMcpTool<DuoProcess>(projectRoot, (current) => {
        const state = applyRuntimeLimitsWithReconcile(current);
        const parentId = resolveParentId(state, {
          explicit: input.parentId,
          envFallback: true,
          requireParent: true
        });
        const spawned = spawnAgent(state, {
          runtime: input.runtime as RuntimeName,
          name: input.name,
          prompt: input.prompt,
          parentId,
          cwd: projectRoot,
          bypassSandbox: input.bypassSandbox
        });
        return { state: spawned.state, result: spawned.process };
      });
      if (!("error" in result)) {
        stabilizeProcess(result, input.waitMs || 0);
      }
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
      const result = runMcpTool<{ ok: true; processId: string }>(projectRoot, (current) => {
        const state = applyRuntimeLimitsWithReconcile(current);
        return {
          state: sendInput(state, input.processId, input.input),
          result: { ok: true, processId: input.processId }
        };
      });
      return textResult(result);
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
      const result = runMcpTool<{ processId: string; output: string; status?: string }>(
        projectRoot,
        (current) => {
          const reconciled = applyRuntimeLimitsWithReconcile(current);
          const target = reconciled.processes[input.processId];
          // After reconcile a vanished session is already marked closed; don't
          // let getOutput's tmux capture failure overwrite that with "failed".
          if (!target) {
            throw new Error(`unknown process: ${input.processId}`);
          }
          if (target.status !== "running" && target.status !== "blocked") {
            return {
              state: reconciled,
              result: {
                processId: input.processId,
                status: target.status,
                output: `[process is ${target.status}; tmux session no longer captured]`
              }
            };
          }
          const next = getOutput(reconciled, input.processId, input.lines || 80);
          return {
            state: next.state,
            result: { processId: input.processId, output: next.output }
          };
        }
      );
      return textResult(result);
    }
  );

  server.tool("get_status", "Return current duo status, processes, and pending human requests.", {}, async () => {
    const result = runMcpTool<DuoState>(projectRoot, (current) => {
      const next = applyRuntimeLimitsWithReconcile(current);
      return { state: next, result: next };
    });
    return textResult(result);
  });

  server.tool(
    "cancel_agent",
    "Send Ctrl-C to a spawned process and mark it cancelled.",
    {
      processId: z.string()
    },
    async (input) => {
      const result = runMcpTool<{ ok: true; processId: string; status?: string }>(
        projectRoot,
        (current) => {
          // No reconcile here: cancel is a mutation that doesn't depend on
          // tmux liveness for its decision. Paying N tmux has-session probes
          // every cancel call only buys "marginally fresher status before
          // short-circuit" — not worth it. Short-circuit still defends
          // against re-marking an already-terminal process.
          const target = current.processes[input.processId];
          if (!target) {
            throw new Error(`unknown process: ${input.processId}`);
          }
          if (target.status !== "running" && target.status !== "blocked") {
            return {
              state: current,
              result: { ok: true, processId: input.processId, status: target.status }
            };
          }
          return {
            state: cancelAgent(current, input.processId),
            result: { ok: true, processId: input.processId }
          };
        }
      );
      return textResult(result);
    }
  );

  server.tool(
    "close_process",
    "Kill the tmux session for a spawned process and mark it closed.",
    {
      processId: z.string()
    },
    async (input) => {
      const result = runMcpTool<{ ok: true; processId: string; status?: string }>(
        projectRoot,
        (current) => {
          // No reconcile here either: close is a mutation, not a query.
          // The short-circuit below makes already-terminal processes a
          // no-op so we don't run tmux kill-session against an absent pane
          // and emit a misleading tmux_close_failed event.
          const target = current.processes[input.processId];
          if (!target) {
            throw new Error(`unknown process: ${input.processId}`);
          }
          if (target.status !== "running" && target.status !== "blocked") {
            return {
              state: current,
              result: { ok: true, processId: input.processId, status: target.status }
            };
          }
          return {
            state: closeProcess(current, input.processId),
            result: { ok: true, processId: input.processId }
          };
        }
      );
      return textResult(result);
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

/**
 * Wrap a withLockedState body so any thrown error funnels through
 * recordFailure (= the failure budget that triggers a brake at the limit).
 * Without this wrapper, MCP tool failures would bypass the safety counter
 * advertised in the README ("three recorded tool failures trigger a brake").
 *
 * Errors are not re-thrown — they are surfaced as a structured payload
 * (`{ error, failureCount, brake }`) so the caller can render via
 * textResult and the MCP client sees both what failed and how close we are
 * to braking. State is always written: either the successful next state, or
 * the recordFailure-augmented state with the failure logged.
 */
function runMcpTool<TPayload>(
  projectRoot: string,
  fn: (state: DuoState) => { state: DuoState; result: TPayload }
): TPayload | { error: string; failureCount: number; brake: DuoState["brake"] } {
  return withLockedState(projectRoot, (current) => {
    try {
      return fn(current);
    } catch (error) {
      const message = (error as Error).message;
      const failed = recordFailure(current, message);
      return {
        state: failed,
        result: {
          error: message,
          failureCount: failed.failureCount,
          brake: failed.brake
        } as TPayload
      };
    }
  });
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
