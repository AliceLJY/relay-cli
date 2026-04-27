import test from "node:test";
import "./test-env.js";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultState } from "../src/state.js";
import {
  applyRuntimeLimits,
  cancelAgent,
  closeProcess,
  closeAllProcesses,
  parseClaudeAuthStatus,
  previewInputForEvent,
  getOutput,
  resolveCommand,
  resolveParentId,
  sendInput,
  spawnAgent
} from "../src/runtime.js";

test("resolveCommand finds executable fallback paths outside PATH", () => {
  const root = mkdtempSync(join(tmpdir(), "duo-runtime-"));
  const executable = join(root, "duo_fake_agent");
  writeFileSync(executable, "#!/usr/bin/env sh\nprintf ok\n", "utf8");
  chmodSync(executable, 0o755);

  assert.equal(resolveCommand("duo_fake_agent", [root]), executable);
});

test("parseClaudeAuthStatus reads Claude auth JSON output", () => {
  assert.deepEqual(parseClaudeAuthStatus('{"loggedIn":false,"authMethod":"none"}'), {
    loggedIn: false
  });
  assert.deepEqual(parseClaudeAuthStatus('{"loggedIn":true,"authMethod":"oauth"}'), {
    loggedIn: true
  });
  assert.equal(parseClaudeAuthStatus("not json"), undefined);
});

test("previewInputForEvent collapses whitespace and truncates long payloads", () => {
  assert.equal(previewInputForEvent("  alpha\n beta\tgamma  "), "alpha beta gamma");
  assert.equal(previewInputForEvent("   \n\t "), "[empty input]");
  assert.equal(previewInputForEvent("abcdefghijk", 10), "abcdefg...");
});

test("sendInput stores a readable payload preview in events", () => {
  const root = mkdtempSync(join(tmpdir(), "duo-send-input-"));
  const binDir = join(root, "bin");
  mkdirSync(binDir);
  const tmuxStub = join(binDir, "tmux");
  writeFileSync(tmuxStub, "#!/usr/bin/env sh\nexit 0\n", "utf8");
  chmodSync(tmuxStub, 0o755);

  const previousPath = process.env.PATH || "";
  process.env.PATH = `${binDir}:${previousPath}`;

  try {
    const state = defaultState(root);
    state.processes.proc_demo = {
      id: "proc_demo",
      runtime: "claude",
      name: "demo process",
      status: "running",
      depth: 1,
      tmuxSession: "demo",
      cwd: root,
      createdAt: "2026-04-24T00:00:00.000Z",
      updatedAt: "2026-04-24T00:00:00.000Z",
      failureCount: 0
    };

    const next = sendInput(state, "proc_demo", "  first line\nsecond line  ");
    assert.equal(next.events.at(-1)?.type, "send_input");
    assert.equal(next.events.at(-1)?.message, "sent input: first line second line");
  } finally {
    process.env.PATH = previousPath;
  }
});

test("spawnAgent injects duo environment into tmux new-session", () => {
  const root = mkdtempSync(join(tmpdir(), "duo-spawn-agent-"));
  const binDir = join(root, "bin");
  mkdirSync(binDir);
  const tmuxStub = join(binDir, "tmux");
  const claudeStub = join(binDir, "claude");
  const tmuxArgsFile = join(root, "tmux-args.txt");

  writeFileSync(tmuxStub, `#!/usr/bin/env sh\nprintf '%s\n' "$@" > "${tmuxArgsFile}"\nexit 0\n`, "utf8");
  writeFileSync(claudeStub, "#!/usr/bin/env sh\nexit 0\n", "utf8");
  chmodSync(tmuxStub, 0o755);
  chmodSync(claudeStub, 0o755);

  const previousPath = process.env.PATH || "";
  const previousClaudeCmd = process.env.DUO_CLAUDE_CMD;
  process.env.PATH = `${binDir}:${previousPath}`;
  delete process.env.DUO_CLAUDE_CMD;

  try {
    const state = defaultState(root);
    spawnAgent(state, {
      runtime: "claude",
      prompt: "inspect relay",
      cwd: root
    });

    const tmuxArgs = readFileSync(tmuxArgsFile, "utf8");
    assert.match(tmuxArgs, /\n-e\nDUO_PROCESS_ID=proc_[a-z0-9]+\n/);
    assert.match(tmuxArgs, /\n-e\nDUO_RUNTIME=claude\n/);
    assert.match(tmuxArgs, /\n-e\nDUO_DEPTH=1\n/);
    assert.match(tmuxArgs, /parent agent inside duo/);
    assert.match(tmuxArgs, /actively duo the other runtime/);
    assert.match(tmuxArgs, /routine part of the loop/);
    assert.match(tmuxArgs, /do not hand off the entire parent task/);
  } finally {
    process.env.PATH = previousPath;
    if (previousClaudeCmd === undefined) {
      delete process.env.DUO_CLAUDE_CMD;
    } else {
      process.env.DUO_CLAUDE_CMD = previousClaudeCmd;
    }
  }
});

