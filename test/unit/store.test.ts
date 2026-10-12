import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, chmodSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlanStore, publishExclusive, readBounded } from "../../src/storage/store.ts";
import { initial, start, submitted } from "../../src/core/model.ts";
import { markdown } from "../fixtures.ts";
function fixture(t: { after: (fn: () => void) => void }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "planroom-store-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, store: new PlanStore(join(root, "plans")), state: start(initial(root), "Recovery" ) };
}
test("immutable revisions, private permissions and branch parent identity", t => {
  const { root, store, state } = fixture(t);
  const one = store.write(state, markdown, []);
  const two = store.write(submitted(state, one), markdown + "\nRevision two.", []);
  const branch = store.write(submitted(state, one), markdown + "\nAlternate branch.", []);
  assert.equal(two.number, 2); assert.equal(branch.number, 3);
  assert.equal(branch.parent, one.hash);
  assert.deepEqual(store.read(one.planId, 1), one);
  assert.equal(store.list()[0].number, 3);
  assert.equal(statSync(join(root, "plans", one.planId, "1.json")).mode & 0o777, 0o600);
  assert.equal(statSync(store.root).mode & 0o777, 0o700);
  assert.throws(() => publishExclusive(join(store.directory(one.planId), "1.json"), "overwrite"));
});
test("export never overwrites and refuses traversal/symlink paths", t => {
  const { root, store, state } = fixture(t); const revision = store.write(state, markdown, []);
  const path = store.export(revision, "plan.md", root);
  assert.equal(readFileSync(path, "utf8"), markdown.trim() + "\n");
  assert.throws(() => store.export(revision, "plan.md", root));
  assert.throws(() => store.export(revision, "../escape.md", root));
  symlinkSync(root, join(root, "link"));
  assert.throws(() => store.export(revision, "link/other.md", root), /Symlink/);
});
test("bounded reads reject oversized, invalid UTF8 and symlink data", t => {
  const { root } = fixture(t); const file = join(root, "input");
  writeFileSync(file, "too much"); assert.throws(() => readBounded(file, 2));
  writeFileSync(file, Buffer.from([0xff])); assert.throws(() => readBounded(file));
  symlinkSync(file, join(root, "link")); assert.throws(() => readBounded(join(root, "link")), /Symlink/);
});
test("locks fail closed and only dead writer reservations can be archived", t => {
  const { store, state } = fixture(t); const one = store.write(state, markdown, []);
  const lock = join(store.directory(one.planId), ".lock"); mkdirSync(lock, { mode: 0o700 });
  writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: process.pid }), { mode: 0o600 });
  assert.throws(() => store.write(state, markdown, []), /locked/);
  assert.throws(() => store.recoverLock(one.planId), /dead-writer/);
  writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: 2147483647 }));
  assert.equal(store.inspectLock(one.planId)?.alive, false);
  assert.match(store.recoverLock(one.planId), /recovered-lock/);
  assert.equal(store.write(state, markdown, []).number, 2);
});
test("tampered artifacts cannot be read or extended", t => {
  const { store, state } = fixture(t); const one = store.write(state, markdown, []);
  const path = join(store.directory(one.planId), "1.json");
  writeFileSync(path, JSON.stringify({ ...one, objective: "tampered" }));
  assert.throws(() => store.read(one.planId, 1), /integrity/);
  assert.throws(() => store.write(submitted(state, one), markdown, []), /integrity/);
});
test("shared artifact directories fail closed on reading without chmod side effects", t => {
  const { store, state } = fixture(t); const one = store.write(state, markdown, []);
  chmodSync(store.root, 0o755);
  assert.throws(() => store.read(one.planId, 1), /owner-only/); assert.throws(() => store.list(), /owner-only/);
  assert.equal(statSync(store.root).mode & 0o777, 0o755);
  chmodSync(store.root, 0o700); assert.equal(store.read(one.planId, 1).hash, one.hash);
});
test("oversized revision records are refused before immutable publication", t => {
  const { store, state } = fixture(t);
  const huge = Array.from({ length: 100 }, (_, n) => ({ path: `/root/${n}/${"x".repeat(3900)}`, hash: null }));
  assert.throws(() => store.write(state, markdown, huge), /256 KiB/);
  assert.deepEqual(store.numbers(state.planId!), []);
  assert.equal(store.write(state, markdown, []).number, 1);
});
