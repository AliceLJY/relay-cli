import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { DuoEvent, DuoState, HumanRequest } from "./types.js";
import { nowIso, shortId } from "./ids.js";

export const DEFAULT_LIMITS = {
  maxDepth: 2,
  maxFailures: 3,
  spawnTimeoutMs: 5 * 60 * 1000
} as const;

export function projectRootFrom(cwd = process.cwd()): string {
  return resolve(cwd);
}

export function duoDir(projectRoot = projectRootFrom()): string {
  return process.env.DUO_DIR ? resolve(process.env.DUO_DIR) : join(projectRoot, ".duo");
}

export function statePath(projectRoot = projectRootFrom()): string {
  return join(duoDir(projectRoot), "state.json");
}

export function defaultState(projectRoot = projectRootFrom()): DuoState {
  return {
    version: 1,
    projectRoot,
    limits: { ...DEFAULT_LIMITS },
    processes: {},
    humanRequests: {},
    events: [],
    failureCount: 0,
    updatedAt: nowIso()
  };
}

export function readState(projectRoot = projectRootFrom()): DuoState {
  const path = statePath(projectRoot);
  try {
    return JSON.parse(readFileSync(path, "utf8")) as DuoState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return defaultState(projectRoot);
    }
    throw error;
  }
}

export function writeState(state: DuoState): void {
  const path = statePath(state.projectRoot);
  mkdirSync(dirname(path), { recursive: true });
  const next: DuoState = { ...state, updatedAt: nowIso() };
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

export function appendEvent(
  state: DuoState,
  type: string,
  message: string,
  processId?: string
): DuoState {
  const event: DuoEvent = {
    id: shortId("evt"),
    type,
    message,
    processId,
    createdAt: nowIso()
  };
  return {
    ...state,
    events: [...state.events, event].slice(-100)
  };
}

export function setBrake(
  state: DuoState,
  reason: string,
  createdBy: "human" | "agent" | "system"
): DuoState {
  return appendEvent(
    {
      ...state,
      brake: {
        active: true,
        reason,
        createdBy,
        createdAt: nowIso()
      }
    },
    "brake",
    reason
  );
}

export function clearBrake(state: DuoState, instruction: string): DuoState {
  return appendEvent(
    {
      ...state,
      brake: undefined
    },
    "resume",
    instruction || "resumed without additional instruction"
  );
}

export function addHumanRequest(
  state: DuoState,
  request: Omit<HumanRequest, "id" | "status" | "createdAt">
): { state: DuoState; request: HumanRequest } {
  const nextRequest: HumanRequest = {
    ...request,
    id: shortId("human"),
    status: "pending",
    createdAt: nowIso()
  };
  const nextState = setBrake(
    {
      ...state,
      humanRequests: {
        ...state.humanRequests,
        [nextRequest.id]: nextRequest
      }
    },
    `need_human: ${request.reason}`,
    "agent"
  );
  return { state: nextState, request: nextRequest };
}

export function answerLatestHumanRequest(state: DuoState, response: string): DuoState {
  const pending = Object.values(state.humanRequests)
    .filter((request) => request.status === "pending")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];

  if (!pending) {
    return clearBrake(state, response);
  }

  const answered: HumanRequest = {
    ...pending,
    status: "answered",
    response,
    answeredAt: nowIso()
  };

  return clearBrake(
    {
      ...state,
      humanRequests: {
        ...state.humanRequests,
        [answered.id]: answered
      }
    },
    response
  );
}

export function recordFailure(state: DuoState, message: string, processId?: string): DuoState {
  const failureCount = state.failureCount + 1;
  const withEvent = appendEvent(
    {
      ...state,
      failureCount
    },
    "failure",
    message,
    processId
  );

  if (failureCount >= state.limits.maxFailures) {
    return setBrake(withEvent, `failure limit reached: ${message}`, "system");
  }

  return withEvent;
}

export function assertNotBraked(state: DuoState): void {
  if (state.brake?.active) {
    throw new Error(`duo is braked: ${state.brake.reason}`);
  }
}

export function latestEvents(state: DuoState, count: number): DuoEvent[] {
  return state.events.slice(Math.max(0, state.events.length - count));
}