test("spawnAgent gives scoped child agents child-only guidance", () => {
  const root = mkdtempSync(join(tmpdir(), "duo-spawn-child-agent-"));
  const binDir = join(root, "bin");
  mkdirSync(binDir);
  const tmuxStub = join(binDir, "tmux");
  const claudeStub = join(binDir, "claude");
  const tmuxArgsFile = join(root, "tmux-args.txt");

  writeFileSync(tmuxStub, `#!/usr/bin/env sh\nprintf '%s\n' "$@" > "${tmuxArgsFile}"\nexit 0\n`, "utf8");
  writeFileSync(claudeStub, "#!/usr/bin/env sh\nexit 0\n", "utf8");
  chmodSync(tmuxStub, 0o755);
  chmodSync(claudeStub, 0o755);

  const previousPath = process.env.PATH || "";
  const previousClaudeCmd = process.env.DUO_CLAUDE_CMD;
  process.env.PATH = `${binDir}:${previousPath}`;
  delete process.env.DUO_CLAUDE_CMD;

  try {
    const state = defaultState(root);
    state.processes.proc_parent = makeIdleProcess("proc_parent", {
      runtime: "codex",
      status: "running",
      depth: 1
    });

    spawnAgent(state, {
      runtime: "claude",
      parentId: "proc_parent",
      prompt: "review the runtime intro only",
      cwd: root
    });

    const tmuxArgs = readFileSync(tmuxArgsFile, "utf8");
    assert.match(tmuxArgs, /\n-e\nDUO_DEPTH=2\n/);
    assert.match(tmuxArgs, /scoped child agent inside duo/);
    assert.match(tmuxArgs, /do not spawn further child agents/);
    assert.doesNotMatch(tmuxArgs, /parent agent inside duo/);
    assert.doesNotMatch(tmuxArgs, /actively duo the other runtime/);
    assert.doesNotMatch(tmuxArgs, /routine part of the loop/);
    assert.doesNotMatch(tmuxArgs, /do not hand off the entire parent task/);
  } finally {
    process.env.PATH = previousPath;
    if (previousClaudeCmd === undefined) {
      delete process.env.DUO_CLAUDE_CMD;
    } else {
      process.env.DUO_CLAUDE_CMD = previousClaudeCmd;
    }
  }
});

test("spawnAgent injects bypassSandbox flags for codex when requested", () => {
  const root = mkdtempSync(join(tmpdir(), "duo-spawn-codex-bypass-"));
  const binDir = join(root, "bin");
  mkdirSync(binDir);
  const tmuxArgsFile = join(root, "tmux-args.txt");
  writeExecutable(join(binDir, "tmux"), `#!/usr/bin/env sh\nprintf '%s\n' "$@" > "${tmuxArgsFile}"\nexit 0\n`);
  writeExecutable(join(binDir, "codex"), "#!/usr/bin/env sh\nexit 0\n");

  const previousPath = process.env.PATH || "";
  const previousCodexCmd = process.env.DUO_CODEX_CMD;
  process.env.PATH = `${binDir}:${previousPath}`;
  delete process.env.DUO_CODEX_CMD;

  try {
    const state = defaultState(root);
    spawnAgent(state, {
      runtime: "codex",
      prompt: "write files",
      cwd: root,
      bypassSandbox: true
    });

    const shellCommand = lastTmuxArg(tmuxArgsFile);
    assert.match(shellCommand, /(?:^|\/)codex exec --dangerously-bypass-approvals-and-sandbox /);
  } finally {
    process.env.PATH = previousPath;
    if (previousCodexCmd === undefined) {
      delete process.env.DUO_CODEX_CMD;
    } else {
      process.env.DUO_CODEX_CMD = previousCodexCmd;
    }
  }
});

