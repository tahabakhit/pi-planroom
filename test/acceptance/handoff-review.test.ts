import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { SessionManager, type AgentSession, type ExtensionCommandContextActions } from "@earendil-works/pi-coding-agent";
import { STATE_ENTRY, type Snapshot } from "../../src/core/model.ts";
import { answer, call, fakeUI, fixtureModel, harness } from "../harness.ts";
import { simplePlan } from "../fixtures.ts";

const snapshot = (session: AgentSession): Snapshot => {
  const entry = [...session.sessionManager.getBranch()].reverse().find(e => e.type === "custom" && e.customType === STATE_ENTRY);
  assert.ok(entry?.type === "custom"); return entry.data as Snapshot;
};
test("fresh destination: handoff is linked and durable; destination approval can decline without dispatch", { timeout: 15000 }, async () => {
  const h = await harness((_ctx, n) => n === 0 ? answer([call("submit", "plan_submit", { markdown: simplePlan })], "toolUse") : answer([{ type: "text", text: simplePlan }]), { fileSessions: true });
  try {
    await h.session.prompt("/plan Create a checked result"); const initialRequests = h.requests.length;
    const source = fakeUI({ confirms: [true] }), destinationUI = fakeUI({ selects: ["Keep current model and thinking"], confirms: [false] });
    let destination: AgentSession | undefined;
    await h.session.bindExtensions({ mode: "rpc", uiContext: source.ui, commandContextActions: {
      waitForIdle: async () => {},
      newSession: async options => {
        const manager = SessionManager.create(h.workspace, join(h.root, "sessions"), { parentSession: options?.parentSession });
        await options?.setup?.(manager); destination = await h.build(manager);
        await destination.bindExtensions({ mode: "rpc", uiContext: destinationUI.ui });
        await options?.withSession?.({ ...destination.extensionRunner.createCommandContext(), sendMessage: async () => { throw new Error("Unused message transport"); }, sendUserMessage: async (content, opts) => {
          if (typeof content !== "string") throw new Error("Expected command text");
          await destination!.prompt(content, { source: "extension", expandPromptTemplates: opts?.expandPromptTemplates });
        } });
        return { cancelled: false };
      },
      fork: async () => ({ cancelled: true }), navigateTree: async () => ({ cancelled: true }), switchSession: async () => ({ cancelled: true }), reload: async () => {},
    } satisfies ExtensionCommandContextActions });
    await h.session.prompt("/plan fresh");
    assert.ok(destination); assert.equal(h.requests.length, initialRequests);
    assert.equal(snapshot(destination).hash, snapshot(h.session).hash); assert.equal(snapshot(destination).approval, null);
    assert.equal(destination.sessionManager.getHeader()?.parentSession, h.session.sessionManager.getSessionFile());
    assert.ok(existsSync(destination.sessionManager.getSessionFile()!));
    assert.ok(destinationUI.dialogs.some(d => d.kind === "confirm" && String(d.value).includes(snapshot(destination!).hash!)));
  } finally { h.dispose(); }
});
test("independent review: explicit model, no tools, separate usage record, no approval power", { timeout: 15000 }, async () => {
  const h = await harness((context, n) => {
    if (context.messages.some(m => m.role === "system" && JSON.stringify(m).includes("independent plan critic"))) {
      assert.ok(!context.messages.some(m => m.role === "system" && m.toolsAdded?.length));
      return answer([{ type: "text", text: JSON.stringify({ verdict: "changes_required", summary: "Make the check meaningful", findings: ["An exit-zero command does not check file contents."], blockers: [] }) }]);
    }
    return n === 0 ? answer([call("submit", "plan_submit", { markdown: simplePlan })], "toolUse") : answer([{ type: "text", text: simplePlan }]);
  });
  try {
    await h.session.prompt("/plan Create a checked result");
    const ui = fakeUI({ selects: [`${fixtureModel.provider}/${fixtureModel.id}`], confirms: [true] });
    await h.session.bindExtensions({ mode: "rpc", uiContext: ui.ui });
    await h.session.prompt("/plan critique");
    assert.equal(snapshot(h.session).phase, "ready"); assert.equal(snapshot(h.session).approval, null);
    const reviews = h.session.sessionManager.getBranch().filter(e => e.type === "custom" && e.customType === "pi-planroom.review");
    assert.equal(reviews.length, 1);
    assert.ok(reviews[0].type === "custom" && (reviews[0].data as { usage?: unknown }).usage);
    assert.equal(readdirSync(join(h.agentDir, "pi-planroom", "plans", snapshot(h.session).planId!, "reviews")).length, 1);
    assert.ok(ui.dialogs.some(d => d.kind === "editor" && String(d.value).includes("Make the check meaningful")));
  } finally { h.dispose(); }
});
