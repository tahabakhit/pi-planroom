# Configuration

Planroom has no model/provider defaults and no required configuration. It does not write configuration files.

User settings are read from `<Pi agent directory>/pi-planroom.json`. A trusted project's `.pi/pi-planroom.json` can override **review limits only**. Untrusted project configuration is ignored. Unknown settings, malformed files, unsupported shell syntax, and project permission widening fail closed for Planroom operations.

```json
{
  "allowedTools": [],
  "inspectionCommands": [],
  "readRoots": [],
  "shortcut": null,
  "reviewerTimeoutMs": 120000,
  "reviewerMaxTokens": 4096
}
```

| Setting | Meaning |
| --- | --- |
| `allowedTools` | Exact additional tool names you have independently audited for planning. An annotation claiming read-only access is not proof. An admitted tool executes its own implementation; every nested host-mediated call is still gated. |
| `inspectionCommands` | Exact command argument arrays, expressed through the restricted literal shell grammar. This explicitly authorizes executing those commands in trusted projects. Tests/builds are not admitted by default and can have side effects. |
| `readRoots` | Explicit absolute additional read roots. Credential-path and symlink checks still apply. No environment expansion or implicit sibling access. |
| `shortcut` | `null` or an unbound `f6`–`f12`. Loaded at extension initialization; restart after changes. A key already named in user keybindings is not registered. Pi's conflict handling also applies. During an active run it stages `/plan` in the editor rather than interrupting silently. |
| `reviewerTimeoutMs` | 1,000–600,000 ms; default 120,000. Cancellation is best effort and cannot retract a dispatched provider request. |
| `reviewerMaxTokens` | 256–8,192; default 4,096. A provider output limit, not a hard financial cap. |

Each permission list is bounded to 40 entries. Reserved editing, progress, PowerShell, and codemode tools cannot be admitted by name. `bash` cannot be broadly admitted; use exact reviewed commands instead.

For example, if you have deliberately reviewed the project's test script and want it available during planning:

```json
{
  "inspectionCommands": ["npm test"]
}
```

This does **not** make tests pure or sandboxed. It authorizes that exact invocation, and only when Pi trusts the project. Argument boundaries matter: quoting two words as one argument is not interchangeable with passing two arguments.

## Default planning policy

- Native `read`, `find`, and `ls` within the workspace/admitted roots.
- Native `grep` on an explicit vetted regular file. Directory content searches are denied because native grep searches hidden files and could read unignored credentials; discover paths first.
- `plan_question`, `plan_submit`, and `plan_read`.
- Restricted Bash inspection: simple `pwd`, `whoami`, `hostname`, selected `uname`/`ls`/`wc`/`head`/`tail`, and selected read-only `git status`, `diff`, `log`, `show`, and `rev-parse` forms.
- Unknown tools, editing, PowerShell, codemode, and unreviewed commands are denied.

The shell grammar deliberately excludes composition, substitutions, redirection, expansions, arbitrary flags, and general shell programs. Git inspection disables optional locks, filesystem-monitor hooks, pagers, external diff, and text conversion. This reduces side effects; it does not make an executable, repository, environment, or filesystem adversary safe.

Known credential paths such as `.env*`, `auth.json`, `.npmrc`, `.ssh`, and `.aws` are rejected. The heuristic is not a data-loss-prevention classifier: secrets can exist under ordinary filenames or in Git history. Do not put secrets in plans or reviewer requests.

## Models and thinking

Planning inherits your current session choices. At implementation approval you may keep them or explicitly select another available/scoped model and supported thinking level. Changes are session-only. Independent critique always asks you to choose a model; unavailable or malformed review results never select a fallback or approve anything.

Settings reload on session initialization/tree restoration. Repair invalid settings, then reload Pi. A configuration error does not disable normal Pi while Planroom is idle, but an active planning association remains gated.
