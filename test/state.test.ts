import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addHumanRequest,
  answerLatestHumanRequest,
  assertNotBraked,
  defaultState,
  readState,
  recordFailure,
  setBrake,
  writeState
} from "../src/state.js";

test("state round-trips through project-local .duo directory", () => {
  const root = mkdtempSync(join(tmpdir(), "duo-state-"));
  const state = defaultState(root);
  writeState(state);
  const loaded = readState(root);
  assert.equal(loaded.projectRoot, root);
  assert.equal(loaded.limits.maxDepth, 2);
});

test("brake prevents autonomous actions until resume", () => {
  const root = mkdtempSync(join(tmpdir(), "duo-brake-"));
  const braked = setBrake(defaultState(root), "direction drift", "human");
  assert.throws(() => assertNotBraked(braked), /direction drift/);
  const resumed = answerLatestHumanRequest(braked, "continue with narrower scope");
  assert.doesNotThrow(() => assertNotBraked(resumed));
});

test("need_human creates a blocking request and resume answers it", () => {
  const root = mkdtempSync(join(tmpdir(), "duo-human-"));
  const { state, request } = addHumanRequest(defaultState(root), {
    reason: "key decision",
    question: "Which direction should we take?",
    urgency: "normal",
    options: ["A", "B"],
    recommended: "A"
  });

  assert.equal(state.brake?.active, true);
  assert.equal(state.humanRequests[request.id].status, "pending");

  const answered = answerLatestHumanRequest(state, "Pick A");
  assert.equal(answered.humanRequests[request.id].status, "answered");
  assert.equal(answered.humanRequests[request.id].response, "Pick A");
  assert.equal(answered.brake, undefined);
});

test("three failures activate the system brake", () => {
  const root = mkdtempSync(join(tmpdir(), "duo-failure-"));
  let state = defaultState(root);
  state = recordFailure(state, "one");
  state = recordFailure(state, "two");
  state = recordFailure(state, "three");
  assert.equal(state.brake?.active, true);
  assert.match(state.brake?.reason || "", /failure limit/);
});
