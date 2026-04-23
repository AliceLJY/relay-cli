import test from "node:test";
import assert from "node:assert/strict";
import { defaultState } from "../src/state.js";
import { renderWatchFrame } from "../src/watch.js";

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
