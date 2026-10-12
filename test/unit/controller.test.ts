import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Controller } from "../../src/core/controller.ts";
import { approve } from "../../src/core/model.ts";
import { capture, defaultPolicy } from "../../src/policy/policy.ts";
import { PlanStore } from "../../src/storage/store.ts";
import { markdown } from "../fixtures.ts";

function fixture() {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), "planroom-controller-")));
  const c = new Controller(new PlanStore(join(workspace, "artifacts")), workspace, () => {});
  return { c, workspace, close: () => rmSync(workspace, { recursive: true, force: true }) };
}
test("controller refuses stale evidence submission until genuine reinspection", () => {
  const { c, workspace, close } = fixture();
  try {
    c.begin("Recover"); const path = join(workspace, "source"); writeFileSync(path, "before"); c.inspected(capture(path, workspace));
    writeFileSync(path, "after"); assert.throws(() => c.submit(markdown, [path], defaultPolicy()), /read it again/);
    c.inspected(capture(path, workspace)); c.submit(markdown, [path], defaultPolicy()); assert.equal(c.state.phase, "ready");
    writeFileSync(path, "later"); c.inspected(capture(path, workspace)); assert.equal(c.state.phase, "planning");
  } finally { close(); }
});
test("decisions and paused execution invalidate live leases and obsolete interaction generations", () => {
  const { c, close } = fixture();
  try {
    c.begin("Recover"); c.question("choice", "Strategy?", true); const generation = c.generation;
    assert.throws(() => c.submit(markdown, [], defaultPolicy()), /blocking/); c.answer("choice", "Existing strategy"); assert.ok(c.generation > generation);
    c.submit(markdown, [], defaultPolicy()); c.execution(approve(c.state, c.state.hash!, "session", "here"));
    c.pause(); assert.equal(c.lease, false); assert.equal(c.state.approval, null);
    assert.throws(() => c.progress([], [], false), /human-approved/);
    assert.throws(() => c.restore({ ...c.state, hash: "f".repeat(64) }), /identit/);
  } finally { close(); }
});
test("reported evidence cannot complete; resume preserves progress but never authority", () => {
  const { c, close } = fixture();
  try {
    c.begin("Recover"); c.submit(markdown, [], defaultPolicy()); c.execution(approve(c.state, c.state.hash!, "session", "here"));
    c.progress(c.state.progress.map(p => ({ ...p, status: "verified", evidence: "Implementation checked" })), [{ id: "check-1", evidence: "Claimed", source: "reported" }], false);
    assert.throws(() => c.progress([], [], true), /Completion/);
    const saved = c.state; c.restore(saved); assert.equal(c.state.phase, "paused"); assert.equal(c.lease, false); assert.equal(c.state.progress[0].status, "verified");
    c.execution(approve(c.state, c.state.hash!, "new session", "here"));
    c.progress([], [{ id: "check-1", evidence: "Actual check", source: "human" }, { id: "check-2", evidence: "Actual restart", source: "human" }], true);
    assert.equal(c.state.phase, "completed"); assert.equal(c.state.approval, null);
  } finally { close(); }
});
test("artifact corruption closes a live lease and requires explicit recovery", () => {
  const { c, close } = fixture();
  try {
    c.begin("Recover"); const revision = c.submit(markdown, [], defaultPolicy());
    c.execution(approve(c.state, c.state.hash!, "session", "here"));
    writeFileSync(join(c.store.directory(revision.planId), "1.json"), JSON.stringify({ ...revision, objective: "corrupted" }));
    assert.throws(() => c.plan(), /integrity/); assert.equal(c.lease, false);
    assert.throws(() => c.assertHealthy(), /recovery/);
  } finally { close(); }
});
test("material change durably closes authority and requires a replacement revision", () => {
  const { c, close } = fixture();
  try {
    c.begin("Compatibility"); c.submit(markdown, [], defaultPolicy());
    c.execution(approve(c.state, c.state.hash!, "session", "here"));
    c.materialChange("Compatibility assumptions changed");
    assert.equal(c.lease, false); assert.equal(c.state.phase, "paused");
    const recovered = new Controller(c.store, c.state.workspace, () => {}); recovered.restore(c.state);
    assert.equal(recovered.state.changeReason, "Compatibility assumptions changed");
    assert.throws(() => approve(recovered.state, recovered.state.hash!, "destination", "here"), /newly submitted/);
    c.revise(); const replacement = c.submit(markdown + "\nUpdated compatibility scope.", [], defaultPolicy());
    assert.equal(replacement.changeReason, "Compatibility assumptions changed"); assert.equal(c.state.changeReason, null);
    assert.equal(approve(c.state, replacement.hash, "session", "here").phase, "implementing");
  } finally { close(); }
});
