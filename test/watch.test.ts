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

test("renderWatchFrameWithLayout uses compact labels in columns", () => {
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
  state.processes.proc_recent = {
    id: "proc_recent",
    runtime: "claude",
    name: "recent",
    status: "closed",
    parentId: "proc_parent",
    depth: 2,
    tmuxSession: "recent",
    cwd: "/tmp/duo-watch",
    createdAt: "2026-04-24T00:00:01.000Z",
    updatedAt: "2026-04-24T00:01:00.000Z",
    failureCount: 0
  };

  const frame = renderWatchFrameWithLayout(
    {
      state,
      capturedAt: "2026-04-24T00:01:30.000Z",
      recentWindowMs: 60_000,
      processes: [
        { process: state.processes.proc_child, output: "CHILD" },
        { process: state.processes.proc_recent, output: "DONE" }
      ]
    },
    { layout: "columns", terminalWidth: 120 }
  );

  assert.match(frame, /child\(parent\)> recent \| proc_recent \| closed 30s/);
  assert.doesNotMatch(frame, /kept for review/);
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

test("renderWatchFrameWithLayout keeps child labels when the parent is hidden", () => {
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
        { process: state.processes.proc_child, output: "CHILD" }
      ]
    },
    { layout: "columns", terminalWidth: 120 }
  );

  assert.match(frame, /child\(proc_parent\)> child \| proc_child/);
  assert.doesNotMatch(frame, /orphan\(proc_parent\)/);
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

  assert.match(frame, /orphan\(missing\)> orphan child \| proc_orphan/);
  assert.match(frame, /root> separate root \| proc_root/);
});

test("shouldShowInWatch keeps recently finished processes visible", () => {
  const recentClosed = {
    id: "proc_recent",
    runtime: "claude" as const,
    name: "recent closed",
    status: "closed" as const,
    parentId: "proc_parent",
    depth: 2,
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

test("renderWatchFrame marks recently finished children kept for review", () => {
  const state = defaultState("/tmp/duo-watch");
  state.processes.proc_recent = {
    id: "proc_recent",
    runtime: "claude",
    name: "recent closed",
    status: "closed",
    parentId: "proc_parent",
    depth: 2,
    tmuxSession: "demo",
    cwd: "/tmp/duo-watch",
    createdAt: "2026-04-24T00:00:00.000Z",
    updatedAt: "2026-04-24T00:01:00.000Z",
    failureCount: 0
  };

  const frame = renderWatchFrame({
    state,
    capturedAt: "2026-04-24T00:01:30.000Z",
    recentWindowMs: 60_000,
    processes: [
      {
        process: state.processes.proc_recent,
        output: "DONE"
      }
    ]
  });

  assert.match(frame, /finished 30s ago, kept for review/);
  assert.match(frame, /finished children kept 60s for review/);
});

test("shouldShowInWatch hides root parents by default", () => {
  const rootParent = {
    id: "proc_parent",
    runtime: "claude" as const,
    name: "parent",
    status: "running" as const,
    depth: 1,
    tmuxSession: "parent",
    cwd: "/tmp/duo-watch",
    createdAt: "2026-04-24T00:00:00.000Z",
    updatedAt: "2026-04-24T00:00:00.000Z",
    failureCount: 0
  };

  assert.equal(
    shouldShowInWatch(rootParent, {
      now: Date.parse("2026-04-24T00:01:00.000Z"),
      recentWindowMs: 60_000
    }),
    false
  );

  assert.equal(
    shouldShowInWatch(rootParent, {
      includeRoots: true,
      now: Date.parse("2026-04-24T00:01:00.000Z"),
      recentWindowMs: 60_000
    }),
    true
  );

  assert.equal(
    shouldShowInWatch(rootParent, {
      includeAll: true,
      now: Date.parse("2026-04-24T00:01:00.000Z"),
      recentWindowMs: 60_000
    }),
    true
  );
});

test("shouldShowInWatch shows active children by default", () => {
  const child = {
    id: "proc_child",
    runtime: "codex" as const,
    name: "child",
    status: "running" as const,
    parentId: "proc_parent",
    depth: 2,
    tmuxSession: "child",
    cwd: "/tmp/duo-watch",
    createdAt: "2026-04-24T00:00:00.000Z",
    updatedAt: "2026-04-24T00:00:00.000Z",
    failureCount: 0
  };

  assert.equal(
    shouldShowInWatch(child, {
      now: Date.parse("2026-04-24T00:01:00.000Z"),
      recentWindowMs: 60_000
    }),
    true
  );
});
