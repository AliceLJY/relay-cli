import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));

test("duo pair starts codex and claude from one shared prompt", () => {
  const root = mkdtempSync(join(tmpdir(), "duo-cli-pair-"));
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
  writeExecutable(join(binDir, "claude"), "#!/usr/bin/env sh\nexit 0\n");

  const pathEnv = `${binDir}:${process.env.PATH || ""}`;
  const stdout = execFileSync(
    process.execPath,
    [CLI_PATH, "-C", root, "pair", "--no-watch", "align", "status"],
    {
      cwd: root,
      env: {
        ...process.env,
        PATH: pathEnv
      },
      encoding: "utf8"
    }
  );

  const state = JSON.parse(readFileSync(join(root, ".duo", "state.json"), "utf8")) as {
    processes: Record<string, { runtime: string; name: string; status: string }>;
  };
  const processes = Object.values(state.processes);
  assert.equal(processes.length, 2);
  assert.deepEqual(
    processes.map((processRecord) => processRecord.name).sort(),
    ["pair-claude", "pair-codex"]
  );
  assert.deepEqual(
    processes.map((processRecord) => processRecord.runtime).sort(),
    ["claude", "codex"]
  );
  assert.ok(processes.every((processRecord) => processRecord.status === "running"));
  assert.match(stdout, /pair-codex/);
  assert.match(stdout, /pair-claude/);

  const tmuxCalls = readFileSync(tmuxLog, "utf8");
  assert.match(tmuxCalls, /DUO_RUNTIME=codex\./);
  assert.match(tmuxCalls, /DUO_RUNTIME=claude\./);
  assert.match(tmuxCalls, /Task: align status/);
});

test("duo start --parent spawns one chosen parent without attaching when requested", () => {
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

  const stdout = execFileSync(
    process.execPath,
    [CLI_PATH, "-C", root, "start", "--parent", "codex", "--no-attach", "implement", "child", "handoff"],
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
  assert.match(stdout, /parent-codex/);

  const tmuxCalls = readFileSync(tmuxLog, "utf8");
  assert.match(tmuxCalls, /new-session -d/);
  assert.doesNotMatch(tmuxCalls, /attach-session/);
  assert.match(tmuxCalls, /DUO_RUNTIME=codex\./);
  assert.match(tmuxCalls, /Task: implement child handoff/);
});

test("duo spawn inherits parentId from DUO_PROCESS_ID env when caller is registered", () => {
  const root = mkdtempSync(join(tmpdir(), "duo-cli-spawn-env-"));
  const binDir = join(root, "bin");
  mkdirSync(binDir);
  writeExecutable(join(binDir, "tmux"), "#!/usr/bin/env sh\nexit 0\n");
  writeExecutable(join(binDir, "codex"), "#!/usr/bin/env sh\nexit 0\n");
  const pathEnv = `${binDir}:${process.env.PATH || ""}`;

  const firstOut = execFileSync(
    process.execPath,
    [CLI_PATH, "-C", root, "spawn", "codex", "--name", "root-codex"],
    { cwd: root, env: { ...process.env, PATH: pathEnv, DUO_PROCESS_ID: "" }, encoding: "utf8" }
  );
  const rootProcess = JSON.parse(firstOut) as { id: string; depth: number; parentId?: string };
  assert.equal(rootProcess.depth, 1);
  assert.equal(rootProcess.parentId, undefined);

  const secondOut = execFileSync(
    process.execPath,
    [CLI_PATH, "-C", root, "spawn", "codex", "--name", "child-codex"],
    {
      cwd: root,
      env: { ...process.env, PATH: pathEnv, DUO_PROCESS_ID: rootProcess.id },
      encoding: "utf8"
    }
  );
  const childProcess = JSON.parse(secondOut) as { id: string; depth: number; parentId?: string };
  assert.equal(childProcess.parentId, rootProcess.id);
  assert.equal(childProcess.depth, 2);
});

test("duo spawn falls back to orphan and warns when DUO_PROCESS_ID points to unknown process", () => {
  const root = mkdtempSync(join(tmpdir(), "duo-cli-spawn-dangling-"));
  const binDir = join(root, "bin");
  mkdirSync(binDir);
  writeExecutable(join(binDir, "tmux"), "#!/usr/bin/env sh\nexit 0\n");
  writeExecutable(join(binDir, "codex"), "#!/usr/bin/env sh\nexit 0\n");
  const pathEnv = `${binDir}:${process.env.PATH || ""}`;

  const result = spawnSync(
    process.execPath,
    [CLI_PATH, "-C", root, "spawn", "codex", "--name", "orphan-codex"],
    {
      cwd: root,
      env: { ...process.env, PATH: pathEnv, DUO_PROCESS_ID: "proc_ghost_deadbeef" },
      encoding: "utf8"
    }
  );

  assert.equal(result.status, 0, `exit status ${result.status}; stderr=${result.stderr}`);
  const spawned = JSON.parse(result.stdout) as { id: string; depth: number; parentId?: string };
  assert.equal(spawned.parentId, undefined);
  assert.equal(spawned.depth, 1);
  assert.match(result.stderr, /DUO_PROCESS_ID=proc_ghost_deadbeef is set but not found in state/);
});

test("duo start does not inherit parent from DUO_PROCESS_ID env", () => {
  const root = mkdtempSync(join(tmpdir(), "duo-cli-start-no-inherit-"));
  const binDir = join(root, "bin");
  mkdirSync(binDir);
  writeExecutable(join(binDir, "tmux"), "#!/usr/bin/env sh\nexit 0\n");
  writeExecutable(join(binDir, "codex"), "#!/usr/bin/env sh\nexit 0\n");
  const pathEnv = `${binDir}:${process.env.PATH || ""}`;

  const firstOut = execFileSync(
    process.execPath,
    [CLI_PATH, "-C", root, "spawn", "codex", "--name", "seed-codex"],
    { cwd: root, env: { ...process.env, PATH: pathEnv, DUO_PROCESS_ID: "" }, encoding: "utf8" }
  );
  const seed = JSON.parse(firstOut) as { id: string };

  const startOut = execFileSync(
    process.execPath,
    [CLI_PATH, "-C", root, "start", "--parent", "codex", "--no-attach", "task"],
    {
      cwd: root,
      env: { ...process.env, PATH: pathEnv, DUO_PROCESS_ID: seed.id },
      encoding: "utf8"
    }
  );
  const started = JSON.parse(startOut) as { depth: number; parentId?: string };
  assert.equal(started.parentId, undefined);
  assert.equal(started.depth, 1);
});

function writeExecutable(path: string, content: string): void {
  writeFileSync(path, content, "utf8");
  chmodSync(path, 0o755);
}
