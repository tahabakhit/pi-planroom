import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const root = realpathSync(mkdtempSync(join(tmpdir(), "planroom-package-")));
const cli = join(repo, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
const provider = join(repo, "test", "cli-provider.ts");
type Record_ = Record<string, any>;
function fixture(name: string) {
  const workspace = join(root, name), agent = join(root, name + "-agent"); mkdirSync(workspace); mkdirSync(agent);
  writeFileSync(join(workspace, "fixture.txt"), "Qualification evidence, not a live project.\n");
  writeFileSync(join(agent, "settings.json"), JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" }));
  return { workspace, agent, env: { ...process.env, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", XDG_CACHE_HOME: join(root, "cache") } };
}
function client(args: string[], workspace: string, env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, [cli, ...args], { cwd: workspace, env, stdio: ["pipe", "pipe", "pipe"] });
  let buffer = "", stderr = "", failure: Error | undefined;
  const records: Record_[] = [];
  const waiting = new Set<() => void>();
  const closed = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  let confirmation = false;
  child.stderr.setEncoding("utf8"); child.stderr.on("data", data => { stderr = (stderr + data).slice(-65536); });
  function send(record: Record_) { child.stdin.write(JSON.stringify(record) + "\n"); }
  child.stdout.setEncoding("utf8"); child.stdout.on("data", (data: string) => {
    buffer += data;
    if (Buffer.byteLength(buffer) > 2 * 1024 * 1024) { failure = new Error("Protocol record exceeded bound"); child.kill(); }
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, ""); buffer = buffer.slice(newline + 1); if (!line) continue;
      try {
        const record = JSON.parse(line) as Record_; records.push(record);
        if (record.type === "extension_ui_request") {
          const response: Record_ = { type: "extension_ui_response", id: record.id };
          if (record.method === "editor") send({ ...response, value: record.prefill ?? "" });
          else if (record.method === "select") send({ ...response, value: "Keep current model and thinking" });
          else if (record.method === "confirm") send({ ...response, confirmed: confirmation });
          else if (record.method === "input") send({ ...response, cancelled: true });
        }
      } catch { failure = new Error("Invalid JSONL output"); child.kill(); }
    }
    waiting.forEach(wake => wake());
  });
  child.on("close", () => waiting.forEach(wake => wake()));
  async function wait(predicate: (record: Record_) => boolean, from = 0): Promise<Record_> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error(`CLI deadline exceeded: ${stderr}`)); }, 20000);
      const cleanup = () => { clearTimeout(timer); waiting.delete(check); };
      const check = () => {
        const record = records.slice(from).find(predicate);
        if (failure) { cleanup(); reject(failure); }
        else if (record) { cleanup(); resolve(record); }
        else if (child.exitCode !== null) { cleanup(); reject(new Error(`CLI exited ${child.exitCode}: ${stderr}`)); }
      };
      waiting.add(check); check();
    });
  }
  return { child, records, send, wait, closed, setConfirmation: (value: boolean) => { confirmation = value; }, stderr: () => stderr };
}
try {
  const packs = JSON.parse(execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", root], { cwd: repo, encoding: "utf8" }));
  const files = packs[0].files.map((f: { path: string }) => f.path) as string[];
  for (const path of ["src/index.ts", "src/core/controller.ts", "src/handoff/packet.ts", "README.md", "SECURITY.md", "CHANGELOG.md", "docs/testing.md"]) assert.ok(files.includes(path), `Missing ${path}`);
  assert.ok(files.every(path => !/^(?:test|scripts|node_modules|\.pi|\.git)\//.test(path)));
  assert.ok(!files.some(path => /(?:auth\.json|\.env|\.tmp-|\.lock)$/.test(path)));
  const extracted = join(root, "extracted"); mkdirSync(extracted);
  execFileSync("tar", ["-xf", join(root, packs[0].filename), "-C", extracted]);
  const entry = join(extracted, "package", "src", "index.ts");
  const base = ["--offline", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-themes", "--no-session", "--provider", "planroom-fixture", "--model", "deterministic", "-e", entry, "-e", provider];
  const print = fixture("print");
  const text = execFileSync(process.execPath, [cli, ...base, "--mode", "text", "-p", "/plan Create a checked result"], { cwd: print.workspace, env: print.env, encoding: "utf8", timeout: 20000, maxBuffer: 2 * 1024 * 1024 });
  assert.match(text, /# Checked result/); assert.equal(existsSync(join(print.workspace, "denied.txt")), false); assert.equal(existsSync(join(print.workspace, "result.txt")), false);
  assert.equal(readdirSync(join(print.agent, "pi-planroom", "plans")).length, 1);
  const jsonFixture = fixture("json");
  const jsonText = execFileSync(process.execPath, [cli, ...base, "--mode", "json", "/plan Create a checked result"], { cwd: jsonFixture.workspace, env: jsonFixture.env, encoding: "utf8", timeout: 20000, maxBuffer: 2 * 1024 * 1024 });
  const jsonRecords = jsonText.trim().split("\n").map(line => JSON.parse(line));
  assert.ok(jsonRecords.some(r => r.type === "entry_appended" && r.entry?.data?.phase === "ready"));
  assert.ok(jsonRecords.some(r => r.type === "message_end" && r.message?.toolCallId === "denied" && r.message.isError));
  assert.equal(existsSync(join(jsonFixture.workspace, "denied.txt")), false);
  const rpcFixture = fixture("rpc"), rpc = client([...base, "--mode", "rpc"], rpcFixture.workspace, rpcFixture.env);
  try {
    rpc.send({ type: "get_commands", id: "commands" }); const commands = await rpc.wait(r => r.type === "response" && r.id === "commands");
    assert.equal(commands.success, true); assert.ok(JSON.stringify(commands.data).includes('"plan"'));
    let from = rpc.records.length;
    rpc.send({ type: "prompt", id: "plan", message: "/plan Create a checked result" });
    await rpc.wait(r => r.type === "agent_settled", from);
    assert.ok(rpc.records.some(r => r.type === "entry_appended" && r.entry?.data?.phase === "ready"));
    assert.equal(existsSync(join(rpcFixture.workspace, "result.txt")), false);
    from = rpc.records.length; rpc.setConfirmation(false);
    rpc.send({ type: "prompt", id: "decline", message: "/plan implement" });
    await rpc.wait(r => r.type === "response" && r.id === "decline", from);
    assert.equal(existsSync(join(rpcFixture.workspace, "result.txt")), false);
    assert.ok(!rpc.records.slice(from).some(r => r.type === "agent_start"));
    from = rpc.records.length; rpc.setConfirmation(true);
    rpc.send({ type: "prompt", id: "approve", message: "/plan implement" });
    await rpc.wait(r => r.type === "entry_appended" && r.entry?.data?.phase === "completed", from);
    await rpc.wait(r => r.type === "agent_settled", from);
    assert.equal(existsSync(join(rpcFixture.workspace, "result.txt")), true);
    assert.equal(existsSync(join(rpcFixture.workspace, "denied.txt")), false);
    assert.ok(!rpc.records.some(r => r.type === "extension_error"), JSON.stringify(rpc.records.filter(r => r.type === "extension_error")));
  } finally { rpc.child.stdin.end(); const timer = setTimeout(() => rpc.child.kill(), 3000); await rpc.closed; clearTimeout(timer); }
  const installation = fixture("install");
  execFileSync(process.execPath, [cli, "install", join(extracted, "package")], { cwd: installation.workspace, env: installation.env, encoding: "utf8", timeout: 20000 });
  const installedArgs = base.filter((arg, index) => arg !== "--no-extensions" && arg !== entry && !(arg === "-e" && base[index + 1] === entry));
  const installedOutput = execFileSync(process.execPath, [cli, ...installedArgs, "--mode", "text", "-p", "/plan Create a checked result"], { cwd: installation.workspace, env: installation.env, encoding: "utf8", timeout: 20000, maxBuffer: 2 * 1024 * 1024 });
  assert.match(installedOutput, /# Checked result/); assert.equal(existsSync(join(installation.workspace, "denied.txt")), false);
  execFileSync(process.execPath, [cli, "remove", join(extracted, "package")], { cwd: installation.workspace, env: installation.env, encoding: "utf8", timeout: 20000 });
  assert.equal(readdirSync(join(installation.agent, "pi-planroom", "plans")).length, 1, "Removal must preserve private artifacts");
  const terminal = fixture("tui");
  const terminalResult = execFileSync("python3", [join(repo, "test", "tui-driver.py"), process.execPath, cli, ...base.filter(arg => arg !== "--no-session"), "--mode", "text", "--tui-mode", "regular", "/plan Create a checked result"], { cwd: terminal.workspace, env: { ...terminal.env, PLANROOM_TUI_QUESTIONS: "1" }, encoding: "utf8", timeout: 120000, maxBuffer: 2 * 1024 * 1024 });
  console.log(terminalResult.trim());
  console.log("Packed artifact qualified: text, JSONL, real RPC dialogs, and an automated real terminal; declined approval is inert; approved fixtures complete with observed evidence. No live provider or configuration used.");
} finally { rmSync(root, { recursive: true, force: true }); }
