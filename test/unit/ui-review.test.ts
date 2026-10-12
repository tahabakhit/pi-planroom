import test from "node:test";
import assert from "node:assert/strict";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, Key } from "@earendil-works/pi-tui";
import { diffDocuments, safeDisplay, viewer } from "../../src/ui/view.ts";
import { decodeCritique } from "../../src/review/review.ts";
const theme = { fg: (_token: string, text: string) => text, bold: (s: string) => s, italic: (s: string) => s, strikethrough: (s: string) => s, underline: (s: string) => s } as unknown as Theme;
test("Markdown review viewport is scrollable, resize-safe, width-bounded and sanitizes controls", () => {
  let rows = 12, done = false;
  const component = viewer("# Plan\n\n" + Array.from({ length: 150 }, (_, i) => `- Line ${i} with a long-unbroken-${"a".repeat(100)}`).join("\n"), "Review", theme, () => rows, () => {}, () => { done = true; });
  const first = component.render(40); assert.ok(first.length <= rows); assert.ok(first.every(s => visibleWidth(s) <= 40));
  component.handleInput?.("\x1b[6~"); assert.notDeepEqual(component.render(40), first);
  rows = 6; component.invalidate(); const narrow = component.render(10); assert.ok(narrow.length <= rows); assert.ok(narrow.every(s => visibleWidth(s) <= 10));
  component.handleInput?.("\x1b"); assert.equal(done, true);
  assert.equal(safeDisplay("hello\x1b[31m\u202eBAD"), "hello[31mBAD");
});
test("diff includes changed content faithfully and cannot be closed by nested code fences", () => {
  const diff = diffDocuments("# Plan\n```\nold\n```", "# Plan\n```\nnew\n```");
  assert.match(diff, /-old/); assert.match(diff, /\+new/); assert.match(diff, /^~~~~diff/);
  assert.equal(diffDocuments("same", "same"), "No content changes.");
});
test("independent review schema fails closed on malformed, contradictory and overbroad output", () => {
  const valid = { verdict: "ready", summary: "Ready within the given evidence limits", findings: [], blockers: [] };
  assert.equal(decodeCritique(JSON.stringify(valid)).verdict, "ready");
  for (const value of ["not JSON", JSON.stringify({ ...valid, approve: true }), JSON.stringify({ ...valid, blockers: ["Not resolved"] }), JSON.stringify({ ...valid, findings: Array(21).fill("x") })]) assert.throws(() => decodeCritique(value));
});
