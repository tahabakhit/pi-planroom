import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { boundedText, parseDocument, type CheckEvidence } from "../core/model.ts";
import type { Controller } from "../core/controller.ts";
import { drift, type Settings } from "../policy/policy.ts";

export interface Observation { command: string; hash: string; passed: boolean }
export interface ToolRuntime {
  controller(): Controller;
  config(): Settings;
  update(): void;
  observations: Map<string, Observation>;
  inFlight: Set<string>;
}
function matchingObservation(runtime: ToolRuntime, hash: string, command: string | undefined): [string, Observation] | undefined {
  if (!command) return undefined;
  const latest = [...runtime.observations].reverse().find(([, item]) => item.hash === hash && item.command.trim() === command);
  return latest?.[1].passed ? latest : undefined;
}
const text = (maxLength = 8000) => Type.String({ minLength: 1, maxLength });
const object = <T extends Record<string, import("typebox").TSchema>>(properties: T) => Type.Object(properties, { additionalProperties: false });
const output = (text: string, details: unknown, terminate = false) => ({ content: [{ type: "text" as const, text }], details, ...(terminate ? { terminate: true } : {}) });
export function registerTools(pi: ExtensionAPI, runtime: ToolRuntime): void {
  pi.registerTool({
    name: "plan_question", label: "Planning question", exposure: "model-only", executionMode: "sequential",
    description: "Only in explicit Planroom planning. Ask a material user decision after discovering facts. Answers are not approval. Dismissal leaves the decision open. Use a stable question id; options must be meaningful, not filler.",
    parameters: object({ id: text(100), question: text(), blocking: Type.Boolean(),
      options: Type.Optional(Type.Array(text(1000), { minItems: 2, maxItems: 4, uniqueItems: true })), recommendation: Type.Optional(text(1000)) }),
    execute: async (_id, params, signal, _update, ctx) => {
      const options = params.options?.map(option => boundedText(option, 1000));
      if (options && (new Set(options).size !== options.length || options.includes("Custom answer…"))) throw new Error("Use distinct options without the reserved custom-answer label.");
      const recommendation = params.recommendation ? boundedText(params.recommendation, 1000) : undefined;
      const question = boundedText(params.question);
      const controller = runtime.controller(); controller.question(params.id, question, params.blocking);
      const epoch = controller.generation; runtime.update();
      if (!ctx.hasUI) return output("No interactive answers are available. This question remains open; return the question and current limitations as your final text to the user, then stop. Do not assume approval or resolve a blocking decision yourself.", { question: params }, ctx.mode !== "print");
      const title = question + (recommendation ? `\nRecommendation: ${recommendation}` : "");
      let answer: string | undefined;
      if (options) {
        const chosen = await ctx.ui.select(title, [...options, "Custom answer…"], { signal });
        if (chosen === "Custom answer…") answer = await ctx.ui.editor("Your answer", "");
        else if (chosen) {
          const note = await ctx.ui.input("Optional note (leave empty to keep the selected answer)", "", { signal });
          // Dismissal of the note dialog also dismisses the pending question.
          if (note !== undefined) answer = chosen + (note.trim() ? `\nNote: ${note.trim()}` : "");
        }
      } else answer = await ctx.ui.editor(title, "");
      if (runtime.controller() !== controller || epoch !== controller.generation || signal?.aborted) throw new Error("Question belongs to an obsolete or cancelled planning interaction.");
      if (answer?.trim()) controller.answer(params.id, boundedText(answer));
      runtime.update();
      return output(answer?.trim() ? `Decision ${params.id}: ${answer}\nThis answer is not implementation approval.` : "Question dismissed; the decision remains open.", { id: params.id, answer: answer?.trim() || null });
    },
  });
  pi.registerTool({
    name: "plan_submit", label: "Submit plan", exposure: "model-only", executionMode: "sequential",
    description: "Submit a complete Markdown plan for human review, alone as the last tool call. Begin '# Title' and include nonempty '## Goal', '## Approach', '## Implementation', and '## Verification'. Implementation and Verification need top-level bullets. Use exact commands in backticks at the start of verification bullets when command evidence is applicable. Include consequential assumptions/risks. Submission is not approval.",
    parameters: object({ markdown: text(65536), evidencePaths: Type.Optional(Type.Array(text(4096), { maxItems: 100 })) }),
    execute: async (_id, params, _signal, _update, ctx) => {
      const controller = runtime.controller();
      const revision = controller.submit(params.markdown, params.evidencePaths ?? [], runtime.config().policy);
      runtime.update();
      return output(`${revision.markdown}\n\nPlanroom: revision ${revision.number} is ready, not approved. Open /plan to review, revise, save, export, or implement.${ctx.mode === "print" ? " Return this exact Markdown as your final text answer, then stop. Headless planning cannot approve or implement." : ""}`, { schema: 1, planId: revision.planId, number: revision.number, hash: revision.hash }, ctx.mode !== "print");
    },
  });
  pi.registerTool({
    name: "plan_read", label: "Read active plan", annotations: { readOnlyHint: true, destructiveHint: false },
    description: "Read the active Planroom revision or planning decisions/progress. Does not select another plan or grant authority. Large documents can be read in bounded line ranges.",
    parameters: object({ revision: Type.Optional(Type.Integer({ minimum: 1 })), offset: Type.Optional(Type.Integer({ minimum: 1 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })) }),
    execute: async (_id, params) => {
      const controller = runtime.controller(); controller.assertHealthy();
      if (!controller.state.revision) return output(JSON.stringify(controller.state, null, 2), { state: controller.state });
      const active = controller.plan();
      const revision = params.revision ? controller.store.read(active.planId, params.revision) : active;
      const lines = revision.markdown.split("\n"), offset = (params.offset ?? 1) - 1, limit = params.limit ?? 120;
      const criteria = parseDocument(revision.markdown).verification;
      const observed = criteria.map(check => ({ id: check.id, command: check.command ?? null,
        matchingSuccessfulCall: matchingObservation(runtime, revision.hash, check.command)?.[0] ?? null }));
      return output(`Plan ${revision.planId} · revision ${revision.number} · ${revision.hash}\n${lines.slice(offset, offset + limit).join("\n")}\n\nLines ${offset + 1}–${Math.min(lines.length, offset + limit)} of ${lines.length}.\nProgress/decisions: ${JSON.stringify({ phase: controller.state.phase, progress: controller.state.progress, checks: controller.state.checks, decisions: controller.state.decisions, acceptanceCriteria: criteria, observedCommands: observed })}`, { planId: revision.planId, revision: revision.number, hash: revision.hash });
    },
  });
  pi.registerTool({
    name: "plan_progress", label: "Implementation progress", exposure: "model-only", executionMode: "sequential",
    description: "Only during a human-approved Planroom implementation. Update known step-N/check-N identities from plan_read. Run acceptance commands exactly as written, as standalone Bash calls. The host automatically binds successful exact matching calls as observed evidence; no need to guess tool-call IDs. Other evidence is reported until human confirmation. Material redesign pauses implementation and returns to review. complete=true requires verified steps and credible evidence for every check; call it alone and last.",
    parameters: object({
      items: Type.Array(object({ id: text(100), status: Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("implemented"), Type.Literal("verified"), Type.Literal("blocked")]), evidence: Type.String({ maxLength: 8000 }) }), { maxItems: 40 }),
      checks: Type.Optional(Type.Array(object({ id: text(100), evidence: text(), toolCallId: Type.Optional(text(200)) }), { maxItems: 40 })),
      complete: Type.Optional(Type.Boolean()), materialChange: Type.Optional(text()),
    }),
    execute: async (id, params) => {
      const controller = runtime.controller();
      if (controller.state.phase !== "implementing" || !controller.lease) throw new Error("Implementation is not approved in this live session.");
      if (params.materialChange) {
        const change = boundedText(params.materialChange);
        controller.materialChange(change); runtime.update();
        return output(`Implementation paused; a replacement revision is required for material redesign: ${change}. Open /plan and revise before further implementation.`, { materialChange: params.materialChange }, true);
      }
      if (params.complete && [...runtime.inFlight].some(other => other !== id)) throw new Error("Wait for sibling tool calls before completing the plan.");
      if (drift(controller.state.baseline, controller.state.workspace, runtime.config().policy.readRoots).length) {
        controller.pause(); runtime.update(); throw new Error("Acceptance evidence changed outside an observed checkpoint. Reinspect and return to review.");
      }
      const revision = controller.plan(); const definitions = parseDocument(revision.markdown).verification;
      const checks: CheckEvidence[] = (params.checks ?? []).map(check => {
        const definition = definitions.find(d => d.id === check.id);
        const matching = matchingObservation(runtime, revision.hash, definition?.command);
        const toolCallId = check.toolCallId ?? matching?.[0];
        let source: CheckEvidence["source"] = "reported";
        if (toolCallId) {
          const observed = runtime.observations.get(toolCallId);
          if (!observed?.passed || observed.hash !== revision.hash || !definition?.command || definition.command !== observed.command.trim() || matching?.[0] !== toolCallId) throw new Error("Observed evidence must reference the latest successful matching command for this exact revision/checkpoint.");
          source = "observed";
        }
        return { id: check.id, evidence: boundedText(check.evidence), source, ...(toolCallId ? { toolCallId } : {}) };
      });
      for (const definition of definitions) {
        if (!definition.command || checks.some(check => check.id === definition.id)) continue;
        const observation = matchingObservation(runtime, revision.hash, definition.command);
        if (observation) checks.push({ id: definition.id, source: "observed", toolCallId: observation[0], evidence: `Native Bash returned exit code 0 for the exact command: ${definition.command}` });
      }
      if (params.complete) {
        const missing = definitions.filter(definition => ![...controller.state.checks, ...checks].some(check => check.id === definition.id && check.source !== "reported"));
        if (missing.length) {
          controller.progress(params.items, checks, false); runtime.update();
          throw new Error(`Missing credible acceptance evidence: ${missing.map(check => `${check.id}${check.command ? ` — run exactly as a standalone Bash call: ${check.command}` : " — report evidence, then obtain human confirmation through /plan complete"}`).join("; ")}`);
        }
      }
      controller.progress(params.items, checks, params.complete ?? false); runtime.update();
      return output(JSON.stringify({ phase: controller.state.phase, progress: controller.state.progress, checks: controller.state.checks }), { state: controller.state }, params.complete ?? false);
    },
  });
}