test("spawnAgent does not inject bypassSandbox flags for codex by default", () => {
  const root = mkdtempSync(join(tmpdir(), "duo-spawn-codex-default-"));
  const binDir = join(root, "bin");
  mkdirSync(binDir);
  const tmuxArgsFile = join(root, "tmux-args.txt");
  writeExecutable(join(binDir, "tmux"), `#!/usr/bin/env sh\nprintf '%s\n' "$@" > "${tmuxArgsFile}"\nexit 0\n`);
  writeExecutable(join(binDir, "codex"), "#!/usr/bin/env sh\nexit 0\n");

  const previousPath = process.env.PATH || "";
  const previousCodexCmd = process.env.DUO_CODEX_CMD;
  process.env.PATH = `${binDir}:${previousPath}`;
  delete process.env.DUO_CODEX_CMD;

  try {
    const state = defaultState(root);
    spawnAgent(state, {
      runtime: "codex",
      prompt: "inspect only",
      cwd: root
    });

    const shellCommand = lastTmuxArg(tmuxArgsFile);
    assert.match(shellCommand, /(?:^|\/)codex /);
    assert.doesNotMatch(shellCommand, /--dangerously-bypass-approvals-and-sandbox/);
  } finally {
    process.env.PATH = previousPath;
    if (previousCodexCmd === undefined) {
      delete process.env.DUO_CODEX_CMD;
    } else {
      process.env.DUO_CODEX_CMD = previousCodexCmd;
    }
  }
});

test("spawnAgent ignores bypassSandbox flags for claude", () => {
  const root = mkdtempSync(join(tmpdir(), "duo-spawn-claude-bypass-"));
  const binDir = join(root, "bin");
  mkdirSync(binDir);
  const tmuxArgsFile = join(root, "tmux-args.txt");
  writeExecutable(join(binDir, "tmux"), `#!/usr/bin/env sh\nprintf '%s\n' "$@" > "${tmuxArgsFile}"\nexit 0\n`);
  writeExecutable(join(binDir, "claude"), "#!/usr/bin/env sh\nexit 0\n");

  const previousPath = process.env.PATH || "";
  const previousClaudeCmd = process.env.DUO_CLAUDE_CMD;
  process.env.PATH = `${binDir}:${previousPath}`;
  delete process.env.DUO_CLAUDE_CMD;

  try {
    const state = defaultState(root);
    spawnAgent(state, {
      runtime: "claude",
      prompt: "inspect only",
      cwd: root,
      bypassSandbox: true
    });

    const shellCommand = lastTmuxArg(tmuxArgsFile);
    assert.match(shellCommand, /(?:^|\/)claude /);
    assert.doesNotMatch(shellCommand, /--dangerously-bypass-approvals-and-sandbox/);
    assert.doesNotMatch(shellCommand, /\bexec\b/);
  } finally {
    process.env.PATH = previousPath;
    if (previousClaudeCmd === undefined) {
      delete process.env.DUO_CLAUDE_CMD;
    } else {
      process.env.DUO_CLAUDE_CMD = previousClaudeCmd;
    }
  }
});

test("closeAllProcesses aborts active processes only", () => {
  const root = mkdtempSync(join(tmpdir(), "duo-close-all-"));
  const binDir = join(root, "bin");
  mkdirSync(binDir);
  writeExecutable(join(binDir, "tmux"), "#!/usr/bin/env sh\nexit 0\n");

  const previousPath = process.env.PATH || "";
  process.env.PATH = `${binDir}:${previousPath}`;

  try {
    const state = defaultState(root);
    state.processes.proc_running = makeIdleProcess("proc_running", { status: "running" });
    state.processes.proc_blocked = makeIdleProcess("proc_blocked", { status: "blocked" });
    state.processes.proc_closed = makeIdleProcess("proc_closed", { status: "closed" });

    const next = closeAllProcesses(state);

    assert.equal(next.processes.proc_running.status, "aborted");
    assert.equal(next.processes.proc_blocked.status, "aborted");
    assert.equal(next.processes.proc_closed.status, "closed");
    assert.equal(next.events.filter((event) => event.type === "aborted").length, 2);
  } finally {
    process.env.PATH = previousPath;
  }
});

