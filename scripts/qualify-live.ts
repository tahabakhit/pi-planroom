import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createAssistantMessageEventStream, getSupportedThinkingLevels, InMemoryCredentialStore, type Credential, type Provider, type Usage } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { createPlanroom } from "../src/index.ts";
import { parseDocument, STATE_ENTRY, type Snapshot } from "../src/core/model.ts";
import { PlanStore, publishExclusive } from "../src/storage/store.ts";
import { fakeUI } from "../test/harness.ts";

const selected = process.env.PLANROOM_LIVE_MODEL, authPath = process.env.PLANROOM_LIVE_AUTH;
if (!selected || !authPath || !selected.includes("/")) throw new Error("Explicit PLANROOM_LIVE_MODEL=provider/id and PLANROOM_LIVE_AUTH are required; this makes billed provider requests.");
const separator = selected.indexOf("/"), providerId = selected.slice(0, separator), modelId = selected.slice(separator + 1);
const root = realpathSync(mkdtempSync(join(tmpdir(), "planroom-live-")));
const abort = new AbortController(), deadline = setTimeout(() => abort.abort(), 120000);
let session: AgentSession | undefined;
let requests = 0, stage = "setup", reportPath: string | undefined;
const usage: Usage[] = [];
try {
  if (process.env.PLANROOM_LIVE_REPORT) {
    const repository = realpathSync(dirname(dirname(fileURLToPath(import.meta.url))));
    const target = resolve(process.env.PLANROOM_LIVE_REPORT), rel = relative(repository, target);
    if (!rel || (rel !== ".." && !rel.startsWith(`..${sep}`))) throw new Error("Diagnostics must be outside the checkout.");
    reportPath = target;
  }
  const workspace = join(root, "workspace"), agentDir = join(root, "agent"); mkdirSync(workspace); mkdirSync(agentDir);
  const credential = JSON.parse(readFileSync(authPath, "utf8"))[providerId] as Credential | undefined;
  if (!credential || !["oauth", "api_key"].includes(credential.type)) throw new Error("Unavailable credential.");
  // Avoid rotating an expiring live refresh token in an intentionally non-persistent copy.
  if (credential.type === "oauth" && credential.expires < Date.now() + 10 * 60 * 1000) throw new Error("Credential expiry is too near; refresh it deliberately outside qualification.");
  const credentials = new InMemoryCredentialStore(); await credentials.modify(providerId, async () => structuredClone(credential));
  const runtime = await ModelRuntime.create({ credentials, modelsPath: null, modelsStorePath: join(agentDir, "models-store.json"), refreshOnCreate: false, allowModelNetwork: false });
  const model = runtime.getModel(providerId, modelId), native = runtime.getProvider(providerId);
  if (!model || !native) throw new Error("Exact model/provider is unavailable.");
  const bounded: Provider["streamSimple"] = (requested, context, options) => {
    requests++;
    if (requests > 8) {
      const s = createAssistantMessageEventStream();
      const response = { role: "assistant" as const, content: [], api: requested.api, provider: requested.provider, model: requested.id,
        stopReason: "error" as const, errorMessage: "Explicit qualification request budget exhausted", timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      queueMicrotask(() => { s.push({ type: "error", reason: "error", error: response }); s.end(response); }); return s;
    }
    const stream = native.streamSimple(requested, context, { ...options, signal: AbortSignal.any([abort.signal, ...(options?.signal ? [options.signal] : [])]),
      timeoutMs: 30000, maxTokens: 2048, maxRetries: 0, maxRetryDelayMs: 1000, transport: "sse" });
    void stream.result().then(response => { usage.push(response.usage); }).catch(() => {}); return stream;
  };
  runtime.registerNativeProvider({ id: native.id, name: native.name, ...(native.baseUrl ? { baseUrl: native.baseUrl } : {}), auth: native.auth,
    getModels: () => native.getModels(), stream: bounded as Provider["stream"], streamSimple: bounded });
  await runtime.refresh({ allowNetwork: false, providers: [providerId], signal: abort.signal });
  const fixture = "Keep this file unchanged. Create result.txt containing exactly done followed by LF. Acceptance command: node verify.cjs.\n";
  const verifier = "require('node:assert/strict').equal(require('node:fs').readFileSync('result.txt','utf8'),'done\\n');\n";
  writeFileSync(join(workspace, "fixture.txt"), fixture); writeFileSync(join(workspace, "verify.cjs"), verifier);
  const sm = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" });
  const loader = new DefaultResourceLoader({ cwd: workspace, agentDir, settingsManager: sm, noExtensions: true, disabledBuiltinExtensions: ["mcp", "codemode"],
    noSkills: true, noThemes: true, noContextFiles: true, noPromptTemplates: true, extensionFactories: [{ name: "planroom", factory: createPlanroom({ agentDir }) }] });
  await loader.reload();
  ({ session } = await createAgentSession({ cwd: workspace, agentDir, modelRuntime: runtime, model, thinkingLevel: getSupportedThinkingLevels(model)[0], settingsManager: sm,
    sessionManager: SessionManager.inMemory(workspace), resourceLoader: loader }));
  await session.bindExtensions({ mode: "print" });
  const state = (): Snapshot => {
    const entry = [...session!.sessionManager.getBranch()].reverse().find(e => e.type === "custom" && e.customType === STATE_ENTRY);
    assert.ok(entry?.type === "custom"); return entry.data as Snapshot;
  };
  stage = "planning";
  await session.prompt("/plan Read fixture.txt and verify.cjs, then plan adding result.txt with exactly done followed by LF. Preserve both existing files. Submit through plan_submit. Keep this deliberately tiny: exactly one implementation bullet and one verification bullet beginning with `node verify.cjs`. Evidence paths must include fixture.txt, verify.cjs, and the not-yet-existing result.txt. Do not implement or run verification before approval. Make no unrelated changes.");
  assert.equal(state().phase, "ready"); assert.equal(state().approval, null); assert.equal(existsSync(join(workspace, "result.txt")), false);
  const store = new PlanStore(join(agentDir, "pi-planroom", "plans")), revision = store.read(state().planId!, state().revision!);
  assert.equal(parseDocument(revision.markdown).verification.length, 1); assert.equal(parseDocument(revision.markdown).verification[0].command, "node verify.cjs");
  stage = "approval";
  const before = requests;
  const ui = fakeUI({ selects: ["Keep current model and thinking", "Keep current model and thinking"], confirms: [false, true] });
  await session.bindExtensions({ mode: "rpc", uiContext: ui.ui });
  await session.prompt("/plan implement"); assert.equal(requests, before); assert.equal(existsSync(join(workspace, "result.txt")), false);
  stage = "implementation";
  await session.prompt("/plan implement");
  assert.equal(readFileSync(join(workspace, "fixture.txt"), "utf8"), fixture); assert.equal(readFileSync(join(workspace, "verify.cjs"), "utf8"), verifier);
  assert.equal(readFileSync(join(workspace, "result.txt"), "utf8"), "done\n");
  execFileSync(process.execPath, ["verify.cjs"], { cwd: workspace, timeout: 10000 });
  assert.equal(state().phase, "completed"); assert.equal(state().checks[0]?.source, "observed");
  console.log(JSON.stringify({ status: "passed", interface: "public SDK / scripted fixture UI", model: selected, requests,
    tokens: usage.reduce((sum, u) => sum + u.totalTokens, 0), estimatedCost: usage.reduce((sum, u) => sum + u.cost.total, 0),
    coverage: ["real-provider investigation/submission", "declined approval inert", "approved local fixture", "matching native command evidence", "verified completion"],
    exclusions: ["manual human terminal acceptance", "live installation", "publication"] }));
} catch {
  if (reportPath && session) {
    const report = { stage, entries: session.sessionManager.getBranch().filter(e => e.type === "custom" && e.customType === STATE_ENTRY),
      messages: session.messages.map(m => m.role === "assistant" && ["error", "aborted"].includes(m.stopReason) ? { role: "assistant", stopReason: m.stopReason } : m) };
    try { publishExclusive(reportPath, JSON.stringify(report, null, 2)); } catch { /* Never overwrite a diagnostic or leak provider exceptions. */ }
  }
  console.error(JSON.stringify({ status: "failed", stage, model: selected, requests, tokens: usage.reduce((sum, u) => sum + u.totalTokens, 0),
    estimatedCost: usage.reduce((sum, u) => sum + u.cost.total, 0), error: "Provider-backed qualification unavailable or assertions failed. No fallback/retry or live configuration change. Runtime transcripts are not published." }));
  process.exitCode = 1;
} finally { clearTimeout(deadline); abort.abort(); session?.dispose(); rmSync(root, { recursive: true, force: true }); }
