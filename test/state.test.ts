import test from "node:test";
import "./test-env.js";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addHumanRequest,
  answerLatestHumanRequest,
  assertNotBraked,
  defaultState,
  maybeDowngradeBrake,
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

test("maybeDowngradeBrake downgrades stale system brake to warn-only", () => {
  const root = mkdtempSync(join(tmpdir(), "duo-brake-downgrade-"));
  const base = defaultState(root);
  const braked = setBrake(base, "process timeout: ghost", "system");
  // Back-date the brake createdAt by 3h so the 2h auto-downgrade threshold is exceeded.
  const staleAt = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
  const staleBraked = { ...braked, brake: { ...braked.brake!, createdAt: staleAt } };
  const downgraded = maybeDowngradeBrake(staleBraked);
  assert.equal(downgraded.brake?.mode, "warn");
  assert.ok(downgraded.brake?.downgradedAt);
  assert.ok(
    downgraded.events.some(
      (event) => event.type === "brake_downgrade" && event.message.includes("warn-only")
    )
  );
});

test("maybeDowngradeBrake leaves human brake untouched even when stale", () => {
  const root = mkdtempSync(join(tmpdir(), "duo-brake-human-"));
  const base = defaultState(root);
  const braked = setBrake(base, "drift", "human");
  const staleAt = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
  const staleBraked = { ...braked, brake: { ...braked.brake!, createdAt: staleAt } };
  const result = maybeDowngradeBrake(staleBraked);
  assert.equal(result.brake?.mode, undefined);
});

test("assertNotBraked respects warn mode without throwing", () => {
  const root = mkdtempSync(join(tmpdir(), "duo-brake-warn-"));
  const base = defaultState(root);
  const braked = setBrake(base, "stale", "system");
  const warnState = {
    ...braked,
    brake: { ...braked.brake!, mode: "warn" as const, downgradedAt: new Date().toISOString() }
  };
  assert.doesNotThrow(() => assertNotBraked(warnState));
});
