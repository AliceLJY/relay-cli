import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultState } from "../src/state.js";
import { parseClaudeAuthStatus, previewInputForEvent, resolveCommand, sendInput } from "../src/runtime.js";

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
