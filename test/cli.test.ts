import test from "node:test";
import "./test-env.js";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));

test("duo help only exposes the small human command surface", () => {
  const stdout = execFileSync(process.execPath, [CLI_PATH, "--help"], {
    encoding: "utf8"
  });

  assert.match(stdout, /\bstart\b/);
  assert.match(stdout, /\blist\b/);
  assert.match(stdout, /\bshow\b/);
  assert.match(stdout, /\bwatch\b/);

  const commandBlock = stdout.split("Commands:")[1] || "";

  for (const removed of [
    "status",
    "enter",
    "brake",
    "resume",
    "abort",
    "runtimes",
    "spawn",
    "pair",
    "send",
    "output",
    "cancel",
    "close",
    "mcp"
  ]) {
    assert.doesNotMatch(commandBlock, new RegExp(`\\b${removed}\\b`));
  }
});

test("duo watch exposes no tuning options", () => {
  const stdout = execFileSync(process.execPath, [CLI_PATH, "watch", "--help"], {
    encoding: "utf8"
  });

  assert.doesNotMatch(stdout, /--all/);
  assert.doesNotMatch(stdout, /--once/);
  assert.doesNotMatch(stdout, /--layout/);
  assert.doesNotMatch(stdout, /--recent-seconds/);
  assert.doesNotMatch(stdout, /--lines/);
});

test("duo mcp stays hidden but callable as internal plumbing", () => {
  const rootHelp = execFileSync(process.execPath, [CLI_PATH, "--help"], {
    encoding: "utf8"
  });
  assert.doesNotMatch(rootHelp.split("Commands:")[1] || "", /\bmcp\b/);

  const mcpHelp = execFileSync(process.execPath, [CLI_PATH, "mcp", "--help"], {
    encoding: "utf8"
  });
  assert.match(mcpHelp, /Run the duo MCP server over stdio/);
});

test("duo list shows active parent agents only", () => {
  const root = mkdtempSync(join(tmpdir(), "duo-cli-list-"));
  const duoDir = join(root, ".duo");
  mkdirSync(duoDir);
  writeState(root, {
    proc_active_parent: {
      id: "proc_active_parent",
      runtime: "codex",
      name: "parent-codex",
      status: "running",
      depth: 1,
      tmuxSession: "active",
      cwd: root,
      createdAt: "2026-04-24T00:00:00.000Z",
      updatedAt: "2026-04-24T00:00:00.000Z",
      failureCount: 0
    },
    proc_child: {
      id: "proc_child",
      runtime: "claude",
      name: "child-claude",
      status: "running",
      parentId: "proc_active_parent",
      depth: 2,
      tmuxSession: "child",
      cwd: root,
      createdAt: "2026-04-24T00:00:01.000Z",
      updatedAt: "2026-04-24T00:00:01.000Z",
      failureCount: 0
    },
    proc_closed_parent: {
      id: "proc_closed_parent",
      runtime: "claude",
      name: "parent-claude",
      status: "closed",
      depth: 1,
      tmuxSession: "closed",
      cwd: root,
      createdAt: "2026-04-24T00:00:02.000Z",
      updatedAt: "2026-04-24T00:00:02.000Z",
      failureCount: 0
    }
  });

  const stdout = execFileSync(process.execPath, [CLI_PATH, "-C", root, "list"], {
    cwd: root,
    encoding: "utf8"
  });

  assert.match(stdout, /proc_active_parent/);
  assert.match(stdout, /parent-codex/);
  assert.doesNotMatch(stdout, /proc_child/);
  assert.doesNotMatch(stdout, /proc_closed_parent/);
});

test("explicit -C ignores inherited DUO_DIR", () => {
  const root = mkdtempSync(join(tmpdir(), "duo-cli-cwd-"));
  const inherited = mkdtempSync(join(tmpdir(), "duo-cli-inherited-dir-"));

  writeState(root, {
    proc_active_parent: {
      id: "proc_active_parent",
      runtime: "codex",
      name: "parent-codex",
      status: "running",
      depth: 1,
      tmuxSession: "active",
      cwd: root,
      createdAt: "2026-04-24T00:00:00.000Z",
      updatedAt: "2026-04-24T00:00:00.000Z",
      failureCount: 0
    }
  });
  writeState(inherited, {});

  const stdout = execFileSync(process.execPath, [CLI_PATH, "-C", root, "list"], {
    cwd: root,
    env: {
      ...process.env,
      DUO_DIR: join(inherited, ".duo")
    },
    encoding: "utf8"
  });

  assert.match(stdout, /proc_active_parent/);
  assert.match(stdout, /parent-codex/);
});

