import { mkdtempSync, mkdirSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAssistantMessageEventStream, InMemoryCredentialStore, type AssistantMessage, type Context, type Model, type Provider, type JsonObject } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type AgentSession, type ExtensionUIContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createPlanroom } from "../src/index.ts";

export const fixtureModel: Model<"openai-completions"> = { provider: "planroom-fixture", id: "deterministic", name: "Deterministic fixture", api: "openai-completions", baseUrl: "https://fixture.invalid", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 8192 };
export function answer(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
  return { role: "assistant", content, api: fixtureModel.api, provider: fixtureModel.provider, model: fixtureModel.id, stopReason, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: Date.now() };
}
export const call = (id: string, name: string, args: JsonObject) => ({ type: "toolCall" as const, id, name, arguments: args });
export function fakeUI(replies: { selects?: (string | undefined)[]; confirms?: boolean[]; editors?: (string | undefined)[] } = {}) {
  const dialogs: { kind: string; title: string; value?: unknown }[] = [];
  const notices: string[] = [];
  const ui = new Proxy({
    select: async (title: string, options: string[]) => { dialogs.push({ kind: "select", title, value: options }); return replies.selects?.shift(); },
    confirm: async (title: string, value: string) => { dialogs.push({ kind: "confirm", title, value }); return replies.confirms?.shift() ?? false; },
    editor: async (title: string, value = "") => { dialogs.push({ kind: "editor", title, value }); return replies.editors?.length ? replies.editors.shift() : value; },
    input: async (title: string) => { dialogs.push({ kind: "input", title }); return replies.editors?.shift(); },
    notify: (text: string) => notices.push(text),
    setStatus: () => undefined, setWidget: () => undefined, setEditorText: () => undefined,
    getEditorText: () => "", getTheme: () => undefined, getAllThemes: () => [],
  }, { get(target, property) { return Reflect.get(target, property) ?? (() => undefined); } }) as unknown as ExtensionUIContext;
  return { ui, dialogs, notices };
}
export async function harness(handler: (context: Context, index: number) => AssistantMessage | Promise<AssistantMessage>, options: { tools?: ToolDefinition[]; userSettings?: string; fileSessions?: boolean; keepRecentTokens?: number } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "planroom-host-"))), workspace = join(root, "workspace"), agentDir = join(root, "agent");
  mkdirSync(workspace); mkdirSync(agentDir);
  if (options.userSettings) (await import("node:fs")).writeFileSync(join(agentDir, "pi-planroom.json"), options.userSettings);
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
  const requests: Context[] = [];
  const stream: Provider["streamSimple"] = (_model, context) => {
    const result = createAssistantMessageEventStream(); const index = requests.length; requests.push(context as Context);
    queueMicrotask(async () => {
      try { const message = await handler(context as Context, index); result.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message }); result.end(message); }
      catch (error) { const message = { ...answer([{ type: "text", text: "Fixture failure" }]), stopReason: "error" as const, errorMessage: String(error) }; result.push({ type: "error", reason: "error", error: message }); result.end(message); }
    });
    return result;
  };
  runtime.registerNativeProvider({ id: fixtureModel.provider, name: "Fixture", auth: { apiKey: { name: "Fixture", resolve: async () => ({ auth: { apiKey: "not-a-real-key" } }) } }, getModels: () => [fixtureModel], stream: stream as Provider["stream"], streamSimple: stream });
  await runtime.refresh({ allowNetwork: false });
  const sessions: AgentSession[] = [];
  async function build(manager?: SessionManager) {
    const sm = SettingsManager.inMemory({ compaction: { enabled: false, keepRecentTokens: options.keepRecentTokens ?? 20000 }, cacheWarming: "off" });
    const loader = new DefaultResourceLoader({ cwd: workspace, agentDir, settingsManager: sm, noExtensions: true,
      disabledBuiltinExtensions: ["mcp", "codemode"], noSkills: true, noThemes: true, noContextFiles: true, noPromptTemplates: true,
      extensionFactories: [{ name: "planroom", factory: createPlanroom({ agentDir }) }],
    });
    await loader.reload();
    const { session, extensionsResult } = await createAgentSession({ cwd: workspace, agentDir, model: fixtureModel, modelRuntime: runtime,
      sessionManager: manager ?? (options.fileSessions ? SessionManager.create(workspace, join(root, "sessions")) : SessionManager.inMemory(workspace)),
      settingsManager: sm, resourceLoader: loader, customTools: options.tools,
    });
    if (extensionsResult.errors.length) throw new Error(JSON.stringify(extensionsResult.errors));
    sessions.push(session); await session.bindExtensions({ mode: "print" }); return session;
  }
  const session = await build();
  return { root, workspace, agentDir, runtime, requests, session, build, dispose() { sessions.forEach(s => s.dispose()); rmSync(root, { recursive: true, force: true }); } };
}
