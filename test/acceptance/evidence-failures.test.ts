import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { STATE_ENTRY, type Snapshot } from "../../src/core/model.ts";
import { answer, call, fakeUI, harness } from "../harness.ts";
import { simplePlan } from "../fixtures.ts";
const snapshot = (h: Awaited<ReturnType<typeof harness>>): Snapshot => {
  const e = [...h.session.sessionManager.getBranch()].reverse().find(e => e.type === "custom" && e.customType === STATE_ENTRY);
  assert.ok(e?.type === "custom"); return e.data as Snapshot;
};
test("observed acceptance is automatically associated without model-supplied opaque call IDs", { timeout: 15000 }, async () => {
  const h = await harness((_ctx, n) => {
    if (n === 0) return answer([call("submit", "plan_submit", { markdown: simplePlan, evidencePaths: ["result.txt"] })], "toolUse");
    if (n === 1) return answer([{ type: "text", text: simplePlan }]);
    if (n === 2) return answer([call("write", "write", { path: "result.txt", content: "done\n" }), call("real-opaque-id", "bash", { command: "node -e 'process.exit(0)'" })], "toolUse");
    return answer([call("progress", "plan_progress", { items: [{ id: "step-1", status: "verified", evidence: "Created and checked result" }], complete: true })], "toolUse");
  });
  try {
    await h.session.prompt("/plan Create a checked result");
    const ui = fakeUI({ selects: ["Keep current model and thinking"], confirms: [true] });
    await h.session.bindExtensions({ mode: "rpc", uiContext: ui.ui }); await h.session.prompt("/plan implement");
    assert.equal(snapshot(h).phase, "completed"); assert.equal(snapshot(h).checks[0].toolCallId, "real-opaque-id");
  } finally { h.dispose(); }
});
test("a later failed acceptance command invalidates earlier success; old IDs cannot resurrect it", { timeout: 15000 }, async () => {
  const plan = simplePlan.replace("node -e 'process.exit(0)'", "node verify.cjs");
  const h = await harness((_ctx, n) => {
    if (n === 0) return answer([call("submit", "plan_submit", { markdown: plan, evidencePaths: ["result.txt", "verify.cjs"] })], "toolUse");
    if (n === 1) return answer([{ type: "text", text: plan }]);
    if (n === 2) return answer([call("write", "write", { path: "result.txt", content: "done\n" }), call("first-check", "bash", { command: "node verify.cjs" })], "toolUse");
    if (n === 3) return answer([call("record", "plan_progress", { items: [{ id: "step-1", status: "verified", evidence: "Initial check passed" }] })], "toolUse");
    if (n === 4) return answer([call("failed-check", "bash", { command: "node verify.cjs" })], "toolUse");
    if (n === 5) return answer([call("old-proof", "plan_progress", { items: [{ id: "step-1", status: "verified", evidence: "Claimed older check" }], checks: [{ id: "check-1", evidence: "Old success", toolCallId: "first-check" }], complete: true })], "toolUse");
    if (n === 6) return answer([call("auto-proof", "plan_progress", { items: [{ id: "step-1", status: "verified", evidence: "No current successful check" }], complete: true })], "toolUse");
    return answer([{ type: "text", text: "Acceptance remains incomplete." }]);
  });
  try {
    writeFileSync(join(h.workspace, "verify.cjs"), "const fs=require('node:fs'); const count=fs.existsSync('counter') ? Number(fs.readFileSync('counter','utf8')) : 0; fs.writeFileSync('counter',String(count+1)); process.exit(count === 0 ? 0 : 1);\n");
    await h.session.prompt("/plan Create a checked result");
    const ui = fakeUI({ selects: ["Keep current model and thinking"], confirms: [true] });
    await h.session.bindExtensions({ mode: "rpc", uiContext: ui.ui }); await h.session.prompt("/plan implement");
    assert.notEqual(snapshot(h).phase, "completed"); assert.equal(snapshot(h).checks.length, 0);
    const errors = h.session.messages.filter(m => m.role === "toolResult" && ["old-proof", "auto-proof"].includes(m.toolCallId));
    assert.equal(errors.length, 2); assert.ok(errors.every(m => m.role === "toolResult" && m.isError));
  } finally { h.dispose(); }
});
test("provider errors close the execution lease instead of silently retaining approval", { timeout: 15000 }, async () => {
  const h = await harness((_ctx, n) => n === 0 ? answer([call("submit", "plan_submit", { markdown: simplePlan })], "toolUse")
    : n === 1 ? answer([{ type: "text", text: simplePlan }]) : { ...answer([], "error"), errorMessage: "Non-retryable fixture error" });
  try {
    await h.session.prompt("/plan Create a checked result");
    const ui = fakeUI({ selects: ["Keep current model and thinking"], confirms: [true] });
    await h.session.bindExtensions({ mode: "rpc", uiContext: ui.ui }); await h.session.prompt("/plan implement");
    assert.equal(snapshot(h).phase, "paused"); assert.equal(snapshot(h).approval, null);
    assert.equal(existsSync(join(h.workspace, "result.txt")), false);
  } finally { h.dispose(); }
});
test("a native abort closes the lease and retains an unapproved resumable checkpoint", { timeout: 15000 }, async () => {
  let release!: (message: ReturnType<typeof answer>) => void, started!: () => void;
  const active = new Promise<void>(resolve => { started = resolve; });
  const h = await harness(async (_ctx, n) => {
    if (n === 0) return answer([call("submit", "plan_submit", { markdown: simplePlan })], "toolUse");
    if (n === 1) return answer([{ type: "text", text: simplePlan }]);
    started(); return new Promise<ReturnType<typeof answer>>(resolve => { release = resolve; });
  });
  try {
    await h.session.prompt("/plan Create a checked result");
    const ui = fakeUI({ selects: ["Keep current model and thinking"], confirms: [true] });
    await h.session.bindExtensions({ mode: "rpc", uiContext: ui.ui });
    const implementation = h.session.prompt("/plan implement"); await active;
    const abort = h.session.abort(); release(answer([{ type: "text", text: "Interrupted fixture response" }]));
    await Promise.all([abort, implementation]);
    assert.equal(snapshot(h).phase, "paused"); assert.equal(snapshot(h).approval, null);
    assert.equal(existsSync(join(h.workspace, "result.txt")), false);
  } finally { h.dispose(); }
});
test("material redesign cannot resume or write under the old revision", { timeout: 15000 }, async () => {
  const h = await harness((_ctx, n) => {
    if (n === 0) return answer([call("submit", "plan_submit", { markdown: simplePlan })], "toolUse");
    if (n === 1) return answer([{ type: "text", text: simplePlan }]);
    if (n === 2) return answer([call("change", "plan_progress", { items: [], materialChange: "Compatibility requirements changed" })], "toolUse");
    if (n === 3) return answer([call("denied", "write", { path: "result.txt", content: "not authorized" })], "toolUse");
    return answer([{ type: "text", text: "Replacement planning is required." }]);
  });
  try {
    await h.session.prompt("/plan Create a checked result");
    const ui = fakeUI({ selects: ["Keep current model and thinking"], confirms: [true] });
    await h.session.bindExtensions({ mode: "rpc", uiContext: ui.ui }); await h.session.prompt("/plan implement");
    assert.equal(snapshot(h).phase, "paused"); assert.equal(snapshot(h).changeReason, "Compatibility requirements changed");
    assert.equal(existsSync(join(h.workspace, "result.txt")), false);
    await h.session.prompt("/plan implement");
    assert.equal(ui.dialogs.filter(c => c.kind === "confirm").length, 1, "No old-revision approval dialog can reopen");
    assert.equal(snapshot(h).approval, null);
  } finally { h.dispose(); }
});
