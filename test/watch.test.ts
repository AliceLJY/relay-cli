import test from "node:test";
import assert from "node:assert/strict";
import { defaultState } from "../src/state.js";
import { renderWatchFrame, renderWatchFrameWithLayout, shouldShowInWatch } from "../src/watch.js";

test("renderWatchFrame includes process headers and output", () => {
  const state = defaultState("/tmp/duo-watch");
  state.processes.proc_demo = {
    id: "proc_demo",
    runtime: "claude",
    name: "demo process",
    status: "running",
    depth: 1,
    tmuxSession: "demo",
    cwd: "/tmp/duo-watch",
    createdAt: "2026-04-24T00:00:00.000Z",
    updatedAt: "2026-04-24T00:00:00.000Z",
    failureCount: 0
  };

  const frame = renderWatchFrame({
    state,
    capturedAt: "2026-04-24T00:00:01.000Z",
    processes: [
      {
        process: state.processes.proc_demo,
        output: "READY"
      }
    ]
  });

  assert.match(frame, /duo watch/);
  assert.match(frame, /demo process/);
  assert.match(frame, /READY/);
});

test("renderWatchFrameWithLayout supports columns", () => {
  const state = defaultState("/tmp/duo-watch");
  state.processes.proc_left = {
    id: "proc_left",
    runtime: "claude",
    name: "left",
    status: "running",
    depth: 1,
    tmuxSession: "left",
    cwd: "/tmp/duo-watch",
    createdAt: "2026-04-24T00:00:00.000Z",
    updatedAt: "2026-04-24T00:00:00.000Z",
    failureCount: 0
  };
  state.processes.proc_right = {
    id: "proc_right",
    runtime: "codex",
    name: "right",
    status: "running",
    depth: 1,
    tmuxSession: "right",
    cwd: "/tmp/duo-watch",
    createdAt: "2026-04-24T00:00:01.000Z",
    updatedAt: "2026-04-24T00:00:01.000Z",
    failureCount: 0
  };

  const frame = renderWatchFrameWithLayout(
    {
      state,
      capturedAt: "2026-04-24T00:00:02.000Z",
      processes: [
        { process: state.processes.proc_left, output: "LEFT" },
        { process: state.processes.proc_right, output: "RIGHT" }
      ]
    },
    { layout: "columns", terminalWidth: 120 }
  );

  assert.match(frame, /LEFT/);
  assert.match(frame, /RIGHT/);
});

test("shouldShowInWatch keeps recently finished processes visible", () => {
  const recentClosed = {
    id: "proc_recent",
    runtime: "claude" as const,
    name: "recent closed",
    status: "closed" as const,
    depth: 1,
    tmuxSession: "demo",
    cwd: "/tmp/duo-watch",
    createdAt: "2026-04-24T00:00:00.000Z",
    updatedAt: "2026-04-24T00:01:00.000Z",
    failureCount: 0
  };

  assert.equal(
    shouldShowInWatch(recentClosed, {
      now: Date.parse("2026-04-24T00:01:30.000Z"),
      recentWindowMs: 60_000
    }),
    true
  );

  assert.equal(
    shouldShowInWatch(recentClosed, {
      now: Date.parse("2026-04-24T00:03:30.000Z"),
      recentWindowMs: 60_000
    }),
    false
  );
});
