import { contentText, createAssistantMessageEventStream, type AssistantMessage, type Provider, type JsonObject, type Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { simplePlan } from "./fixtures.ts";
const model: Model<"openai-completions"> = { provider: "planroom-fixture", id: "deterministic", name: "Fixture", api: "openai-completions", baseUrl: "https://fixture.invalid", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 4096 };
export default function fixture(pi: ExtensionAPI) {
  let planningTurn = 0, implementationTurn = 0;
  const call = (id: string, name: string, arguments_: JsonObject) => ({ type: "toolCall" as const, id, name, arguments: arguments_ });
  const stream: Provider["streamSimple"] = (_model, context) => {
    const s = createAssistantMessageEventStream();
    const sequence: AssistantMessage["content"][] = [
      [call("read", "read", { path: "fixture.txt" })],
      [call("denied", "write", { path: "denied.txt", content: "must never exist" })],
      [call("submit", "plan_submit", { markdown: simplePlan, evidencePaths: ["fixture.txt", "result.txt"] })],
      [call("implement", "write", { path: "result.txt", content: "done\n" })],
      [call("verify", "bash", { command: "node -e 'process.exit(0)'" })],
      [call("finish", "plan_progress", { items: [{ id: "step-1", status: "verified", evidence: "Created and checked result." }], checks: [{ id: "check-1", evidence: "Acceptance command returned 0", toolCallId: "verify" }], complete: true })],
    ];
    const stateText = context.messages.find(m => m.role === "user" && contentText(m.content).startsWith('{"phase":'));
    const state = stateText ? JSON.parse(contentText(stateText.content)) : { phase: "idle", decisions: [] };
    const phase = state.phase;
    const decision = state.decisions.find((d: { id: string }) => d.id === "encoding");
    const question = phase === "planning" && process.env.PLANROOM_TUI_QUESTIONS === "1" && planningTurn > 0;
    const content = question && !decision ? [call("question", "plan_question", { id: "encoding", question: "Encoding decision for fixture", options: ["Keep fixture encoding", "Alternative fixture encoding"], recommendation: "Keep fixture encoding", blocking: true })]
      : question && !decision.answer ? [{ type: "text" as const, text: "Decision remains open. Answer it before submission; this is not approval." }]
      : phase === "implementing" ? sequence[3 + implementationTurn++]
      : phase === "planning" ? sequence[planningTurn++] : [{ type: "text" as const, text: simplePlan }];
    const message: AssistantMessage = { role: "assistant", content: content ?? [{ type: "text", text: "Stopped" }], api: model.api, provider: model.provider, model: model.id,
      stopReason: content?.some(c => c.type === "toolCall") ? "toolUse" : "stop", timestamp: Date.now(),
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    queueMicrotask(() => { s.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message }); s.end(message); });
    return s;
  };
  pi.registerProvider({ id: model.provider, name: "Fixture", auth: { apiKey: { name: "Fixture", resolve: async () => ({ auth: { apiKey: "not-real" } }) } }, getModels: () => [model], stream: stream as Provider["stream"], streamSimple: stream });
}
