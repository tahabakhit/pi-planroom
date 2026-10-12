import { test } from "node:test";
import assert from "node:assert/strict";
import { approve, complete, decodeRevision, decodeSnapshot, initial, makeRevision, parseDocument, pause, restoring, start, submitted } from "../../src/core/model.ts";

import { markdown } from "../fixtures.ts";
export function ready() {
  const state = start(initial("/fixture"), "Add recovery");
  const revision = makeRevision(state, 1, markdown, []);
  return { state: submitted(state, revision), revision };
}
test("explicit lifecycle and stale approval refusal", () => {
  const { state, revision } = ready();
  assert.equal(state.phase, "ready");
  assert.throws(() => approve(state, "stale", "session", "here"), /stale/);
  const execution = approve(state, revision.hash, "session", "here");
  assert.equal(execution.phase, "implementing");
  assert.equal(restoring(execution).phase, "paused");
  assert.equal(restoring(execution).approval, null);
  assert.throws(() => start(execution, "another task"));
  assert.throws(() => submitted(execution, revision), /Pause/);
  const replaced = submitted(pause(execution), makeRevision(pause(execution), 2, markdown + "\nUpdated.\n", []));
  assert.equal(replaced.approval, null);
});
test("blocking unanswered decisions prevent readiness", () => {
  const state = start(initial("/fixture"), "goal");
  state.decisions.push({ id: "q", question: "Compatibility?", blocking: true, answer: null });
  const revision = makeRevision(state, 1, markdown, []);
  assert.throws(() => submitted(state, revision), /blocking/);
});
test("completion requires verified steps and credible check evidence", () => {
  const { state, revision } = ready();
  let execution = approve(state, revision.hash, "session", "here");
  assert.throws(() => complete(execution, revision));
  execution.progress = execution.progress.map(p => ({ ...p, status: "verified", evidence: "checked" }));
  execution.checks = [{ id: "check-1", source: "reported", evidence: "claims tests passed" }, { id: "check-2", source: "human", evidence: "confirmed" }];
  assert.throws(() => complete(execution, revision));
  execution.checks[0].source = "observed";
  assert.equal(complete(execution, revision).phase, "completed");
});
test("schema and immutable content integrity are validated", () => {
  const { state, revision } = ready();
  assert.deepEqual(decodeSnapshot(state), state);
  assert.deepEqual(decodeRevision(revision), revision);
  assert.throws(() => decodeRevision({ ...revision, markdown: markdown.replace("existing", "other") }), /integrity/);
  assert.throws(() => decodeSnapshot({ ...state, schema: 99 }));
  assert.throws(() => decodeSnapshot({ ...state, progress: [state.progress[0], state.progress[0]] }), /Duplicate/);
});
test("document validation ignores fenced headings and requires useful bullets", () => {
  assert.equal(parseDocument(markdown).steps.length, 2);
  assert.equal(parseDocument(markdown).verification[0].command, "npm test");
  assert.throws(() => parseDocument("# Title\n## Goal\nx"), /Approach/);
  assert.throws(() => parseDocument(markdown + "\n## Goal\nagain"), /Duplicate/);
  assert.throws(() => parseDocument(markdown + "\n```\n"), /fence/);
  assert.equal(parseDocument(markdown + "\n```\n## Goal\n```\n").title, "Add recovery");
  assert.throws(() => parseDocument(markdown + "\u001b[0m"), /controls/);
});
test("snapshot coherence rejects damaged associations and phase/approval mismatches", () => {
  const { state, revision } = ready();
  for (const damaged of [{ ...state, phase: "idle" }, { ...state, hash: null }, { ...state, objective: "" }, { ...state, phase: "implementing" }, { ...state, approval: approve(state, revision.hash, "session", "here").approval }]) assert.throws(() => decodeSnapshot(damaged));
  assert.throws(() => decodeSnapshot({ ...state, unused: "x".repeat(256 * 1024) }), /256 KiB/);
});
test("completion cannot use another revision or duplicated step labels", () => {
  const { state, revision } = ready(); const execution = approve(state, revision.hash, "session", "here");
  execution.progress = execution.progress.map(p => ({ ...p, status: "verified", evidence: "checked" }));
  execution.checks = [{ id: "check-1", source: "observed", evidence: "passed" }, { id: "check-2", source: "human", evidence: "confirmed" }];
  assert.throws(() => complete(execution, makeRevision(pause(execution), 2, markdown, [])));
  execution.progress = [execution.progress[0], execution.progress[0]];
  assert.throws(() => complete(execution, revision));
});
