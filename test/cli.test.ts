import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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

function writeExecutable(path: string, content: string): void {
  writeFileSync(path, content, "utf8");
  chmodSync(path, 0o755);
}
