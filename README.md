# Planroom

**Plan first. Review exact content. Implement deliberately.**

Planroom is a standalone [Pi](https://github.com/earendil-works/pi) extension. It turns planning into a durable collaboration workflow, rather than a prompt toggle or a checklist inferred from model output.

- Investigate without editing: a runtime gate restricts planning tools, including nested calls.
- Ask consequential questions; unanswered blockers prevent submission.
- Review full Markdown, edit directly, provide feedback, and compare immutable revisions.
- Approve a specific revision, workspace, destination session, and implementation model.
- Implement here or in a fresh linked session with the exact plan and essential findings.
- Track implementation separately from observed acceptance evidence.
- Resume, fork, or compact without silently restoring execution authority.
- Optionally choose an independent, tool-free reviewer with bounded output and separately recorded usage.

**Planroom is not an OS sandbox or a replacement for your host's execution permissions.** Approval removes the planning gate for an implementation session; it does not change Pi's tool selection, operating-system privileges, or other extensions' permission decisions. Publication, deployment, destructive work, and installs still require whatever authority your environment normally demands. See [Security](SECURITY.md).

## Requirements

- Pi **1.1.0** or a compatible 1.x release. Qualification is against 1.1.0; future Pi releases need requalification.
- Node **22.19+**, with native TypeScript support enabled by the runtime, or Pi's normal extension loader.
- Linux or macOS, local POSIX storage, and Bash for shell inspection. Windows and network filesystems are not qualified.
- Your own configured Pi provider. No provider, model, thinking level, or API key is installed by Planroom.

## Install

From the public Git repository:

```sh
pi install git:github.com/tahabakhit/pi-planroom@v1.0.0
```

When the package is available on npm:

```sh
pi install npm:pi-planroom
```

Or try a checkout for one invocation without changing configured packages:

```sh
pi -e ./src/index.ts
```

If you use an explicit tool allowlist, include the Planroom tools alongside the desired native tools; Planroom does not silently enable disabled tools. Do not load two planning extensions with the same commands/tools. Installation and removal use Pi's ordinary package management; Planroom does not edit your global settings itself.

## Everyday workflow

1. Run `/plan Add resumable uploads while preserving the current API`.
2. Let the agent inspect code and instructions. Answer material decisions when asked.
3. The agent submits a complete document. **Ready is not approved.**
4. Open `/plan`. Read the full document, revise, compare, critique, save, or export it.
5. Choose **Implement here** or **Implement fresh**. The destination shows the exact revision and asks for approval. Cancellation starts nothing.
6. Implementation updates `step-N` and `check-N` evidence through `plan_progress`.
7. Successful matching Bash calls can establish observed checks. Non-command/manual checks require your explicit confirmation through `/plan complete`.

An ordinary end-of-turn is never treated as completion. A material redesign pauses implementation and returns to review. `/plan pause` closes the execution lease and aborts further work; it cannot undo effects already in flight.

### Commands

| Command | Purpose |
| --- | --- |
| `/plan [request]` | Start planning, provide revision feedback, or open controls |
| `/plan show`, `/plan status` | Read the complete plan or decisions/progress/evidence |
| `/plan list`, `/plan history` | Browse saved plans or select an immutable revision without authority |
| `/plan review` | Open the review controls |
| `/plan edit`, `/plan revise <feedback>`, `/plan diff` | Edit, ask for a revision, or compare with the branch parent |
| `/plan answer <id> <answer>` | Answer a pending planning question; never approve execution |
| `/plan critique` | Explicitly choose and invoke an independent reviewer |
| `/plan save`, `/plan export [new.md]` | Save for later or create a new Markdown file inside the workspace |
| `/plan implement`, `/plan fresh` | Review/approve here or create a linked destination for approval |
| `/plan pause`, `/plan complete` | Stop the lease or explicitly confirm acceptance evidence |
| `/plan exit` | Keep artifacts and return to ordinary host policy without dispatch |
| `/plan recover`, `/plan help` | Inspect recovery or get help |

A request whose first word is a command name is interpreted as that command. Use the `/plan` objective editor if your request would be ambiguous.

### Document format

```markdown
# Resumable uploads

## Goal
Resume an interrupted upload without changing the public request schema.

## Approach
Reuse the existing upload store and add a validated offset checkpoint.

## Implementation
- Add checkpoint persistence and recovery.
- Cover interruption, stale checkpoints, and compatibility.

## Verification
- `npm test` passes the recovery and compatibility cases.
- A manual interrupted-upload exercise resumes at the recorded offset.

## Assumptions and risks
Keep the existing storage backend; a backend change would require review.
```

Required headings are case-sensitive. Implementation and Verification each need 1–40 top-level bullets. Documents are bounded to 64 KiB. Leading backticked verification commands are matched exactly against the latest native Bash tool results, not parsed from prose or claimed by the model. Run them as standalone calls; the host automatically associates a successful result, so the model need not guess opaque call IDs. A later failed result invalidates earlier success.

## Interfaces

- **TUI:** scrollable Markdown review, dialogs, an editable document, footer state, and active-step status. No default shortcut is taken. You can explicitly configure an unbound function key.
- **RPC:** uses Pi's documented extension UI request/response protocol. Full-document views use an editor dialog; edits in a read view are discarded. The client must deliberately supply the human approval response. Terminal components are not used.
- **Print/JSON:** can investigate, ask unresolved questions, submit, and read documents. Print mode asks the model to return the exact submitted Markdown as final text; JSON also exposes the submission result and state entries. **Headless planning cannot approve, export, or lift its gate.** Model text remains untrusted; durable JSON revisions are authoritative.

See [Configuration](docs/configuration.md), [Architecture](docs/architecture.md), [Recovery](docs/recovery.md), and [Testing and release](docs/testing.md).

## Private storage

Plan artifacts live in `<Pi agent directory>/pi-planroom/plans/<plan-id>/`, not in the repository. New directories/files are owner-only (0700/0600). Revision files contain the original objective, plan, decisions, evidence hashes, and parent identity. Execution state is associated with the current Pi session-tree branch.

There is no encryption, automatic remote sync, or background review. Treat both Planroom artifacts and ordinary Pi session files as potentially sensitive. Export is explicit, writes a new `.md` file only, and carries no approval authority.

## Development

```sh
npm ci --ignore-scripts
npm run check
npm run pack:check
npm run qualify:package
```

Package qualification also tests installation/removal in a disposable profile and runs an automated real-terminal workflow. It requires Python 3 and `tar` on the development machine; installed users do not need them. Provider-backed qualification is separately opt-in and is never hidden inside offline tests. See [Testing and release](docs/testing.md).

MIT licensed. Contributions and reproducible bug reports are welcome; see [Contributing](CONTRIBUTING.md).
