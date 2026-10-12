import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Markdown, matchesKey, Key, truncateToWidth, type Component, type MarkdownTheme } from "@earendil-works/pi-tui";

export function safeDisplay(text: string): string {
  return text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, "");
}
export function markdownTheme(theme: Theme): MarkdownTheme {
  return {
    heading: text => theme.fg("accent", theme.bold(text)), link: text => theme.fg("accent", text),
    linkUrl: text => theme.fg("muted", text), code: text => theme.fg("accent", text),
    codeBlock: text => theme.fg("toolOutput", text), codeBlockBorder: text => theme.fg("border", text),
    quote: text => theme.fg("muted", text), quoteBorder: text => theme.fg("border", text),
    hr: text => theme.fg("border", text), listBullet: text => theme.fg("accent", text),
    bold: text => theme.bold(text), italic: text => theme.italic(text),
    strikethrough: text => theme.strikethrough(text), underline: text => theme.underline(text),
  };
}
export function viewer(text: string, title: string, theme: Theme, rows: () => number, refresh: () => void, done: () => void): Component {
  const markdown = new Markdown(safeDisplay(text), 0, 0, markdownTheme(theme));
  let scroll = 0, height = 10, total = 0;
  return {
    render(width) {
      height = Math.max(1, rows() - 4);
      const lines = markdown.render(Math.max(1, width)); total = lines.length;
      scroll = Math.max(0, Math.min(scroll, Math.max(0, total - height)));
      return [
        truncateToWidth(theme.fg("accent", safeDisplay(title)), width),
        ...lines.slice(scroll, scroll + height).map(line => truncateToWidth(line, width)),
        truncateToWidth(theme.fg("muted", `${scroll + 1}–${Math.min(total, scroll + height)} / ${total} · ↑↓ j/k · PgUp/PgDn · Esc back`), width),
      ];
    },
    handleInput(data) {
      if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || data === "q") { done(); return; }
      if (matchesKey(data, Key.up) || data === "k") scroll -= 1;
      else if (matchesKey(data, Key.down) || data === "j") scroll += 1;
      else if (matchesKey(data, Key.pageUp)) scroll -= height;
      else if (matchesKey(data, Key.pageDown) || data === " ") scroll += height;
      else if (matchesKey(data, Key.home)) scroll = 0;
      else if (matchesKey(data, Key.end)) scroll = Math.max(0, total - height);
      scroll = Math.max(0, Math.min(scroll, Math.max(0, total - height))); refresh();
    },
    invalidate() { markdown.invalidate(); },
  };
}
export async function show(ctx: ExtensionContext, text: string, title: string): Promise<void> {
  if (ctx.mode === "tui") {
    await ctx.ui.custom<void>((tui, theme, _kb, done) => viewer(text, title, theme, () => tui.terminal.rows, () => tui.requestRender(), () => done()));
  } else if (ctx.mode === "rpc") {
    // RPC supports an editor dialog, not terminal components. Edits in this read view are discarded.
    await ctx.ui.editor(title + " (read-only; edits discarded)", text);
  } else throw new Error("Use plan_read for headless document output.");
}
export function diffDocuments(before: string, after: string): string {
  const old = before.split("\n"), next = after.split("\n");
  let prefix = 0, suffix = 0;
  while (prefix < old.length && prefix < next.length && old[prefix] === next[prefix]) prefix++;
  while (suffix < old.length - prefix && suffix < next.length - prefix && old[old.length - suffix - 1] === next[next.length - suffix - 1]) suffix++;
  if (prefix === old.length && prefix === next.length) return "No content changes.";
  const lines = ["--- previous", "+++ current",
    ...old.slice(Math.max(0, prefix - 3), prefix).map(line => " " + line),
    ...old.slice(prefix, old.length - suffix).map(line => "-" + line),
    ...next.slice(prefix, next.length - suffix).map(line => "+" + line),
    ...next.slice(next.length - suffix, next.length - suffix + 3).map(line => " " + line)];
  // Tilde fences remain valid if the document itself contains backtick code blocks.
  const fence = "~".repeat(Math.max(3, ...lines.map(line => /^~+/.exec(line)?.[0].length ?? 0)) + 1);
  return `${fence}diff\n${lines.join("\n")}\n${fence}`;
}
