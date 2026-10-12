# Recovery and privacy

No recovery action dispatches implementation or replays tool calls. Inspect actual files and external effects before retrying uncertain work.

## Interrupted implementation

Resume the original Pi session. The plan restores **paused**, with recorded progress/evidence but no authority. Read `/plan status`, inspect the workspace, then use `/plan implement` if the revision and evidence remain valid. Relevant drift requires `/plan revise` and genuine reinspection before a replacement revision is submitted. Unknown external effects are not made safe by saved progress. A declared material redesign also preserves its reason through restoration and requires a replacement submission; it cannot resume against the old revision. Use `/plan revise` to rework it before requesting approval again.

## Interrupted revision publication

A revision may have been durably saved before its session association was written. `/plan list` shows saved documents; `/plan history` shows all revisions of an active plan. Selecting one creates an unapproved association and does not rewrite its parent/content.

A normal writer releases its lock. If publication was interrupted:

- `/plan recover` checks the active plan's writer reservation.
- A live or permission-indeterminate PID is treated as active; recovery is refused.
- A confirmed dead writer's lock is archived, not deleted. Revisions remain unchanged.
- An incomplete/malformed lock requires manual inspection with **all writers stopped**. Never remove a lock merely because it looks old.
- Temporary files and archived locks are not revisions and are not executed.

## Corrupt association or artifact

A schema, workspace, identity, or integrity mismatch puts the association into fail-closed recovery. `/plan recover` can explicitly detach a corrupt association while preserving artifacts and tree history. Repair invalid configuration separately and reload Pi. Do not edit a saved revision's JSON and then reuse its old identity; create a new revision from inspected content.

If a corrupt latest artifact blocks the browser, stop Planroom sessions, preserve a backup, and move the affected plan directory out of the active store for manual inspection. Other session branches still refer to their original identities; do not make those references appear valid by fabricating replacement files.

## Handoff uncertainty

Fresh-session setup and execution are different actions. Declining destination approval leaves a durable, linked review session. If the source reports a handoff error, inspect the session browser and destination before trying again. No automatic fallback to the source, model, or alternate execution path occurs.

## Workspace moves and exports

Workspace identity is canonical and absolute. Moving a repository or selecting a plan from another workspace does not transfer authority. A Markdown export is a plain document: it has no reusable approval token. In the destination workspace, read/import its contents into a new planning request, reinspect local facts, and submit a new revision.

Export requires explicit confirmation and a new `.md` path inside the workspace with an existing parent directory. It never overwrites a file, follows a symlink, or creates arbitrary parent directories.

## Sensitive data

Planroom's new artifact directories/files use 0700/0600. Existing shared Planroom directories are rejected rather than silently chmodded. Planroom does not encrypt, sync, or publish artifacts. Ordinary Pi session storage follows Pi's own behavior; Planroom does not change its permissions.

Plans, decisions, evidence paths, reviewer responses, and ordinary session logs may contain sensitive project data. Known credential-path rejection is a heuristic, not proof that a read/document is secret-free. Independent critique sends the displayed categories to the explicitly chosen provider; decline it if your data policy forbids that route.

Archive or remove private artifacts only after stopping writers and considering session references. Package removal does not delete plans or sessions. There is no background cleanup that could destroy recovery evidence.
