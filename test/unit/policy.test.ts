import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capture, defaultPolicy, drift, gate, inspectionCommand, settings, tokenize } from "../../src/policy/policy.ts";
function fixture(t: { after: (fn: () => void) => void }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "planroom-policy-")));
  t.after(() => rmSync(root, { recursive: true, force: true })); return root;
}
test("literal grammar rejects composition and expansion", () => {
  for (const command of ["ls; touch x", "pwd && id", "echo $(id)", "ls > x", "ls\nrm x", "ls `id`", "ls ${HOME}", "ls /tmp/*", "ls 'a'foo", "ls \\x", "ls 'unclosed"]) assert.throws(() => tokenize(command), command);
  assert.deepEqual(tokenize("git diff -- 'source file.ts'"), ["git", "diff", "--", "source file.ts"]);
});
test("inspection arguments reject hidden execution and mutation flags", t => {
  const root = fixture(t); const policy = defaultPolicy();
  for (const command of ["git -c x=y status", "git commit", "git diff --output=x", "git log --exec=x", "ls --help", "find . -exec id", "awk 'system(\"id\")'", "curl example.com", "env", "npm test"]) assert.throws(() => inspectionCommand(command, root, policy, true), command);
  assert.match(inspectionCommand("git status --short", root, policy, true), /core.fsmonitor=false/);
  assert.match(inspectionCommand("git log --oneline", root, policy, true), /max-count=30/);
  assert.match(inspectionCommand("git diff -- source.ts", root, policy, true), /no-textconv/);
  assert.throws(() => inspectionCommand("git diff -- ../outside", root, policy, true), /outside/);
});
test("explicit checks require trust and cannot contain shell composition", t => {
  const root = fixture(t); const policy = { ...defaultPolicy(), inspectionCommands: ["npm test"] };
  assert.match(inspectionCommand("npm test", root, policy, true), /npm/);
  assert.throws(() => inspectionCommand("npm test", root, policy, false), /trust/);
  assert.throws(() => inspectionCommand("npm test && ls", root, policy, true));
});
test("unknown and nested callees are gated independently", t => {
  const root = fixture(t); const policy = { ...defaultPolicy(), allowedTools: ["research_recent", "wrapper"] };
  assert.deepEqual(gate("wrapper", {}, root, policy, true), {});
  assert.throws(() => gate("write", { path: "file" }, root, policy, true));
  assert.throws(() => gate("another_tool", {}, root, policy, true));
  assert.throws(() => gate("read", { path: "/etc/passwd" }, root, policy, true));
  assert.throws(() => gate("read", { path: ".env" }, root, policy, true));
  assert.deepEqual(gate("research_recent", {}, root, policy, true), {});
});
test("baselines detect edits, creations, deletions and symlink drift", t => {
  const root = fixture(t); const file = join(root, "source.ts"); writeFileSync(file, "one");
  const baseline = [capture(file, root), capture("new.ts", root)];
  assert.deepEqual(drift(baseline, root), []);
  writeFileSync(file, "two"); writeFileSync(join(root, "new.ts"), "new");
  assert.equal(drift(baseline, root).length, 2);
  rmSync(file); symlinkSync(join(root, "new.ts"), file);
  assert.equal(drift(baseline, root).length, 2);
});
test("project settings cannot widen permissions; malformed user settings fail closed", t => {
  const root = fixture(t), agent = join(root, "agent"); mkdirSync(agent);
  mkdirSync(join(root, ".pi")); writeFileSync(join(root, ".pi/pi-planroom.json"), JSON.stringify({ allowedTools: ["write"] }));
  assert.deepEqual(settings(agent, root, false).policy, defaultPolicy());
  assert.throws(() => settings(agent, root, true), /widen/);
  writeFileSync(join(agent, "pi-planroom.json"), "invalid");
  assert.throws(() => settings(agent, root, false));
});
test("configured executable matching preserves exact argument boundaries", t => {
  const root = fixture(t), policy = { ...defaultPolicy(), inspectionCommands: ["python '-m fixture'"] };
  assert.match(inspectionCommand("python '-m fixture'", root, policy, true), /'-m fixture'/);
  assert.throws(() => inspectionCommand("python -m fixture", root, policy, true));
});
test("content searches and paths cannot bypass credential or terminal-control boundaries", t => {
  const root = fixture(t); writeFileSync(join(root, "file.ts"), "safe"); writeFileSync(join(root, ".env"), "not a planning input");
  assert.throws(() => gate("grep", { path: ".", pattern: "." }, root, defaultPolicy(), true), /directory/);
  assert.deepEqual(gate("grep", { path: "file.ts", pattern: "safe" }, root, defaultPolicy(), true), {});
  for (const path of ["x\nfile", " file.ts", "file.ts ", "x\u202efile"]) assert.throws(() => gate("read", { path }, root, defaultPolicy(), true));
});
test("settings reject unknown keys, unsafe shortcuts and implicit read roots", t => {
  const root = fixture(t), agent = join(root, "agent"); mkdirSync(agent);
  for (const value of [{ unknown: true }, { shortcut: "ctrl+t" }, { readRoots: ["../other"] }]) {
    writeFileSync(join(agent, "pi-planroom.json"), JSON.stringify(value));
    assert.throws(() => settings(agent, root, false));
  }
  writeFileSync(join(agent, "pi-planroom.json"), JSON.stringify({ shortcut: "f8" }));
  assert.equal(settings(agent, root, false).shortcut, "f8");
});
