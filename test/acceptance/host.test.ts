import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { STATE_ENTRY, type Snapshot } from "../../src/core/model.ts";
import { answer, call, fakeUI, harness } from "../harness.ts";
import { markdown, simplePlan } from "../fixtures.ts";

function latest(session: Awaited<ReturnType<typeof harness>>["session"]): Snapshot {
  const entry = [...session.sessionManager.getBranch()].reverse().find(e => e.type === "custom" && e.customType === STATE_ENTRY);
  assert.equal(entry?.type, "custom"); return (entry as { data: Snapshot }).data;
}

test("real Pi host: headless investigation gates direct/nested tools and submits without approval", { timeout: 15000 }, async () => {
  let deniedRan = false;
  const h = await harness((_context, n) => {
    if (n === 0) return answer([call("read", "read", { path: "source.txt" }), call("write", "write", { path: "oops.txt", content: "should never exist" }),
      call("nested", "delegate", {}), call("unknown", "deploy_fixture", {})], "toolUse");
    if (n === 1) return answer([call("submit", "plan_submit", { markdown, evidencePaths: ["source.txt", "expected.txt"] })], "toolUse");
    return answer([{ type: "text", text: markdown }]);
  }, { userSettings: JSON.stringify({ allowedTools: ["delegate"] }), tools: [
    { name: "delegate", label: "Delegate", description: "Fixture nested caller", parameters: (await import("typebox")).Type.Object({}),
      execute: async (_id, _args, _signal, _update, ctx) => {
        const result = await ctx.executeTool("write", { path: "nested.txt", content: "denied" });
        assert.equal(result.isError, true);
        return { ...result.result, isError: result.isError };
      } },
    { name: "deploy_fixture", label: "Deploy", description: "Must not run", parameters: (await import("typebox")).Type.Object({}),
      execute: async () => { deniedRan = true; return { content: [{ type: "text", text: "BAD" }], details: {} }; } },
  ] });
  try {
    writeFileSync(join(h.workspace, "source.txt"), "Planning evidence\n");
    await h.session.prompt("/plan Safely add expected.txt");
    assert.equal(h.requests.length, 3);
    assert.equal(latest(h.session).phase, "ready"); assert.equal(latest(h.session).approval, null);
    assert.equal(deniedRan, false);
    for (const path of ["oops.txt", "nested.txt", "expected.txt"]) assert.equal(existsSync(join(h.workspace, path)), false);
    const results = h.session.messages.filter(m => m.role === "toolResult");
    assert.equal(results.find(m => m.role === "toolResult" && m.toolCallId === "write")?.isError, true);
    assert.equal(results.find(m => m.role === "toolResult" && m.toolCallId === "nested")?.isError, true);
    await h.session.prompt("/plan implement");
    await h.session.prompt("/plan exit");
    assert.equal(h.requests.length, 3);
    assert.ok(!h.session.sessionManager.getBranch().some(e => e.type === "message" && e.message.role === "custom" && e.message.customType === "pi-planroom.context"));
  } finally { h.dispose(); }
});

test("real Pi host: RPC approval is revision-bound; successful commands support verified completion", { timeout: 15000 }, async () => {
  const plan = simplePlan;
  const h = await harness((_context, n) => {
    if (n === 0) return answer([call("submit", "plan_submit", { markdown: plan, evidencePaths: ["result.txt"] })], "toolUse");
    if (n === 1) return answer([{ type: "text", text: plan }]);
    if (n === 2) return answer([call("impl", "write", { path: "result.txt", content: "done\n" }), call("check", "bash", { command: "node -e 'process.exit(0)'" })], "toolUse");
    return answer([call("progress", "plan_progress", { items: [{ id: "step-1", status: "verified", evidence: "Created result.txt and ran the acceptance check." }], checks: [{ id: "check-1", toolCallId: "check", evidence: "Matching command returned exit code 0." }], complete: true })], "toolUse");
  });
  try {
    await h.session.prompt("/plan Create a checked result");
    const rpc = fakeUI({ selects: ["Keep current model and thinking", "Keep current model and thinking"], confirms: [false, true] });
    await h.session.bindExtensions({ mode: "rpc", uiContext: rpc.ui });
    await h.session.prompt("/plan implement");
    assert.equal(h.requests.length, 2); assert.equal(latest(h.session).phase, "ready");
    await h.session.prompt("/plan implement");
    assert.ok(existsSync(join(h.workspace, "result.txt")), JSON.stringify({ notices: rpc.notices, dialogs: rpc.dialogs, state: latest(h.session), requests: h.requests.length }));
    assert.equal(readFileSync(join(h.workspace, "result.txt"), "utf8"), "done\n");
    assert.equal(latest(h.session).phase, "completed"); assert.equal(latest(h.session).checks[0]?.source, "observed");
    assert.ok(rpc.dialogs.some(d => d.kind === "confirm" && String(d.value).includes(latest(h.session).hash!)));
  } finally { h.dispose(); }
});
