import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { STATE_ENTRY, type Snapshot } from "../../src/core/model.ts";
import { answer, call, fakeUI, harness } from "../harness.ts";
import { simplePlan } from "../fixtures.ts";

test("repository drift and artifact corruption during approval cannot dispatch implementation", { timeout: 15000 }, async () => {
  for (const kind of ["drift", "artifact"]) {
    const h = await harness((_ctx, n) => n === 0 ? answer([call("submit", "plan_submit", { markdown: simplePlan, evidencePaths: ["source.txt", "result.txt"] })], "toolUse") : n === 1 ? answer([{ type: "text", text: simplePlan }]) : answer([call("bad-write", "write", { path: "result.txt", content: "never dispatch" })], "toolUse"));
    try {
      writeFileSync(join(h.workspace, "source.txt"), "original unrelated fixture");
      await h.session.prompt("/plan Preserve the existing fixture while creating a result");
      const e = [...h.session.sessionManager.getBranch()].reverse().find(e => e.type === "custom" && e.customType === STATE_ENTRY);
      assert.ok(e?.type === "custom"); const state = e.data as Snapshot;
      const ui = fakeUI({ selects: ["Keep current model and thinking"] });
      ui.ui.confirm = async () => {
        if (kind === "drift") writeFileSync(join(h.workspace, "source.txt"), "external concurrent change");
        else {
          const path = join(h.agentDir, "pi-planroom", "plans", state.planId!, "1.json");
          writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), objective: "tampered" }));
        }
        return true;
      };
      await h.session.bindExtensions({ mode: "rpc", uiContext: ui.ui }); await h.session.prompt("/plan implement");
      assert.equal(h.requests.length, 2, "No implementation provider request follows the stale approval");
      assert.equal(existsSync(join(h.workspace, "result.txt")), false);
      assert.ok(ui.notices.some(notice => /Evidence changed|integrity/.test(notice)));
    } finally { h.dispose(); }
  }
});
