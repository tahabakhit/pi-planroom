import { complete, decodeSnapshot, initial, pause, restoring, start, submitted, boundedText, parseDocument, type Baseline, type CheckEvidence, type ProgressStatus, type Revision, type Snapshot } from "./model.ts";
import { capture, drift, type Policy } from "../policy/policy.ts";
import { PlanStore } from "../storage/store.ts";

export class Controller {
  state: Snapshot;
  generation = 0;
  lease = false;
  fault: string | null = null;
  readonly store: PlanStore;
  readonly persist: (state: Snapshot) => void;
  constructor(store: PlanStore, workspace: string, persist: (state: Snapshot) => void) {
    this.store = store; this.persist = persist; this.state = initial(workspace);
  }
  save(next: Snapshot): void {
    if (Buffer.byteLength(JSON.stringify(next)) > 256 * 1024) throw new Error("Snapshot exceeds 256 KiB; keep evidence concise.");
    this.persist(next); this.state = next;
  }
  restore(value: unknown): void {
    this.generation++; this.lease = false; this.fault = null;
    try {
      const decoded = decodeSnapshot(value);
      if (decoded.workspace !== this.state.workspace) throw new Error("Session workspace differs from the saved plan workspace.");
      if (decoded.revision && decoded.planId) {
        const revision = this.store.read(decoded.planId, decoded.revision);
        if (revision.hash !== decoded.hash) throw new Error("Session and artifact revision identities differ.");
        const document = parseDocument(revision.markdown);
        if (decoded.progress.length !== document.steps.length || decoded.progress.some(p => !document.steps.some(step => step.id === p.id && step.text === p.text))
          || decoded.checks.some(c => !document.verification.some(check => check.id === c.id))) throw new Error("Progress does not match the active revision.");
      }
      this.state = restoring(decoded);
    } catch (error) { this.fault = (error as Error).message; throw error; }
  }
  assertHealthy(): void { if (this.fault) throw new Error(`Planroom recovery required: ${this.fault}`); }
  begin(objective: string): void { this.assertHealthy(); this.generation++; this.lease = false; this.save(start(this.state, objective)); }
  leave(): void { this.assertHealthy(); this.generation++; this.lease = false; this.save(initial(this.state.workspace)); }
  pause(): void { this.generation++; this.lease = false; this.save(pause(this.state)); }
  materialChange(reason: string): void {
    this.assertHealthy(); reason = boundedText(reason);
    if (this.state.phase !== "implementing" || !this.lease) throw new Error("Material change requires an active implementation.");
    this.generation++; this.lease = false;
    this.save({ ...pause(this.state), changeReason: reason });
  }
  revise(): void {
    this.assertHealthy(); this.generation++; this.lease = false;
    if (!this.state.planId) throw new Error("No plan to revise.");
    this.save({ ...this.state, phase: "planning", approval: null });
  }
  plan(): Revision {
    this.assertHealthy(); const { planId, revision, hash } = this.state;
    if (!planId || !revision || !hash) throw new Error("No submitted revision. Develop a plan and call plan_submit.");
    try {
      const result = this.store.read(planId, revision);
      if (result.hash !== hash) throw new Error("Revision identity changed.");
      return result;
    } catch (error) { this.fault = (error as Error).message; this.lease = false; throw error; }
  }
  select(revision: Revision): void {
    this.assertHealthy(); this.generation++; this.lease = false;
    if (revision.workspace !== this.state.workspace) throw new Error("Open this plan from its original workspace.");
    const draft = { ...initial(revision.workspace), phase: "planning" as const, planId: revision.planId,
      objective: revision.objective, decisions: revision.decisions };
    this.save(submitted(draft, revision));
  }
  submit(markdown: string, paths: string[], policy: Policy): Revision {
    this.assertHealthy();
    if (!["planning", "ready", "paused"].includes(this.state.phase)) throw new Error("Enter planning or pause before submitting a revision.");
    if (this.state.decisions.some(d => d.blocking && d.answer === null)) throw new Error("Resolve blocking questions before submitting.");
    const baseline = new Map(this.state.baseline.map(b => [b.path, b]));
    for (const path of paths) {
      const item = capture(path, this.state.workspace, policy.readRoots);
      const old = baseline.get(item.path);
      if (old && old.hash !== item.hash) throw new Error(`Evidence changed; read it again before submitting: ${item.path}`);
      baseline.set(item.path, item);
    }
    if (baseline.size > 100) throw new Error("Limit evidence to 100 relevant files.");
    const changed = drift([...baseline.values()], this.state.workspace, policy.readRoots);
    if (changed.length) throw new Error(`Evidence changed; reinspect before submitting: ${changed.join(", ")}`);
    const revision = this.store.write(this.state, markdown, [...baseline.values()]);
    this.generation++; this.save(submitted(this.state, revision)); return revision;
  }
  inspected(item: Baseline): void {
    if (!["planning", "ready"].includes(this.state.phase)) return;
    const baseline = this.state.baseline.filter(b => b.path !== item.path); baseline.push(item);
    if (baseline.length > 100) throw new Error("Evidence baseline is full (100 files); start a more focused plan.");
    const old = this.state.baseline.find(b => b.path === item.path);
    const changedReady = this.state.phase === "ready" && old?.hash !== item.hash;
    if (changedReady) this.generation++;
    this.save({ ...this.state, baseline, ...(changedReady ? { phase: "planning", approval: null } : {}) });
  }
  question(id: string, question: string, blocking: boolean): void {
    this.assertHealthy();
    if (!["planning", "ready"].includes(this.state.phase)) throw new Error("Questions are for active planning, not implementation approval.");
    this.generation++;
    id = boundedText(id, 100); question = boundedText(question);
    const old = this.state.decisions.find(d => d.id === id);
    if (old && old.question !== question) throw new Error("Use a new question identity for a different decision.");
    const decisions = this.state.decisions.filter(d => d.id !== id);
    if (decisions.length >= 40) throw new Error("Decision bound reached.");
    decisions.push({ id, question, blocking, answer: old?.answer ?? null });
    this.save({ ...this.state, phase: "planning", approval: null, decisions });
  }
  answer(id: string, answer: string): void {
    this.assertHealthy(); id = boundedText(id, 100);
    if (!["planning", "ready", "paused"].includes(this.state.phase)) throw new Error("Return to planning before changing a decision.");
    if (!this.state.decisions.some(d => d.id === id)) throw new Error("Unknown question identity.");
    this.generation++;
    this.save({ ...this.state, phase: "planning", approval: null,
      decisions: this.state.decisions.map(d => d.id === id ? { ...d, answer: boundedText(answer) } : d) });
  }
  execution(next: Snapshot): void {
    this.assertHealthy(); this.generation++; this.save(next); this.lease = true;
  }
  progress(items: { id: string; status: ProgressStatus; evidence: string }[], checks: CheckEvidence[], finish: boolean): void {
    this.assertHealthy();
    if (this.state.phase !== "implementing" || !this.lease) throw new Error("No active human-approved implementation.");
    if (items.length > 40 || checks.length > 40) throw new Error("Progress bound exceeded.");
    const unique = <T extends { id: string }>(values: T[]) => { if (new Set(values.map(v => v.id)).size !== values.length) throw new Error("Duplicate progress/evidence identity."); };
    unique(items); unique(checks);
    const revision = this.plan(); const document = parseDocument(revision.markdown);
    const progress = this.state.progress.map(old => {
      const item = items.find(i => i.id === old.id); if (!item) return old;
      if (["implemented", "verified", "blocked"].includes(item.status) && !item.evidence.trim()) throw new Error("Describe the evidence or blocker.");
      return { ...old, status: item.status, evidence: item.evidence.trim() ? boundedText(item.evidence) : "" };
    });
    if (items.some(i => !progress.some(p => p.id === i.id)) || checks.some(c => !document.verification.some(v => v.id === c.id))) throw new Error("Progress references an unknown revision item.");
    if (progress.filter(p => p.status === "in_progress").length > 1) throw new Error("Keep at most one step in progress.");
    const evidence = new Map(this.state.checks.map(c => [c.id, c]));
    checks.forEach(c => evidence.set(c.id, c));
    let next: Snapshot = { ...this.state, progress, checks: [...evidence.values()] };
    if (finish) next = complete(next, revision);
    this.save(next); if (finish) this.lease = false;
  }
  context(): string {
    this.assertHealthy();
    if (this.state.phase === "idle") return "";
    const revision = this.state.revision ? this.plan() : null;
    return JSON.stringify({ phase: this.state.phase, objective: this.state.objective, changeReason: this.state.changeReason, revisionChangeReason: revision?.changeReason ?? null,
      planId: this.state.planId, revision: this.state.revision, hash: this.state.hash,
      decisions: this.state.decisions, progress: this.state.progress, checks: this.state.checks,
      plan: revision?.markdown ?? null });
  }
}
