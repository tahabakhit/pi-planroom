import type { Revision, Snapshot } from "../core/model.ts";
export function handoffPacket(revision: Revision, state: Snapshot): { state: Snapshot; markdown: string } {
  if (revision.hash !== state.hash || revision.workspace !== state.workspace) throw new Error("Handoff identity mismatch.");
  return {
    state: { ...state, phase: "ready", approval: null },
    markdown: `# Planroom implementation handoff\n\n${revision.markdown}\n\n## Planning findings\nOriginal objective: ${revision.objective}\nDecisions: ${JSON.stringify(revision.decisions)}\nRevision change reason: ${JSON.stringify(revision.changeReason)}\nEvidence references/checkpoints: ${JSON.stringify(state.baseline)}\n\n## Execution checkpoint (not approval)\n${JSON.stringify({ progress: state.progress, checks: state.checks })}\n\nNo arbitrary session permissions transfer. Recheck current instructions and obtain approval in this destination before implementation.`,
  };
}