test("getOutput captures tmux pane output and records observation time", () => {
  const root = mkdtempSync(join(tmpdir(), "duo-get-output-"));
  const binDir = join(root, "bin");
  mkdirSync(binDir);
  writeExecutable(join(binDir, "tmux"), "#!/usr/bin/env sh\nprintf 'READY\\n'\nexit 0\n");

  const previousPath = process.env.PATH || "";
  process.env.PATH = `${binDir}:${previousPath}`;

  try {
    const state = defaultState(root);
    state.processes.proc_demo = makeIdleProcess("proc_demo", { status: "running" });

    const result = getOutput(state, "proc_demo", 20);

    assert.equal(result.output, "READY\n");
    assert.ok(result.state.processes.proc_demo.lastOutputAt);
    assert.equal(result.state.processes.proc_demo.status, "running");
  } finally {
    process.env.PATH = previousPath;
  }
});

function makeIdleProcess(id: string, overrides: Partial<import("../src/types.js").DuoProcess> = {}) {
  const staleAt = new Date(Date.now() - 45 * 60 * 1000).toISOString();
  return {
    id,
    runtime: "claude" as const,
    name: id,
    status: "running" as const,
    depth: 1,
    tmuxSession: `tmux_${id}`,
    cwd: "/tmp",
    createdAt: staleAt,
    updatedAt: staleAt,
    lastOutputAt: staleAt,
    failureCount: 0,
    ...overrides
  };
}

function lastTmuxArg(path: string): string {
  const args = readFileSync(path, "utf8").trimEnd().split("\n");
  return args.at(-1) || "";
}

function writeExecutable(path: string, content: string): void {
  writeFileSync(path, content, "utf8");
  chmodSync(path, 0o755);
}

test("applyRuntimeLimits does not brake a parent while its child is still active", () => {
  const root = mkdtempSync(join(tmpdir(), "duo-idle-parent-"));
  const state = defaultState(root);
  state.processes["proc_parent"] = makeIdleProcess("proc_parent");
  state.processes["proc_child"] = makeIdleProcess("proc_child", {
    parentId: "proc_parent",
    depth: 2,
    status: "running",
    lastOutputAt: new Date().toISOString()
  });

  const result = applyRuntimeLimits(state);
  assert.equal(result.brake?.active, undefined);
  assert.equal(result.processes["proc_parent"].status, "running");
});

test("applyRuntimeLimits treats a recently finished child as parent activity", () => {
  const root = mkdtempSync(join(tmpdir(), "duo-recent-child-"));
  const state = defaultState(root);
  state.processes["proc_parent"] = makeIdleProcess("proc_parent");
  state.processes["proc_child"] = makeIdleProcess("proc_child", {
    parentId: "proc_parent",
    depth: 2,
    status: "closed",
    lastOutputAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });

  const result = applyRuntimeLimits(state);
  assert.equal(result.brake?.active, undefined);
  assert.equal(result.processes["proc_parent"].status, "running");
});

test("applyRuntimeLimits propagates descendant activity to ancestors", () => {
  const root = mkdtempSync(join(tmpdir(), "duo-descendant-activity-"));
  const state = defaultState(root);
  state.processes["proc_grandparent"] = makeIdleProcess("proc_grandparent");
  state.processes["proc_parent"] = makeIdleProcess("proc_parent", {
    parentId: "proc_grandparent",
    depth: 2,
    status: "closed"
  });
  state.processes["proc_child"] = makeIdleProcess("proc_child", {
    parentId: "proc_parent",
    depth: 3,
    status: "running",
    lastOutputAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });

  const result = applyRuntimeLimits(state);
  assert.equal(result.brake?.active, undefined);
  assert.equal(result.processes["proc_grandparent"].status, "running");
});

test("applyRuntimeLimits does not brake while a human request is pending", () => {
  const root = mkdtempSync(join(tmpdir(), "duo-idle-human-"));
  const state = defaultState(root);
  state.processes["proc_waiter"] = makeIdleProcess("proc_waiter");
  state.humanRequests["h1"] = {
    id: "h1",
    reason: "need direction",
    question: "which way?",
    urgency: "normal",
    options: [],
    status: "pending",
    createdAt: new Date().toISOString()
  };

  const result = applyRuntimeLimits(state);
  assert.equal(result.brake?.active, undefined);
});

