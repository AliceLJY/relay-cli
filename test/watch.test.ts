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

test("renderWatchFrameWithLayout shows parent-child hierarchy in stack mode even when columns are requested", () => {
  const state = defaultState("/tmp/duo-watch");
  state.processes.proc_parent = {
    id: "proc_parent",
    runtime: "claude",
    name: "parent",
    status: "running",
    depth: 1,
    tmuxSession: "parent",
    cwd: "/tmp/duo-watch",
    createdAt: "2026-04-24T00:00:00.000Z",
    updatedAt: "2026-04-24T00:00:00.000Z",
    failureCount: 0
  };
  state.processes.proc_child = {
    id: "proc_child",
    runtime: "codex",
    name: "child",
    status: "running",
    parentId: "proc_parent",
    depth: 2,
    tmuxSession: "child",
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
        { process: state.processes.proc_parent, output: "PARENT" },
        { process: state.processes.proc_child, output: "CHILD" }
      ]
    },
    { layout: "columns", terminalWidth: 120 }
  );

  assert.match(frame, /root> parent \| proc_parent/);
  assert.match(frame, /child\(proc_parent\)> child \| proc_child/);
  assert.ok(frame.indexOf("proc_parent") < frame.indexOf("proc_child"));
});

test("renderWatchFrameWithLayout labels orphan children when parent is not visible", () => {
  const state = defaultState("/tmp/duo-watch");
  state.processes.proc_orphan = {
    id: "proc_orphan",
    runtime: "codex",
    name: "orphan child",
    status: "running",
    parentId: "proc_missing",
    depth: 2,
    tmuxSession: "orphan",
    cwd: "/tmp/duo-watch",
    createdAt: "2026-04-24T00:00:00.000Z",
    updatedAt: "2026-04-24T00:00:00.000Z",
    failureCount: 0
  };
  state.processes.proc_root = {
    id: "proc_root",
    runtime: "claude",
    name: "separate root",
    status: "running",
    depth: 1,
    tmuxSession: "root",
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
        { process: state.processes.proc_orphan, output: "ORPHAN" },
        { process: state.processes.proc_root, output: "ROOT" }
      ]
    },
    { layout: "columns", terminalWidth: 120 }
  );

  assert.match(frame, /orphan\(proc_missing\)> orphan child \| proc_orphan/);
  assert.match(frame, /root> separate root \| proc_root/);
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
