export type RuntimeName = "codex" | "claude";

export type ProcessStatus =
  | "running"
  | "blocked"
  | "cancelled"
  | "closed"
  | "failed"
  | "aborted";

export type HumanUrgency = "low" | "normal" | "high";

export interface DuoLimits {
  maxDepth: number;
  maxFailures: number;
  spawnTimeoutMs: number;
}

export interface BrakeState {
  active: boolean;
  reason: string;
  createdAt: string;
  createdBy: "human" | "agent" | "system";
}

export interface DuoProcess {
  id: string;
  runtime: RuntimeName;
  name: string;
  status: ProcessStatus;
  parentId?: string;
  depth: number;
  tmuxSession: string;
  cwd: string;
  pid?: number;
  createdAt: string;
  updatedAt: string;
  lastOutputAt?: string;
  failureCount: number;
}

export interface DuoEvent {
  id: string;
  type: string;
  message: string;
  createdAt: string;
  processId?: string;
}

export interface HumanRequest {
  id: string;
  reason: string;
  question: string;
  urgency: HumanUrgency;
  options: string[];
  recommended?: string;
  status: "pending" | "answered" | "cancelled" | "timed_out";
  response?: string;
  createdAt: string;
  answeredAt?: string;
}

export interface DuoState {
  version: 1;
  projectRoot: string;
  brake?: BrakeState;
  limits: DuoLimits;
  processes: Record<string, DuoProcess>;
  humanRequests: Record<string, HumanRequest>;
  events: DuoEvent[];
  failureCount: number;
  updatedAt: string;
}

export interface RuntimeInfo {
  name: RuntimeName;
  command: string;
  args: string[];
  available: boolean;
  configuredCommand?: string;
  resolvedPath?: string;
  health?: RuntimeHealth;
}

export interface RuntimeHealth {
  checkedAt: string;
  ok: boolean;
  message: string;
}
