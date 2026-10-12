import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { contentText } from "@earendil-works/pi-ai";
import { STATE_ENTRY, approve, type Snapshot } from "../../src/core/model.ts";
import { PlanStore } from "../../src/storage/store.ts";
import { answer, call, fakeUI, harness } from "../harness.ts";
import { simplePlan } from "../fixtures.ts";

const stateEntry = (session: Awaited<ReturnType<typeof harness>>["session"]) => {
  const entry = [...session.sessionManager.getBranch()].reverse().find(e => e.type === "custom" && e.customType === STATE_ENTRY);
  assert.ok(entry?.type === "custom"); return { id: entry.id, data: entry.data as Snapshot };
};
test("real session tree: branching revisions preserve parent identity; resumption never dispatches", { timeout: 15000 }, async () => {
  let sequence = 0;
  const h = await harness(context => {
    const last = context.messages[context.messages.length - 1];
    if (last?.role === "toolResult") return answer([{ type: "text", text: simplePlan }]);
    sequence++;
    return answer([call(`submit-${sequence}`, "plan_submit", { markdown: simplePlan.replace("# Checked result", `# Branch ${sequence}`) })], "toolUse");
  });
  try {
    await h.session.prompt("/plan Branch safely"); const first = stateEntry(h.session);
    await h.session.prompt("/plan revise Second revision"); const second = stateEntry(h.session);
    assert.equal(second.data.revision, 2);
    await h.session.navigateTree(first.id, { summarize: false });
    await h.session.prompt("/plan revise Alternative branch"); const third = stateEntry(h.session);
    assert.equal(third.data.revision, 3);
    const store = new PlanStore(join(h.agentDir, "pi-planroom", "plans"));
    assert.equal(store.read(third.data.planId!, 3).parent, first.data.hash);
    h.session.sessionManager.appendCustomEntry(STATE_ENTRY, approve(third.data, third.data.hash!, h.session.sessionManager.getSessionId(), "here"));
    const count = h.requests.length;
    const resumed = await h.build(h.session.sessionManager);
    assert.equal(h.requests.length, count);
    // Restore is observable through the public plan_read tool, not through stale serialized approval.
    const ui = fakeUI(); await resumed.bindExtensions({ mode: "rpc", uiContext: ui.ui });
    await resumed.prompt("/plan status");
    const status = String(ui.dialogs.find(d => d.kind === "editor")?.value);
    assert.match(status, /"phase": "paused"/); assert.match(status, /"approval": null/);
  } finally { h.dispose(); }
});

test("real compaction: canonical plan is recovered once when its submission leaves model context", { timeout: 15000 }, async () => {
  const h = await harness(context => {
    if (!context.messages.some(m => m.role === "system" && m.toolsAdded?.length)) return answer([{ type: "text", text: "## Goal\nPlanning a checked result.\n## Progress\nPlan submitted, never approved. Preserve artifact identity and inspect it before any implementation." }]);
    if (context.messages.some(m => contentText(m.content).includes('"revision":null'))) return answer([call("submit", "plan_submit", { markdown: simplePlan })], "toolUse");
    return answer([{ type: "text", text: "The plan is ready and unapproved." }]);
  }, { keepRecentTokens: 512 });
  try {
    await h.session.prompt("/plan Checked result");
    const retained = h.requests.at(-1)!.messages.find(m => contentText(m.content).startsWith('{"phase":"ready"'));
    assert.ok(retained); assert.equal(JSON.parse(contentText(retained.content)).plan, null, "Retained submissions do not need a second full copy");
    for (let i = 0; i < 3; i++) await h.session.prompt("Do not implement; historical investigation. " + "Background findings. ".repeat(300));
    await h.session.compact("Preserve planning status, never approval.");
    await h.session.prompt("Do not implement; show current planning state.");
    const last = h.requests[h.requests.length - 1];
    const canonical = last.messages.filter(m => contentText(m.content).includes('"phase":"ready"'));
    assert.equal(canonical.length, 1, JSON.stringify(last.messages));
    assert.equal(JSON.parse(contentText(canonical[0].content)).plan, simplePlan.trim(), "Compaction recovery restores the exact document, not just its name");
    assert.ok(!h.session.messages.some(m => m.role === "custom" && m.customType === "pi-planroom.context"));
  } finally { h.dispose(); }
});
