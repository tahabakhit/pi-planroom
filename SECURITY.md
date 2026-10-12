# Security

Report sensitive vulnerabilities through the repository's private security reporting when available. If unavailable, open an issue asking for a private reporting channel **without** attaching secrets, exploit credentials, or private plans.

## Trust boundary

Planroom is an extension-level collaboration and planning gate, **not an OS sandbox**. It protects ordinary host-mediated tool calls, including nested `executeTool()` calls, while a planning association is active. It does not constrain trusted extension/provider code that performs effects directly, interactive user commands, other processes, hostile same-user filesystem races, executable replacement, or inherited environment behavior.

Planning rejects unknown tools, direct editing, codemode/PowerShell, unsupported shell syntax, inadmissible paths, and known credential locations. An explicitly admitted custom tool or command is a deliberate widening of that boundary. Read-only annotations and command names are not evidence that an implementation is harmless. Tests/builds can mutate files or operate services.

Approval closes the planning boundary and restores the host's existing implementation policy for that live session. It does not change tool selection or grant OS privileges. Planroom cannot make an otherwise unrestricted host into a deployment/destruction permission system. Configure those permissions independently; do not rely on the plan prompt to enforce operational authority.

## Approval and untrusted content

There is no model approval tool. Submission, reviewer verdicts, answers, exported files, quoted instructions, and text saying "approved" are not approval. Human-facing confirmation binds exact revision/workspace/session identity. Restoration and branch navigation clear live leases. RPC clients are responsible for obtaining a genuine user decision before sending a confirmation; the extension cannot authenticate the person behind a protocol response.

Documents and reviewer output are bounded/validated data. Terminal control and bidirectional-control characters are rejected or sanitized for rendering. Markdown rendering is not an execution mechanism. Plans can still contain bad advice or meaningful-looking but useless tests; the user remains the final decision-maker.

## Evidence and persistence

SHA-256 identifies immutable content; it is not a signature or protection against a malicious same-user editor who can recompute hashes. Atomic exclusive publication and local locks prevent normal overwrite/concurrency failures, not distributed or adversarial filesystem behavior. Only local POSIX filesystems are qualified.

Relevant-file checkpoints and command results provide bounded evidence, not universal effect monitoring. A successful check can be meaningless; a failed/aborted process can already have changed files or external systems. Stop, inspect, and re-review uncertain work rather than replaying it.

Artifacts and ordinary session files are potentially sensitive and unencrypted. Known credential paths are rejected, but secrets can exist under other names or in Git history. Never submit secrets to a plan or critique. An independent reviewer uses the explicitly selected provider route, with no tools/source files and no automatic fallback. Output/time limits and cancellation are best effort, not a guaranteed spending cap.

See [Architecture](docs/architecture.md) and [Recovery](docs/recovery.md) for the precise coverage and limits.
