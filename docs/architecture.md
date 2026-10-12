# Architecture and invariants

Planroom uses Pi's public extension, session, model registry, and TUI APIs. It does not run a second coding agent, vendor an execution engine, or delegate authority to a workflow service.

## Three separate concerns

1. **Specification:** immutable, hashed revision documents with parent links, the original objective, decisions, and evidence references.
2. **Progress:** mutable branch-associated step status and acceptance evidence. Implementation does not rewrite the approved document to match what happened.
3. **Authority:** a live execution lease created only after the destination's user-facing confirmation. Approval records bind revision hash, workspace, session identity, and handoff intent. A stored approval is not a reusable credential.

The state machine is `idle → planning → ready → implementing → completed`. Paused work remains distinct from a completed plan. Edits/revisions return to readiness without approval. A material redesign records a durable change reason, closes the lease, and refuses old-revision approval until a replacement is submitted. The replacement carries the reason into critique and handoff.

Restoration clears every approval and live lease. An interrupted implementation restores as paused; it never dispatches work. Provider errors and explicit aborts also close the live lease. Selecting a document does not import another branch's progress or authority. A session-tree navigation restores that branch's association. Revision numbers are globally unique within a plan, while parent hashes preserve branching rather than assuming `n-1` is the parent.

## Core, adapter, and storage

- `src/core/`: bounded runtime data validation, pure lifecycle invariants, and a controller independent of Pi UI.
- `src/storage/`: SHA-256 integrity, exclusive immutable publication, per-plan writer locks, and explicit non-overwriting export.
- `src/policy/`: conservative planning tool/path/shell decisions and evidence hashes.
- `src/tools/`: questions, submission, bounded reads, and implementation evidence.
- `src/ui/`: sanitized scrollable Markdown and faithful parent comparison.
- `src/handoff/`: the minimal destination packet.
- `src/review/`: one explicitly selected tool-free model critique with bounded, validated output.
- `src/index.ts`: the public Pi adapter, event hooks, commands, and human decisions.

Revisions are written before their session association. If the latter fails, the immutable revision remains discoverable; no implementation is retried. Files are published through a same-directory exclusive temporary file, fsync, and hard-link publication. Existing files are never replaced. Locks record process identity, and recovery only archives a provably dead reservation. Incomplete/malformed/live locks are not automatically stolen.

Storage is designed for a local POSIX filesystem. It is not an encrypted vault, distributed lock service, authenticated audit log, or defense against a hostile process running as the same user. See [Recovery](recovery.md).

## Evidence and drift

Successful native planning reads establish baselines before/after the read. Submission checks those baselines, and approval checks again before and after its dialogs. Immutable artifact integrity is revalidated after those dialogs and at admitted implementation tool boundaries. An explicit evidence path may also represent a file that does not yet exist. Changes require reinspection; adding a path to submission cannot silently refresh stale evidence.

During implementation, successful native writes/edits/Bash results checkpoint relevant files. A changed checkpoint invalidates previous check evidence and downgrades verified steps to implemented. A failed operation that changes tracked evidence closes the lease. Progress/completion checks current baselines rather than accepting external drift silently.

Only the latest matching native Bash result with `structuredContent.exit_code === 0`, the exact leading verification command, and the current revision/checkpoint can establish observed command evidence. The host associates this result automatically; the model need not quote opaque tool-call IDs. A later failed matching command removes earlier check evidence, and an old ID cannot resurrect it. Compound commands do not establish a differently written standalone check. Text assertions and forged/failed/mismatched references cannot establish observed evidence. Manual/non-command evidence is reported until explicitly confirmed by the user. This proves that a named command returned success, **not** that the command was a meaningful test; plan quality and honest manual confirmation still matter.

Coverage is deliberately finite: at most 100 relevant files, each no larger than 2 MiB; up to 40 steps, checks, and decisions; a 64 KiB Markdown document; a 256 KiB revision/snapshot record; up to 1,000 revisions in one plan and 1,000 plans in the active browser. Verified step labels are model-reported progress; command/manual acceptance evidence remains a separate requirement for completion. It is not whole-workspace monitoring. External effects and files that were never tracked are outside this evidence model.

## Context and compaction

The system guidance changes by explicit mode. A single transient context message reports objective, identity, decisions, progress, and active content. If the exact submission/handoff is already retained, it references that document instead of reinserting it. After compaction drops that document, canonical content is recovered from the integrity-checked artifact. The context injection is not durably appended every turn.

Custom session entries associate state outside ordinary LLM messages. Approval comes from commands/dialogs, never from text matching, model-generated approval markers, or a model approval tool.

## Fresh sessions

The source previews a packet, then creates a linked session through `ctx.newSession()` with `setup` and `withSession`. The packet carries the exact document, objective, decisions, file checkpoints, and progress—not arbitrary conversation or inherited permission claims. A destination user message makes the review session durable even if approval is declined.

The destination re-enters `/plan implement` using its own command context. It reloads settings, verifies the workspace and baselines, exposes its current instructions and model, and requires approval there. Source UI/context/actions are never used to execute in the destination. A failed/uncertain handoff is not blindly dispatched again; inspect the destination first.

## Independent critique

Critique sends only the original objective, exact document, decisions, revision-change reason, and evidence references. No tools or raw source files are supplied. It uses the selected public model-registry route directly, does not reuse the main agent's transcript, and does not switch the session model. Main-session provider-request extension hooks are not replayed; environments that depend on those hooks for outbound policy must evaluate this route before using critique.

The extension disables supported client retries, applies timeout/output limits, rejects tool calls/truncation/malformed JSON, and records actual returned usage when available. Limits are best effort for trusted provider implementations, not guaranteed billing caps. Usage/cost is stored in private review artifacts and custom entries **separately from Pi's main-session totals**. Review is advisory; even a `ready` verdict cannot create an approval. Obsolete/cancelled/failed results cannot attach to a different revision.
