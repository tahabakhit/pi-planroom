import { createHash, randomUUID } from "node:crypto";

export const STATE_ENTRY = "pi-planroom.state";
export const MAX_DOCUMENT_BYTES = 64 * 1024;
export type Phase = "planning" | "ready" | "implementing" | "paused" | "completed" | "idle";
export type ProgressStatus = "pending" | "in_progress" | "implemented" | "verified" | "blocked";
export interface Baseline { path: string; hash: string | null }
export interface Decision { id: string; question: string; blocking: boolean; answer: string | null }
export interface Progress { id: string; text: string; status: ProgressStatus; evidence: string }
export interface Verification { id: string; text: string; command?: string }
export interface CheckEvidence { id: string; evidence: string; source: "observed" | "reported" | "human"; toolCallId?: string }
export interface Approval { hash: string; workspace: string; session: string; destination: "here" | "fresh" }
export interface Snapshot {
  schema: 1; phase: Phase; planId: string | null; revision: number | null;
  hash: string | null; objective: string; workspace: string; decisions: Decision[];
  baseline: Baseline[]; progress: Progress[]; checks: CheckEvidence[]; approval: Approval | null; changeReason: string | null;
}
export interface Revision {
  schema: 1; planId: string; number: number; parent: string | null; hash: string;
  title: string; markdown: string; workspace: string; objective: string;
  baseline: Baseline[]; decisions: Decision[]; changeReason: string | null; createdAt: string;
}
export interface Document { title: string; markdown: string; steps: { id: string; text: string }[]; verification: Verification[] }
export const digest = (text: string | Buffer): string => createHash("sha256").update(text).digest("hex");
export const newId = (): string => randomUUID();
export function boundedText(value: unknown, max = 8000): string {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(value)) throw new Error("Expected bounded, nonempty text without terminal controls.");
  return value.trim().replace(/\r\n?/g, "\n");
}
export function parseDocument(input: unknown): Document {
  const markdown = boundedText(input, MAX_DOCUMENT_BYTES).replace(/\r\n?/g, "\n");
  const lines = markdown.split("\n");
  const first = lines[0].match(/^# (.+)$/);
  if (!first) throw new Error("The plan must begin with '# Title'.");
  const sections = new Map<string, string[]>();
  let active = "", fence = "";
  for (const line of lines.slice(1)) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = "";
      if (active) sections.get(active)!.push(line);
      continue;
    }
    const heading = !fence && /^## (.+)$/.exec(line);
    if (heading) {
      active = heading[1].trim();
      if (sections.has(active)) throw new Error(`Duplicate section: ${active}`);
      sections.set(active, []);
    } else if (active) sections.get(active)!.push(line);
  }
  if (fence) throw new Error("Close the Markdown code fence before submitting.");
  for (const name of ["Goal", "Approach", "Implementation", "Verification"]) {
    if (!sections.get(name)?.join("\n").trim()) throw new Error(`Include a nonempty '## ${name}' section.`);
  }
  const bullets = (name: string): string[] => {
    const result: string[] = []; let fence = "";
    for (const line of sections.get(name) ?? []) {
      const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
      if (marker) {
        if (!fence) fence = marker;
        else if (marker[0] === fence[0] && marker.length >= fence.length) fence = "";
        continue;
      }
      if (fence) continue;
      const match = /^(?:[-*] |\d+[.)] )(.+)$/.exec(line);
      if (match) result.push(boundedText(match[1], 2000));
    }
    if (!result.length || result.length > 40) throw new Error(`Use 1–40 top-level bullets in ${name}.`);
    return result;
  };
  return {
    title: boundedText(first[1], 200), markdown,
    steps: bullets("Implementation").map((text, i) => ({ id: `step-${i + 1}`, text })),
    verification: bullets("Verification").map((text, i) => {
      const command = /^`([^`]+)`(?:\s|$)/.exec(text)?.[1].trim();
      return { id: `check-${i + 1}`, text, ...(command ? { command } : {}) };
    }),
  };
}
export function initial(workspace: string): Snapshot {
  return { schema: 1, phase: "idle", planId: null, revision: null, hash: null, objective: "", workspace, decisions: [], baseline: [], progress: [], checks: [], approval: null, changeReason: null };
}
export function start(state: Snapshot, objective: string): Snapshot {
  if (state.phase !== "idle" && state.phase !== "completed") throw new Error("Leave or finish the current plan before starting another.");
  return { ...initial(state.workspace), phase: "planning", planId: newId(), objective: boundedText(objective) };
}
export function submitted(state: Snapshot, revision: Revision): Snapshot {
  if (!["planning", "ready", "paused"].includes(state.phase)) throw new Error("Pause implementation before revising.");
  if (state.decisions.some(d => d.blocking && d.answer === null)) throw new Error("Resolve blocking questions before submitting a ready plan.");
  if (state.planId !== revision.planId || state.workspace !== revision.workspace) throw new Error("Revision does not belong to this plan/workspace.");
  const document = parseDocument(revision.markdown);
  return { ...state, phase: "ready", revision: revision.number, hash: revision.hash, baseline: revision.baseline,
    approval: null, changeReason: null, progress: document.steps.map(step => ({ ...step, status: "pending", evidence: "" })), checks: [] };
}
export function approve(state: Snapshot, hash: string, session: string, destination: "here" | "fresh"): Snapshot {
  if (!["ready", "paused"].includes(state.phase) || !state.hash || state.hash !== hash) throw new Error("Approval is stale or the plan is not ready.");
  if (state.decisions.some(d => d.blocking && d.answer === null)) throw new Error("Unresolved blocking decisions.");
  if (state.changeReason) throw new Error("Material change requires a newly submitted revision before approval.");
  return { ...state, phase: "implementing", approval: { hash, workspace: state.workspace, session, destination } };
}
export function pause(state: Snapshot): Snapshot {
  if (!state.planId) return state;
  return { ...state, phase: state.phase === "completed" ? "completed" : "paused", approval: null };
}
export function restoring(state: Snapshot): Snapshot {
  return state.phase === "implementing" ? pause(state) : { ...state, approval: null };
}
export function canComplete(state: Snapshot, revision: Revision): boolean {
  const document = parseDocument(revision.markdown), checks = document.verification;
  return state.phase === "implementing" && state.approval?.hash === state.hash
    && revision.hash === state.hash && revision.planId === state.planId && revision.number === state.revision && revision.workspace === state.workspace
    && !state.changeReason && state.approval.workspace === state.workspace
    && state.progress.length === document.steps.length && document.steps.every(step => state.progress.some(p => p.status === "verified" && step.id === p.id && step.text === p.text))
    && checks.every(c => state.checks.some(e => e.id === c.id && e.source !== "reported" && !!e.evidence));
}
export function complete(state: Snapshot, revision: Revision): Snapshot {
  if (!canComplete(state, revision)) throw new Error("Completion requires verified steps and observed or human-confirmed evidence for every acceptance check.");
  return { ...state, phase: "completed", approval: null };
}
const record = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("Invalid record.");
  return v as Record<string, unknown>;
};
const array = <T>(v: unknown, decode: (v: unknown) => T, max = 100): T[] => {
  if (!Array.isArray(v) || v.length > max) throw new Error("Invalid bounded array.");
  return v.map(decode);
};
export function decodeBaseline(v: unknown): Baseline[] {
  const paths = new Set<string>();
  return array(v, item => {
    const r = record(item); const path = boundedText(r.path, 4096);
    if (paths.has(path)) throw new Error("Duplicate baseline path."); paths.add(path);
    if (r.hash !== null && (typeof r.hash !== "string" || !/^[a-f0-9]{64}$/.test(r.hash))) throw new Error("Invalid baseline hash.");
    return { path, hash: r.hash as string | null };
  });
}
export function decodeDecisions(v: unknown): Decision[] {
  return array(v, item => {
    const r = record(item);
    if (typeof r.blocking !== "boolean") throw new Error("Invalid question flag.");
    return { id: boundedText(r.id, 100), question: boundedText(r.question), blocking: r.blocking,
      answer: r.answer === null ? null : boundedText(r.answer) };
  }, 40);
}
export function decodeSnapshot(v: unknown): Snapshot {
  if (Buffer.byteLength(JSON.stringify(v)) > 256 * 1024) throw new Error("Snapshot exceeds 256 KiB.");
  const r = record(v);
  if (r.schema !== 1 || !["idle", "planning", "ready", "implementing", "paused", "completed"].includes(String(r.phase))) throw new Error("Unsupported Planroom state schema/phase.");
  const state = initial(boundedText(r.workspace, 4096));
  state.phase = r.phase as Phase;
  state.planId = r.planId === null ? null : boundedText(r.planId, 100);
  if (state.planId && !/^[a-f0-9-]{36}$/.test(state.planId)) throw new Error("Invalid plan identity.");
  if (r.revision !== null && (!Number.isSafeInteger(r.revision) || Number(r.revision) < 1)) throw new Error("Invalid revision.");
  state.revision = r.revision as number | null;
  if (r.hash !== null && (typeof r.hash !== "string" || !/^[a-f0-9]{64}$/.test(r.hash))) throw new Error("Invalid revision hash.");
  state.hash = r.hash as string | null;
  state.objective = r.objective === "" ? "" : boundedText(r.objective);
  state.baseline = decodeBaseline(r.baseline); state.decisions = decodeDecisions(r.decisions);
  state.changeReason = r.changeReason === null ? null : boundedText(r.changeReason);
  state.progress = array(r.progress, item => {
    const p = record(item);
    if (!["pending", "in_progress", "implemented", "verified", "blocked"].includes(String(p.status))) throw new Error("Invalid progress status.");
    return { id: boundedText(p.id, 100), text: boundedText(p.text, 2000), status: p.status as ProgressStatus,
      evidence: p.evidence === "" ? "" : boundedText(p.evidence) };
  }, 40);
  state.checks = array(r.checks, item => {
    const e = record(item);
    if (!["observed", "reported", "human"].includes(String(e.source))) throw new Error("Invalid evidence source.");
    return { id: boundedText(e.id, 100), evidence: boundedText(e.evidence), source: e.source as CheckEvidence["source"],
      ...(e.toolCallId ? { toolCallId: boundedText(e.toolCallId, 200) } : {}) };
  }, 40);
  if (r.approval !== null) {
    const a = record(r.approval);
    if (a.hash !== state.hash || a.workspace !== state.workspace || !["here", "fresh"].includes(String(a.destination))) throw new Error("Invalid approval identity.");
    state.approval = { hash: boundedText(a.hash, 64), workspace: state.workspace,
      session: boundedText(a.session, 200), destination: a.destination as Approval["destination"] };
  }
  if (state.phase === "idle" && (state.planId || state.revision || state.hash || state.objective || state.baseline.length || state.decisions.length || state.progress.length || state.checks.length || state.approval)) throw new Error("Idle state cannot retain an active association.");
  if (state.phase !== "idle" && (!state.planId || !state.objective)) throw new Error("Missing plan identity/objective.");
  if ((state.revision === null) !== (state.hash === null)) throw new Error("Incomplete revision identity.");
  if (!state.revision && (state.progress.length || state.checks.length)) throw new Error("Drafts cannot carry implementation progress.");
  if ((state.phase === "implementing") !== (state.approval !== null)) throw new Error("Approval/phase mismatch.");
  if (state.changeReason && !["planning", "paused"].includes(state.phase)) throw new Error("Material-change state requires revision review.");
  if (["ready", "implementing", "completed"].includes(state.phase) && (!state.hash || !state.revision)) throw new Error("Missing ready revision.");
  for (const list of [state.progress, state.checks, state.decisions]) {
    if (new Set(list.map(x => x.id)).size !== list.length) throw new Error("Duplicate item identity.");
  }
  return state;
}
export function decodeRevision(v: unknown): Revision {
  const r = record(v); const doc = parseDocument(r.markdown);
  if (r.schema !== 1 || typeof r.planId !== "string" || !/^[a-f0-9-]{36}$/.test(r.planId)
    || !Number.isSafeInteger(r.number) || Number(r.number) < 1 || r.title !== doc.title) throw new Error("Invalid revision identity.");
  const baseline = decodeBaseline(r.baseline), decisions = decodeDecisions(r.decisions);
  const body = { schema: 1 as const, planId: r.planId, number: r.number as number, parent: r.parent as string | null,
    title: doc.title, markdown: doc.markdown, workspace: boundedText(r.workspace, 4096),
    objective: boundedText(r.objective), baseline, decisions, changeReason: r.changeReason === null ? null : boundedText(r.changeReason), createdAt: boundedText(r.createdAt, 100) };
  if (body.parent !== null && (typeof body.parent !== "string" || !/^[a-f0-9]{64}$/.test(body.parent))) throw new Error("Invalid parent identity.");
  if (digest(JSON.stringify(body)) !== r.hash) throw new Error("Revision integrity check failed.");
  return { ...body, hash: r.hash as string };
}
export function makeRevision(state: Snapshot, number: number, markdown: string, baseline: Baseline[]): Revision {
  if (!state.planId) throw new Error("No plan is active.");
  const doc = parseDocument(markdown);
  const body = { schema: 1 as const, planId: state.planId, number, parent: state.hash,
    title: doc.title, markdown: doc.markdown, workspace: state.workspace, objective: state.objective,
    baseline, decisions: state.decisions, changeReason: state.changeReason, createdAt: new Date().toISOString() };
  return { ...body, hash: digest(JSON.stringify(body)) };
}