test("resolveParentId returns undefined when no explicit and no env fallback", () => {
  const root = mkdtempSync(join(tmpdir(), "duo-resolve-none-"));
  const state = defaultState(root);
  const prev = process.env.DUO_PROCESS_ID;
  delete process.env.DUO_PROCESS_ID;
  try {
    assert.equal(resolveParentId(state, {}), undefined);
    assert.equal(resolveParentId(state, { envFallback: true }), undefined);
  } finally {
    if (prev !== undefined) process.env.DUO_PROCESS_ID = prev;
  }
});

test("resolveParentId requires a parent when requested", () => {
  const root = mkdtempSync(join(tmpdir(), "duo-resolve-required-none-"));
  const state = defaultState(root);
  const prev = process.env.DUO_PROCESS_ID;
  delete process.env.DUO_PROCESS_ID;
  try {
    assert.throws(
      () => resolveParentId(state, { envFallback: true, requireParent: true }),
      /parentId is required/
    );
  } finally {
    if (prev !== undefined) process.env.DUO_PROCESS_ID = prev;
  }
});

test("resolveParentId falls back to orphan and warns when explicit parent is unknown", () => {
  const root = mkdtempSync(join(tmpdir(), "duo-resolve-explicit-ghost-"));
  const state = defaultState(root);
  assert.equal(resolveParentId(state, { explicit: "proc_ghost" }), undefined);
});

test("resolveParentId rejects unknown parent when required", () => {
  const root = mkdtempSync(join(tmpdir(), "duo-resolve-required-ghost-"));
  const state = defaultState(root);
  assert.throws(
    () => resolveParentId(state, { explicit: "proc_ghost", requireParent: true }),
    /refusing to spawn as orphan/
  );
});

test("resolveParentId returns the id when parent exists in state", () => {
  const root = mkdtempSync(join(tmpdir(), "duo-resolve-happy-"));
  const state = defaultState(root);
  state.processes["proc_seed"] = makeIdleProcess("proc_seed", { status: "running" });
  assert.equal(resolveParentId(state, { explicit: "proc_seed" }), "proc_seed");
});

test("cancelAgent records an event when tmux send-keys fails but still marks cancelled", () => {
  const root = mkdtempSync(join(tmpdir(), "duo-cancel-tmux-fail-"));
  const binDir = join(root, "bin");
  mkdirSync(binDir);
  writeFileSync(join(binDir, "tmux"), "#!/usr/bin/env sh\nexit 1\n", "utf8");
  chmodSync(join(binDir, "tmux"), 0o755);
  const prevPath = process.env.PATH || "";
  process.env.PATH = `${binDir}:${prevPath}`;
  try {
    const state = defaultState(root);
    state.processes["proc_tgt"] = makeIdleProcess("proc_tgt", { status: "running" });
    const next = cancelAgent(state, "proc_tgt");
    assert.equal(next.processes["proc_tgt"].status, "cancelled");
    assert.ok(next.events.some((event) => event.type === "tmux_cancel_failed"));
  } finally {
    process.env.PATH = prevPath;
  }
});

test("closeProcess records an event when tmux kill-session fails but still marks closed", () => {
  const root = mkdtempSync(join(tmpdir(), "duo-close-tmux-fail-"));
  const binDir = join(root, "bin");
  mkdirSync(binDir);
  writeFileSync(join(binDir, "tmux"), "#!/usr/bin/env sh\nexit 1\n", "utf8");
  chmodSync(join(binDir, "tmux"), 0o755);
  const prevPath = process.env.PATH || "";
  process.env.PATH = `${binDir}:${prevPath}`;
  try {
    const state = defaultState(root);
    state.processes["proc_tgt"] = makeIdleProcess("proc_tgt", { status: "running" });
    const next = closeProcess(state, "proc_tgt");
    assert.equal(next.processes["proc_tgt"].status, "closed");
    assert.ok(next.events.some((event) => event.type === "tmux_close_failed"));
  } finally {
    process.env.PATH = prevPath;
  }
});

test("applyRuntimeLimits brakes an idle process when no child and no pending human", () => {
  const root = mkdtempSync(join(tmpdir(), "duo-idle-lone-"));
  const state = defaultState(root);
  state.processes["proc_alone"] = makeIdleProcess("proc_alone");

  const result = applyRuntimeLimits(state);
  assert.equal(result.brake?.active, true);
  assert.match(result.brake?.reason || "", /process timeout: proc_alone/);
  assert.equal(result.processes["proc_alone"].status, "blocked");
});