test("duo start --parent spawns one chosen parent and attaches", () => {
  const root = mkdtempSync(join(tmpdir(), "duo-cli-start-"));
  const binDir = join(root, "bin");
  mkdirSync(binDir);

  const tmuxLog = join(root, "tmux.log");
  writeExecutable(
    join(binDir, "tmux"),
    `#!/usr/bin/env sh
printf '%s\n' "$*" >> "${tmuxLog}"
exit 0
`
  );
  writeExecutable(join(binDir, "codex"), "#!/usr/bin/env sh\nexit 0\n");

  execFileSync(
    process.execPath,
    [CLI_PATH, "-C", root, "start", "--parent", "codex", "implement", "child", "handoff"],
    {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH || ""}`
      },
      encoding: "utf8"
    }
  );

  const state = JSON.parse(readFileSync(join(root, ".duo", "state.json"), "utf8")) as {
    processes: Record<string, { runtime: string; name: string; status: string; depth: number; parentId?: string }>;
  };
  const processes = Object.values(state.processes);
  assert.equal(processes.length, 1);
  assert.equal(processes[0].runtime, "codex");
  assert.equal(processes[0].name, "parent-codex");
  assert.equal(processes[0].status, "running");
  assert.equal(processes[0].depth, 1);
  assert.equal(processes[0].parentId, undefined);

  const tmuxCalls = readFileSync(tmuxLog, "utf8");
  assert.match(tmuxCalls, /new-session -d/);
  assert.match(tmuxCalls, /attach-session -t/);
  assert.match(tmuxCalls, /DUO_RUNTIME=codex\./);
  assert.match(tmuxCalls, /Task: implement child handoff/);
});

test("duo start clears stale running parents so applyRuntimeLimits cannot re-brake", () => {
  const root = mkdtempSync(join(tmpdir(), "duo-cli-stale-"));
  const binDir = join(root, "bin");
  mkdirSync(binDir);
  writeExecutable(join(binDir, "tmux"), "#!/usr/bin/env sh\nexit 0\n");
  writeExecutable(join(binDir, "codex"), "#!/usr/bin/env sh\nexit 0\n");

  const staleAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  writeState(root, {
    proc_stale: {
      id: "proc_stale",
      runtime: "claude",
      name: "parent-claude",
      status: "running",
      depth: 1,
      tmuxSession: "duo_claude_dead",
      cwd: root,
      createdAt: staleAt,
      updatedAt: staleAt,
      lastOutputAt: staleAt,
      failureCount: 0
    }
  }, staleAt);

  execFileSync(process.execPath, [CLI_PATH, "-C", root, "start", "--parent", "codex", "fresh"], {
    cwd: root,
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH || ""}` },
    encoding: "utf8"
  });

  const after = JSON.parse(readFileSync(join(root, ".duo", "state.json"), "utf8")) as {
    brake?: { active?: boolean };
    processes: Record<string, { name: string; status: string }>;
  };
  assert.ok(!after.brake?.active, `unexpected brake set: ${JSON.stringify(after.brake)}`);
  assert.equal(after.processes.proc_stale.status, "closed");
  const fresh = Object.values(after.processes).filter((p) => p.name === "parent-codex");
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].status, "running");
});

test("duo start does not inherit parent from DUO_PROCESS_ID env", () => {
  const root = mkdtempSync(join(tmpdir(), "duo-cli-start-no-inherit-"));
  const binDir = join(root, "bin");
  mkdirSync(binDir);
  writeExecutable(join(binDir, "tmux"), "#!/usr/bin/env sh\nexit 0\n");
  writeExecutable(join(binDir, "codex"), "#!/usr/bin/env sh\nexit 0\n");

  writeState(root, {
    proc_seed: {
      id: "proc_seed",
      runtime: "codex",
      name: "seed-codex",
      status: "running",
      depth: 1,
      tmuxSession: "seed",
      cwd: root,
      createdAt: "2026-04-24T00:00:00.000Z",
      updatedAt: "2026-04-24T00:00:00.000Z",
      failureCount: 0
    }
  });

  execFileSync(process.execPath, [CLI_PATH, "-C", root, "start", "--parent", "codex", "task"], {
    cwd: root,
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH || ""}`, DUO_PROCESS_ID: "proc_seed" },
    encoding: "utf8"
  });

  const state = JSON.parse(readFileSync(join(root, ".duo", "state.json"), "utf8")) as {
    processes: Record<string, { name: string; depth: number; parentId?: string }>;
  };
  const started = Object.values(state.processes).find((p) => p.name === "parent-codex" && p !== state.processes.proc_seed);
  assert.ok(started);
  assert.equal(started.depth, 1);
  assert.equal(started.parentId, undefined);
});

function writeState(
  root: string,
  processes: Record<string, unknown>,
  updatedAt = "2026-04-24T00:00:00.000Z"
): void {
  const duoDir = join(root, ".duo");
  mkdirSync(duoDir, { recursive: true });
  writeFileSync(
    join(duoDir, "state.json"),
    JSON.stringify(
      {
        version: 1,
        projectRoot: root,
        limits: { maxDepth: 2, maxFailures: 3, spawnTimeoutMs: 300000, idleTimeoutMs: 1800000 },
        processes,
        humanRequests: {},
        events: [],
        failureCount: 0,
        updatedAt
      },
      null,
      2
    ),
    "utf8"
  );
}

function writeExecutable(path: string, content: string): void {
  writeFileSync(path, content, "utf8");
  chmodSync(path, 0o755);
}
