import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { STATE_ENTRY, type Snapshot } from "../../src/core/model.ts";
import { answer, call, fakeUI, harness } from "../harness.ts";
import { simplePlan } from "../fixtures.ts";

test("invalid, tool-seeking, aborted and failed reviewer responses remain advisory failures", { timeout: 15000 }, async () => {
  for (const response of [answer([{ type: "text", text: "not JSON" }]), answer([call("review-write", "write", { path: "review-write.txt", content: "never execute" })], "toolUse"), answer([], "aborted"), { ...answer([], "error"), errorMessage: "private-provider-secret-marker" }]) {
    const h = await harness((_ctx, n) => n === 0 ? answer([call("submit", "plan_submit", { markdown: simplePlan })], "toolUse") : n === 1 ? answer([{ type: "text", text: simplePlan }]) : response);
    try {
      await h.session.prompt("/plan Create a checked result");
      const ui = fakeUI({ selects: ["planroom-fixture/deterministic"], confirms: [true] });
      await h.session.bindExtensions({ mode: "rpc", uiContext: ui.ui }); await h.session.prompt("/plan critique");
      assert.ok(!h.requests.at(-1)!.tools?.length);
      const rendered = JSON.stringify(ui.dialogs); assert.match(rendered, /Review (failed|aborted)/);
      assert.ok(!rendered.includes("private-provider-secret-marker"));
      assert.equal(existsSync(join(h.workspace, "review-write.txt")), false);
      const e = [...h.session.sessionManager.getBranch()].reverse().find(e => e.type === "custom" && e.customType === STATE_ENTRY);
      assert.ok(e?.type === "custom"); const state = e.data as Snapshot;
      assert.equal(state.phase, "ready"); assert.equal(state.approval, null);
    } finally { h.dispose(); }
  }
});
